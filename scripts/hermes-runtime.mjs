#!/usr/bin/env node
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, renameSync, openSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const runtime = fileURLToPath(import.meta.url);
const bin = process.env.HERMES_BIN || 'hermes';
function read(path) { return existsSync(path) ? readFileSync(path, 'utf8') : ''; }
function json(path) { return JSON.parse(readFileSync(path, 'utf8')); }
function save(path, value) {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}
function scope() {
  let root;
  try { root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { root = process.cwd(); }
  const hash = createHash('sha256').update(root).digest('hex').slice(0, 16);
  const dir = join(resolve(process.env.HERMES_EXECUTOR_HOME || join(homedir(), '.hermes-executor')), hash, 'jobs');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return { root, dir };
}
function alive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } }
function events(job) {
  return read(job.outputPath).split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
}
function jobs(dir) {
  return readdirSync(dir).filter(name => existsSync(join(dir, name, 'job.json')))
    .map(name => {
      const path = join(dir, name, 'job.json');
      const job = json(path);
      const ev = events(job);
      job.sessionID = ev.findLast(e => e.session_id)?.session_id || job.sessionID;
      if (job.status === 'running' && !alive(job.pid)) {
        job.status = 'incomplete';
        job.error = 'Runtime supervisor stopped before recording completion.';
      }
      return job;
    }).sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.jobId.localeCompare(a.jobId));
}
function timeout(value) {
  const m = /^(\d+(?:\.\d+)?)([smh])$/.exec(value);
  const ms = m && Number(m[1]) * { s: 1000, m: 60000, h: 3600000 }[m[2]];
  if (!ms || !Number.isFinite(ms) || ms > 2147483647) throw new Error('Invalid timeout. Use a positive duration such as 90s, 30m or 2h (maximum 24 days).');
  return ms;
}
function parse(args) {
  const o = { background: true, timeout: '85m', task: [] };
  const valued = new Set(['--model', '--provider', '--toolsets', '--reasoning', '--timeout', '--session', '--task-file']);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { o.task.push(...args.slice(i + 1)); break; }
    if (valued.has(a)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${a}.`);
      o[a.slice(2)] = args[++i];
    } else if (a === '--wait') o.background = false;
    else if (a === '--background') o.background = true;
    else if (a === '--resume') o.resume = true;
    else if (a === '--fresh') o.fresh = true;
    else if (a.startsWith('--')) throw new Error(`Unknown option ${a}. Put task text after --.`);
    else o.task.push(a);
  }
  if (o.fresh && (o.resume || o.session)) throw new Error('--fresh cannot be combined with --resume or --session.');
  if (o['task-file'] && o.task.length) throw new Error('Use either --task-file or task text.');
  o.task = o['task-file'] ? readFileSync(resolve(o['task-file']), 'utf8') : o.task.join(' ');
  if (!o.task.trim()) throw new Error('No task provided. Usage: exec [options] -- <task>');
  o.timeoutMs = timeout(o.timeout);
  return o;
}
function hermesArgs(job) {
  const args = ['chat', '--cli', '--oneshot', '--format', 'stream-json', '--yolo', '--in', job.root, '--query-file', job.promptPath];
  if (job.resumeSessionID) args.push('--resume', job.resumeSessionID);
  for (const name of ['model', 'provider', 'toolsets', 'reasoning']) if (job[name]) args.push(`--${name}`, job[name]);
  return args;
}
function stop(pid, signal = 'SIGTERM') {
  if (!pid) return;
  try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch {} }
}
async function worker(path) {
  const job = json(path);
  const jobDir = dirname(path);
  const cancelPath = join(jobDir, 'cancel');
  job.pid = process.pid;
  save(path, job);
  const out = openSync(job.outputPath, 'a', 0o600);
  const err = openSync(job.stderrPath, 'a', 0o600);
  const child = spawn(bin, hermesArgs(job), { cwd: job.root, detached: true, stdio: ['ignore', out, err] });
  closeSync(out); closeSync(err);
  let reason = null, killTimer = null, spawnError = null;
  function terminate(status) {
    if (reason) return;
    reason = status;
    stop(child.pid);
    killTimer = setTimeout(() => stop(child.pid, 'SIGKILL'), 1500);
  }
  process.on('SIGTERM', () => terminate('cancelled'));
  process.on('SIGINT', () => terminate('cancelled'));
  child.on('error', error => { spawnError = error.message; });
  const deadline = setTimeout(() => terminate('timeout'), job.timeoutMs);
  const cancelPoll = setInterval(() => { if (existsSync(cancelPath)) terminate('cancelled'); }, 100);
  const exit = await new Promise(done => child.on('close', (code, signal) => done({ code, signal })));
  clearTimeout(deadline); clearInterval(cancelPoll);
  // Kill remaining tool descendants before publishing a terminal timeout/cancel status.
  if (reason) stop(child.pid, 'SIGKILL');
  clearTimeout(killTimer);
  const ev = events(job), result = ev.findLast(e => e.type === 'result');
  job.sessionID = ev.findLast(e => e.session_id)?.session_id || job.sessionID;
  job.exitCode = exit.code;
  job.signal = exit.signal;
  job.finishedAt = new Date().toISOString();
  job.error = spawnError || result?.error || null;
  job.status = reason || (spawnError || exit.code !== 0 || result?.error || (result && result.exit_code !== 0) ? 'failed' : result ? 'finished' : ev.length ? 'incomplete' : 'empty');
  if (job.status === 'failed' && !job.error) job.error = `Hermes exited with ${exit.code ?? exit.signal}.`;
  save(path, job);
  return job;
}
function report(job, raw = false) {
  if (raw) { process.stdout.write(read(job.outputPath)); return; }
  console.log(`Job ${job.jobId}\nStatus: ${job.status}\nSessionID: ${job.sessionID || '-'}\nModel: ${job.model || '(Hermes default)'}`);
  const ev = events(job), result = ev.findLast(e => e.type === 'result');
  const tools = ev.filter(e => e.type === 'tool_use');
  if (tools.length) console.log(`Tools used: ${tools.map(e => e.name).join(', ')}`);
  console.log('Final answer:');
  console.log(result?.text ?? ev.filter(e => e.type === 'text').map(e => e.text || '').join(''));
  if (result?.tokens) console.log(`Tokens: ${JSON.stringify(result.tokens)}`);
  if (job.error) console.log(`Error: ${job.error}`);
  const stderr = read(job.stderrPath).trim().split('\n').slice(-20).join('\n');
  if (stderr) console.log(`Stderr (last 20 lines):\n${stderr}`);
}
async function dispatch(args) {
  const o = parse(args), { root, dir } = scope();
  const previous = jobs(dir);
  const sessionID = o.session || (o.resume ? previous.find(j => j.sessionID)?.sessionID : null);
  if (o.resume && !sessionID) throw new Error('No resumable Hermes job in this repository.');
  if (sessionID && previous.some(j => j.status === 'running' && j.sessionID === sessionID)) throw new Error('That session already has a running job.');
  const jobId = `${Date.now()}-${randomUUID().slice(0, 8)}`, jobDir = join(dir, jobId);
  mkdirSync(jobDir, { mode: 0o700 });
  const path = join(jobDir, 'job.json');
  const job = { jobId, root, pid: null, status: 'running', startedAt: new Date().toISOString(), mode: o.background ? 'background' : 'wait', task: o.task.split('\n')[0].slice(0, 100), timeoutMs: o.timeoutMs, resumeSessionID: sessionID, sessionID, model: o.model || null, provider: o.provider || null, toolsets: o.toolsets || null, reasoning: o.reasoning || null, promptPath: join(jobDir, 'prompt.md'), outputPath: join(jobDir, 'output.jsonl'), stderrPath: join(jobDir, 'stderr.log') };
  writeFileSync(job.promptPath, o.task, { mode: 0o600 });
  if (!o.background) {
    save(path, job);
    const finished = await worker(path);
    report(finished);
    if (finished.status !== 'finished') process.exitCode = 1;
    return;
  }
  // Initialize metadata before spawning; only the worker writes metadata thereafter.
  save(path, job);
  const fd = openSync(join(jobDir, 'supervisor.log'), 'a', 0o600);
  const child = spawn(process.execPath, [runtime, '_worker', path], { cwd: root, detached: true, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  await new Promise((done, reject) => { child.once('spawn', done); child.once('error', reject); });
  // Wait for startup acknowledgement so an immediate status call sees the supervisor PID.
  for (let i = 0; i < 100 && !json(path).pid && alive(child.pid); i++) await new Promise(done => setTimeout(done, 10));
  child.unref();
  console.log(`Dispatched Hermes job ${jobId} (pid ${child.pid}) in the background.\nTask: ${job.task}\nPoll: /hermes-executor:status ${jobId}\nResult: /hermes-executor:result ${jobId}\nCancel: /hermes-executor:cancel ${jobId}`);
}
function setup(args) {
  const v = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 15000 });
  const h = v.status === 0 ? spawnSync(bin, ['chat', '--help'], { encoding: 'utf8', timeout: 15000 }) : null;
  const installed = v.status === 0;
  const compatible = installed && h?.status === 0 && ['--query-file', 'stream-json', '--in', '--oneshot', '--cli', '--yolo'].every(flag => h.stdout.includes(flag));
  const info = { hermesBin: bin, installed, compatible, version: (v.stdout || v.stderr || '').trim(), error: v.error?.message || (h?.error?.message) || null };
  console.log(args.includes('--json') ? JSON.stringify(info, null, 2) : `Hermes: ${bin}\nInstalled: ${installed}\nCompatible: ${compatible}\nVersion: ${info.version || '-'}\n${info.error || ''}`);
  if (!compatible) process.exitCode = 1;
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === '_worker') { await worker(args[0]); return; }
  if (command === 'exec') { await dispatch(args); return; }
  if (command === 'setup') { setup(args); return; }
  if (!['status', 'result', 'cancel', 'resume-candidate'].includes(command)) {
    console.log('Usage: hermes-runtime.mjs <exec|status|result|cancel|setup|resume-candidate> [options]');
    process.exitCode = command ? 1 : 0; return;
  }
  const { dir } = scope(), list = jobs(dir);
  if (command === 'resume-candidate') {
    const j = list.find(j => j.sessionID);
    console.log(JSON.stringify({ available: !!j, jobId: j?.jobId || null, sessionID: j?.sessionID || null })); return;
  }
  const id = args.find(a => !a.startsWith('--'));
  if (command === 'status' && !id) {
    console.log('| job id | status | mode | task |\n|---|---|---|---|');
    for (const j of list.slice(0, 15)) console.log(`| ${j.jobId} | ${j.status} | ${j.mode} | ${j.task.replaceAll('|', '\\|')} |`);
    return;
  }
  const j = id ? list.find(j => j.jobId === id) : command === 'cancel' ? list.find(j => j.status === 'running') : list[0];
  if (!j) throw new Error(id ? `No job ${id} in this repository.` : 'No matching jobs in this repository.');
  if (command === 'cancel') {
    if (j.status !== 'running') { console.log(`Job ${j.jobId} is ${j.status}.`); return; }
    writeFileSync(join(dirname(j.promptPath), 'cancel'), '', { mode: 0o600 });
    console.log(`Cancellation requested for job ${j.jobId}.`); return;
  }
  if (command === 'result') report(j, args.includes('--raw'));
  else {
    console.log(JSON.stringify(j, null, 2));
    console.log('Recent events:');
    for (const e of events(j).slice(-10)) console.log(JSON.stringify(e));
  }
}
main().catch(error => { console.error(`Error: ${error.message}`); process.exitCode = 1; });
