export const TOOL_ID = 'example-command-smoke-test';
export const LIMITS = Object.freeze({ bytes: 1_048_576, cases: 12, depth: 4, outputBytes: 4096, timeoutMs: 1000, milliseconds: 10_000 });
export const RULE_SEVERITY = Object.freeze({
  'input-unreadable': 'error', 'input-invalid': 'error', 'byte-limit': 'error', 'depth-limit': 'error',
  'record-limit': 'error', 'case-invalid': 'error', 'timeout-invalid': 'error', 'expectation-limit': 'error',
  'time-limit': 'error', 'execution-unavailable': 'error', 'output-limit': 'error',
  'capture-invalid': 'error', 'capture-incomplete': 'error',
  'command-not-allowed': 'error', 'command-timeout': 'error', 'stdout-mismatch': 'error',
  'stderr-mismatch': 'error', 'exit-mismatch': 'error'
});
const INCOMPLETE = new Set(['input-unreadable', 'input-invalid', 'byte-limit', 'depth-limit', 'record-limit', 'case-invalid', 'timeout-invalid', 'expectation-limit', 'time-limit', 'execution-unavailable', 'output-limit', 'capture-invalid', 'capture-incomplete']);
const COMMANDS = new Set(['print-ok', 'print-max', 'print-overflow', 'wait-250', 'exit-seven', 'print-env']);
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
export async function runSuite(input, { now = () => performance.now() } = {}) {
  const started = now();
  if (!object(input) || !object(input.suite) || !object(input.capture)) return incomplete('input-invalid', 'Suite and capture exports are required.');
  const { suite, capture } = input;
  if (Buffer.byteLength(JSON.stringify(suite)) > LIMITS.bytes || Buffer.byteLength(JSON.stringify(capture)) > LIMITS.bytes) return incomplete('byte-limit', 'An evidence document exceeds 1048576 bytes.');
  if (suite.schemaVersion !== '1' || !Array.isArray(suite.cases) || suite.cases.length === 0 || Object.keys(suite).some(key => !['schemaVersion', 'cases'].includes(key))) return incomplete('input-invalid', 'A version 1 suite with nonempty cases is required.');
  if (tooDeep(suite) || tooDeep(capture)) return incomplete('depth-limit', 'Evidence exceeds nesting depth 4.');
  if (suite.cases.length > LIMITS.cases || (Array.isArray(capture.results) && capture.results.length > LIMITS.cases)) return incomplete('record-limit', 'Evidence exceeds 12 cases.');
  const findings = [];
  for (const [i, item] of suite.cases.entries()) {
    const invalid = validateCase(item);
    if (invalid) finding(findings, invalid, `/cases/${i}`, 'Case or expected output has invalid or unsupported fields.');
    else if (!COMMANDS.has(item.command)) finding(findings, 'command-not-allowed', `/cases/${i}/command`, 'Command is not in the fixed allowlist.');
  }
  if (findings.length) return report(findings, 0);
  if (capture.schemaVersion !== '1' || !Array.isArray(capture.results) || Object.keys(capture).some(key => !['schemaVersion', 'complete', 'results'].includes(key))) return incomplete('capture-invalid', 'Capture shape is invalid.');
  if (capture.complete !== true) return incomplete('capture-incomplete', 'Capture is not complete.');
  if (capture.results.length !== suite.cases.length) return incomplete('capture-invalid', 'Capture does not match the case count.');
  for (const [i, observed] of capture.results.entries()) {
    if (!object(observed) || observed.command !== suite.cases[i].command || !['exit', 'timeout', 'signal', 'unknown'].includes(observed.termination) || !Number.isInteger(observed.elapsedMs) || observed.elapsedMs < 0 || observed.elapsedMs > LIMITS.milliseconds) return incomplete('capture-invalid', 'Capture result is invalid.');
    const allowed = observed.termination === 'exit' ? ['command', 'termination', 'elapsedMs', 'exitCode', 'stdout', 'stderr'] : ['command', 'termination', 'elapsedMs'];
    if (Object.keys(observed).some(key => !allowed.includes(key))) return incomplete('capture-invalid', 'Capture result has unsupported fields.');
    if (observed.termination === 'exit' && (!Number.isInteger(observed.exitCode) || observed.exitCode < 0 || observed.exitCode > 255 || typeof observed.stdout !== 'string' || typeof observed.stderr !== 'string')) return incomplete('capture-invalid', 'Captured exit result is invalid.');
    if (observed.termination !== 'exit' && ['exitCode', 'stdout', 'stderr'].some(key => Object.hasOwn(observed, key))) return incomplete('capture-invalid', 'Non-exit capture has unsupported output.');
  }
  let checked = 0;
  for (const [i, item] of suite.cases.entries()) {
    if (now() - started > LIMITS.milliseconds) return incomplete('time-limit', 'Suite evaluation exceeded 10000 milliseconds.');
    const observed = capture.results[i];
    checked++;
    if (observed.termination === 'timeout' || observed.termination === 'exit' && observed.elapsedMs > item.timeoutMs) finding(findings, 'command-timeout', `/cases/${i}/timeoutMs`, 'Captured command reached its timeout.', `timeoutMs=${item.timeoutMs};elapsedMs=${observed.elapsedMs}`);
    else if (observed.termination !== 'exit') finding(findings, 'execution-unavailable', `/cases/${i}`, 'Captured command did not produce an exit result.');
    else if (Buffer.byteLength(observed.stdout) > LIMITS.outputBytes || Buffer.byteLength(observed.stderr) > LIMITS.outputBytes) finding(findings, 'output-limit', `/cases/${i}`, 'Captured output exceeds 4096 bytes.');
    else {
      if (observed.exitCode !== item.expected.exitCode) finding(findings, 'exit-mismatch', `/cases/${i}/expected/exitCode`, 'Child exit code does not match expectation.');
      if (observed.stdout !== item.expected.stdout) finding(findings, 'stdout-mismatch', `/cases/${i}/expected/stdout`, 'Child stdout does not match expectation.');
      if (observed.stderr !== (item.expected.stderr ?? '')) finding(findings, 'stderr-mismatch', `/cases/${i}/expected/stderr`, 'Child stderr does not match expectation.');
    }
  }
  if (now() - started > LIMITS.milliseconds) return incomplete('time-limit', 'Suite evaluation exceeded 10000 milliseconds.');
  return report(findings, checked);
}
