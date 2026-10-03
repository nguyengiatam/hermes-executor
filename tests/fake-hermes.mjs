#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('Fake Hermes 1.0'); process.exit(0); }
if (args.includes('--help')) { console.log('--query-file --format stream-json --in --oneshot --cli --yolo'); process.exit(0); }
const value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
const task = readFileSync(value('--query-file'), 'utf8');
const emit = data => console.log(JSON.stringify(data));
emit({ type: 'system', subtype: 'init', session_id: 'test-session', model: 'fake' });
if (task === 'hang') {
  process.on('SIGTERM', () => {});
  const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  writeFileSync(value('--query-file') + '.child-pid', String(descendant.pid));
  setInterval(() => {}, 1000);
} else if (task === 'partial') {
  emit({ type: 'text', text: 'partial answer' });
} else if (task === 'bad-exit') {
  emit({ type: 'result', session_id: 'test-session', exit_code: 0, text: 'looks successful' });
  process.exitCode = 7;
} else if (task === 'failed') {
  emit({ type: 'result', session_id: 'test-session', exit_code: 1, text: '', error: 'provider failed' });
  process.exitCode = 1;
} else {
  emit({ type: 'text', text: 'streamed intermediate text' });
  emit({ type: 'tool_result', name: 'test', is_error: true });
  emit({ type: 'result', session_id: value('--resume') || 'test-session', exit_code: 0, text: task, tokens: { total: 42 }, args, cwd: process.cwd() });
}
