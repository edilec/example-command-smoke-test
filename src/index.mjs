import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const TOOL_ID = 'example-command-smoke-test';
export const LIMITS = Object.freeze({ bytes: 1_048_576, cases: 12, depth: 4, outputBytes: 4096, timeoutMs: 1000, milliseconds: 10_000 });
export const RULE_SEVERITY = Object.freeze({
  'input-unreadable': 'error', 'input-invalid': 'error', 'byte-limit': 'error', 'depth-limit': 'error',
  'record-limit': 'error', 'case-invalid': 'error', 'timeout-invalid': 'error', 'expectation-limit': 'error',
  'time-limit': 'error', 'execution-unavailable': 'error', 'output-limit': 'error',
  'command-not-allowed': 'error', 'command-timeout': 'error', 'stdout-mismatch': 'error',
  'stderr-mismatch': 'error', 'exit-mismatch': 'error'
});
const INCOMPLETE = new Set(['input-unreadable', 'input-invalid', 'byte-limit', 'depth-limit', 'record-limit', 'case-invalid', 'timeout-invalid', 'expectation-limit', 'time-limit', 'execution-unavailable', 'output-limit']);
const FIXTURE_READ = 'import { readFileSync } from "node:fs"; const data = JSON.parse(readFileSync("fixture.json", "utf8"));';
const COMMANDS = Object.freeze({
  'print-ok': { fixture: { value: 'fixture-ok\n' }, code: `${FIXTURE_READ} process.stdout.write(data.value);` },
  'print-max': { fixture: { count: 4096 }, code: `${FIXTURE_READ} process.stdout.write('x'.repeat(data.count));` },
  'print-overflow': { fixture: { count: 4097 }, code: `${FIXTURE_READ} process.stdout.write('x'.repeat(data.count));` },
  'wait-250': { fixture: {}, code: 'setTimeout(() => process.stdout.write("done\\n"), 250);' },
  'exit-seven': { fixture: {}, code: 'process.exit(7);' },
  'print-env': { fixture: {}, code: 'process.stdout.write(process.env.SMOKE_SECRET === undefined ? "absent\\n" : "present\\n");' }
});
const exec = promisify(execFile);
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function tooDeep(input) {
  const stack = [[input, 0]];
  while (stack.length) {
    const [value, depth] = stack.pop();
    if (depth > LIMITS.depth) return true;
    if (value && typeof value === 'object') for (const child of Object.values(value)) stack.push([child, depth + 1]);
  }
  return false;
}
function finding(findings, ruleId, pointer, message, evidence) {
  if (!Object.hasOwn(RULE_SEVERITY, ruleId)) throw new Error('Unknown rule');
  const result = { ruleId, severity: RULE_SEVERITY[ruleId], message, location: { file: '@suite', pointer } };
  if (evidence !== undefined) result.evidence = evidence;
  findings.push(result);
}
function report(findings, checked) {
  findings.sort((a, b) => cmp(a.location.file, b.location.file) || cmp(a.location.pointer, b.location.pointer) || cmp(a.ruleId, b.ruleId));
  const status = findings.some(f => INCOMPLETE.has(f.ruleId)) ? 'incomplete' : findings.some(f => f.severity === 'error') ? 'fail' : 'pass';
  return { schemaVersion: '1', tool: TOOL_ID, status, summary: { checked, errors: findings.filter(f => f.severity === 'error').length, warnings: 0 }, findings };
}
export function incomplete(ruleId, message) {
  const findings = [];
  finding(findings, ruleId, '', message);
  return report(findings, 0);
}
function validateCase(value) {
  if (!object(value) || Object.keys(value).some(key => !['id', 'command', 'timeoutMs', 'expected'].includes(key)) || (value.id !== undefined && (typeof value.id !== 'string' || value.id.trim() === '')) || typeof value.command !== 'string' || !object(value.expected)) return 'case-invalid';
  if (Object.keys(value.expected).some(key => !['exitCode', 'stdout', 'stderr'].includes(key)) || !Number.isInteger(value.expected.exitCode) || value.expected.exitCode < 0 || value.expected.exitCode > 255 || typeof value.expected.stdout !== 'string' || (value.expected.stderr !== undefined && typeof value.expected.stderr !== 'string')) return 'case-invalid';
  if (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > LIMITS.timeoutMs) return 'timeout-invalid';
  if (Buffer.byteLength(value.expected.stdout) > LIMITS.outputBytes || Buffer.byteLength(value.expected.stderr ?? '') > LIMITS.outputBytes) return 'expectation-limit';
  return null;
}
async function execute(command, timeoutMs) {
  const fixture = await mkdtemp(join(tmpdir(), 'example-smoke-'));
  try {
    await writeFile(join(fixture, 'fixture.json'), JSON.stringify(command.fixture), { mode: 0o600 });
    try {
      const result = await exec(process.execPath, ['--input-type=module', '--eval', command.code], {
        cwd: fixture, env: { LANG: 'C', TZ: 'UTC', HOME: fixture, TMPDIR: fixture, PATH: '' },
        timeout: timeoutMs, maxBuffer: LIMITS.outputBytes, shell: false, windowsHide: true
      });
      return { kind: 'done', exitCode: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return { kind: 'output-limit' };
      if (error.killed || error.code === 'ETIMEDOUT') return { kind: 'timeout' };
      if (Number.isInteger(error.code)) return { kind: 'done', exitCode: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
      return { kind: 'unavailable' };
    }
  } finally { await rm(fixture, { recursive: true, force: true }); }
}

export async function runSuite(input, { now = () => performance.now() } = {}) {
  const started = now();
  if (!object(input) || input.schemaVersion !== '1' || !Array.isArray(input.cases) || input.cases.length === 0 || Object.keys(input).some(key => !['schemaVersion', 'cases'].includes(key))) return incomplete('input-invalid', 'A version 1 suite with nonempty cases is required.');
  if (tooDeep(input)) return incomplete('depth-limit', 'Suite exceeds nesting depth 4.');
  if (input.cases.length > LIMITS.cases) return incomplete('record-limit', 'Suite exceeds 12 cases.');
  const findings = [];
  for (const [i, item] of input.cases.entries()) {
    const invalid = validateCase(item);
    if (invalid) finding(findings, invalid, `/cases/${i}`, 'Case or expected output has invalid or unsupported fields.');
    else if (!Object.hasOwn(COMMANDS, item.command)) finding(findings, 'command-not-allowed', `/cases/${i}/command`, 'Command is not in the fixed allowlist.');
  }
  if (findings.length) return report(findings, 0);
  let checked = 0;
  for (const [i, item] of input.cases.entries()) {
    if (now() - started > LIMITS.milliseconds) return incomplete('time-limit', 'Suite evaluation exceeded 10000 milliseconds.');
    let observed;
    try { observed = await execute(COMMANDS[item.command], item.timeoutMs); }
    catch { return incomplete('execution-unavailable', 'Disposable fixture or child execution failed.'); }
    checked++;
    if (observed.kind === 'timeout') finding(findings, 'command-timeout', `/cases/${i}/timeoutMs`, 'Allowlisted command exceeded its timeout.', `timeoutMs=${item.timeoutMs}`);
    else if (observed.kind === 'output-limit') finding(findings, 'output-limit', `/cases/${i}`, 'Child output exceeded 4096 bytes.');
    else if (observed.kind === 'unavailable') finding(findings, 'execution-unavailable', `/cases/${i}`, 'Child execution could not be evaluated.');
    else {
      if (observed.exitCode !== item.expected.exitCode) finding(findings, 'exit-mismatch', `/cases/${i}/expected/exitCode`, 'Child exit code does not match expectation.');
      if (observed.stdout !== item.expected.stdout) finding(findings, 'stdout-mismatch', `/cases/${i}/expected/stdout`, 'Child stdout does not match expectation.');
      if (observed.stderr !== (item.expected.stderr ?? '')) finding(findings, 'stderr-mismatch', `/cases/${i}/expected/stderr`, 'Child stderr does not match expectation.');
    }
  }
  if (now() - started > LIMITS.milliseconds) return incomplete('time-limit', 'Suite evaluation exceeded 10000 milliseconds.');
  return report(findings, checked);
}
