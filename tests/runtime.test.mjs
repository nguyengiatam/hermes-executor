import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, chmodSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const runtime = join(here, '../scripts/hermes-runtime.mjs');
const fake = join(here, 'fake-hermes.mjs');
chmodSync(fake, 0o755);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hermes-executor-test-'));
  const repo = join(root, 'repo'); mkdirSync(repo);
  const init = spawnSync('git', ['init', '-q', repo]); assert.equal(init.status, 0);
  const env = { ...process.env, HERMES_BIN: fake, HERMES_EXECUTOR_HOME: join(root, 'state') };
  function run(args, cwd = repo, overrides = {}) {
    return new Promise((done, reject) => {
      const child = spawn(process.execPath, [runtime, ...args], { cwd, env: { ...env, ...overrides } });
      let stdout = '', stderr = '';
      child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
      child.on('error', reject); child.on('close', code => done({ code, stdout, stderr }));
    });
  }
  function records() {
    if (!existsSync(env.HERMES_EXECUTOR_HOME)) return [];
    return readdirSync(env.HERMES_EXECUTOR_HOME).flatMap(hash => readdirSync(join(env.HERMES_EXECUTOR_HOME, hash, 'jobs')).map(id => JSON.parse(readFileSync(join(env.HERMES_EXECUTOR_HOME, hash, 'jobs', id, 'job.json'), 'utf8'))));
  }
  return { root, repo, env, run, records };
}
async function waitJob(f, id, condition = j => j.status !== 'running') {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    const j = f.records().find(j => j.jobId === id);
    if (j && condition(j)) return j;
    await new Promise(done => setTimeout(done, 30));
  }
  assert.fail('Job did not reach expected state');
}
function jobID(output) { return /Dispatched Hermes job ([0-9a-f-]+)/.exec(output)?.[1]; }

test('setup checks executable compatibility without creating jobs', async () => {
  const f = fixture(), r = await f.run(['setup', '--json']);
  assert.equal(r.code, 0); assert.equal(JSON.parse(r.stdout).compatible, true); assert.deepEqual(f.records(), []);
});
test('task-file preserves shell syntax, multiline and Unicode; final result wins over deltas', async () => {
  const f = fixture(), path = join(f.root, 'task.md');
  const task = `Xin chào\n'quotes' \"double\" $(touch ${f.root}/INJECTED) \`whoami\` --fresh`;
  writeFileSync(path, task);
  const r = await f.run(['exec', '--wait', '--task-file', path, '--model', 'custom/model', '--provider', 'custom']);
  assert.equal(r.code, 0, r.stderr); assert.ok(r.stdout.includes(task)); assert.equal(existsSync(join(f.root, 'INJECTED')), false);
  const j = f.records()[0]; assert.equal(j.status, 'finished'); assert.equal(j.sessionID, 'test-session');
  assert.equal(readFileSync(j.promptPath, 'utf8'), task);
  const raw = await f.run(['result', j.jobId, '--raw']);
  const result = raw.stdout.trim().split('\n').map(JSON.parse).at(-1);
  assert.equal(result.cwd, realpathSync(f.repo)); assert.equal(result.text, task);
  assert.ok(result.args.includes('--yolo')); assert.ok(result.args.includes('custom/model'));
});
test('failure and missing terminal event are not reported as success', async () => {
  for (const [task, status] of [['failed', 'failed'], ['bad-exit', 'failed'], ['partial', 'incomplete']]) {
    const f = fixture(), r = await f.run(['exec', '--wait', '--', task]);
    assert.equal(r.code, 1); assert.equal(f.records()[0].status, status);
  }
});
test('missing executable becomes a failed job in foreground and background', async () => {
  for (const mode of ['--wait', '--background']) {
    const f = fixture(), r = await f.run(['exec', mode, '--', 'hello'], f.repo, { HERMES_BIN: join(f.root, 'missing') });
    const j = mode === '--wait' ? f.records()[0] : await waitJob(f, jobID(r.stdout));
    assert.equal(j.status, 'failed'); assert.match(j.error, /ENOENT/);
  }
});
test('background completion and concurrent dispatch retain separate jobs', async () => {
  const f = fixture();
  const results = await Promise.all([f.run(['exec', '--', 'first']), f.run(['exec', '--', 'second'])]);
  for (const r of results) { assert.equal(r.code, 0, r.stderr); assert.equal((await waitJob(f, jobID(r.stdout))).status, 'finished'); }
  assert.equal(f.records().length, 2);
});
test('timeout fires without polling and kills a stubborn process group', async () => {
  const f = fixture(), r = await f.run(['exec', '--timeout', '0.3s', '--', 'hang']);
  assert.equal(r.code, 0);
  const j = await waitJob(f, jobID(r.stdout)); assert.equal(j.status, 'timeout');
  assert.ok(existsSync(j.promptPath + '.child-pid'));
  const pid = Number(readFileSync(j.promptPath + '.child-pid', 'utf8'));
  const p = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  assert.ok(p.status !== 0 || p.stdout.trim().startsWith('Z'), `Descendant still running: ${p.stdout}`);
});
test('cancel marker terminates the job and keeps cancellation status', async () => {
  const f = fixture(), r = await f.run(['exec', '--timeout', '10s', '--', 'hang']), id = jobID(r.stdout);
  await waitJob(f, id, j => existsSync(j.promptPath + '.child-pid'));
  assert.equal((await f.run(['cancel', id])).code, 0);
  assert.equal((await waitJob(f, id)).status, 'cancelled');
  assert.match((await f.run(['result', id])).stdout, /Status: cancelled/);
});
test('resume is repository-scoped, works from subdirectories and rejects conflicting options', async () => {
  const f = fixture();
  assert.equal((await f.run(['exec', '--resume', '--', 'no prior'])).code, 1);
  assert.equal((await f.run(['exec', '--wait', '--', 'initial'])).code, 0);
  const sub = join(f.repo, 'sub'); mkdirSync(sub);
  assert.equal((await f.run(['exec', '--wait', '--resume', '--', 'continue'], sub)).code, 0);
  const jobs = f.records(), resumed = jobs.find(j => j.task === 'continue');
  assert.equal(resumed.resumeSessionID, 'test-session');
  const other = join(f.root, 'other'); mkdirSync(other);
  assert.equal((await f.run(['exec', '--resume', '--', 'wrong repo'], other)).code, 1);
  for (const options of [['--fresh', '--resume'], ['--timeout', '0s'], ['--model'], ['--unknown']]) {
    assert.equal((await f.run(['exec', ...options])).code, 1);
  }
});
