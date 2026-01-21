import test from 'node:test';
import assert from 'node:assert/strict';
import { runSuite, TOOL_ID, LIMITS } from '../src/index.mjs';

const good = () => ({
  suite: { schemaVersion: '1', cases: [{ command: 'print-ok', timeoutMs: 1000, expected: { exitCode: 0, stdout: 'fixture-ok\n' } }] },
  capture: { schemaVersion: '1', complete: true, results: [{ command: 'print-ok', termination: 'exit', exitCode: 0, stdout: 'fixture-ok\n', stderr: '', elapsedMs: 10 }] }
});
const rules = report => report.findings.map(f => f.ruleId);

test('complete exported result for allowlisted synthetic command passes without execution', async () => {
  const result = await runSuite(good());
  assert.equal(TOOL_ID, 'example-command-smoke-test');
  assert.equal(result.status, 'pass');
  assert.deepEqual(result.summary, { checked: 1, errors: 0, warnings: 0 });
});
test('unknown command refuses all cases before comparison, without echoing its name', async () => {
  const input = good(); input.suite.cases.push({ command: 'shell-danger', timeoutMs: 100, expected: { exitCode: 0, stdout: '' } });
  input.capture.results.push({ command: 'shell-danger', termination: 'exit', exitCode: 0, stdout: '', stderr: '', elapsedMs: 1 });
  const result = await runSuite(input);
  assert.equal(result.status, 'fail');
  assert.deepEqual(rules(result), ['command-not-allowed']);
  assert.equal(result.summary.checked, 0);
  assert.ok(!JSON.stringify(result).includes('shell-danger'));
});
test('explicit captured timeout fails with bounded numeric evidence, signal is not timeout', async () => {
  const input = good(); input.suite.cases[0].timeoutMs = 30;
  input.capture.results[0] = { command: 'print-ok', termination: 'timeout', elapsedMs: 30 };
  const result = await runSuite(input);
  assert.equal(result.status, 'fail');
  assert.deepEqual(rules(result), ['command-timeout']);
  assert.equal(result.findings[0].evidence, 'timeoutMs=30;elapsedMs=30');
  input.capture.results[0] = { command: 'print-ok', termination: 'signal', elapsedMs: 30 };
  assert.equal((await runSuite(input)).status, 'incomplete');
  assert.deepEqual(rules(await runSuite(input)), ['execution-unavailable']);
});
test('captured exit, stdout and stderr mismatch fail without output values', async () => {
  const input = good();
  input.capture.results[0] = { command: 'print-ok', termination: 'exit', exitCode: 7, stdout: 'private-observed', stderr: 'private-error', elapsedMs: 1 };
  const result = await runSuite(input);
  assert.equal(result.status, 'fail');
  assert.deepEqual(rules(result), ['exit-mismatch', 'stderr-mismatch', 'stdout-mismatch']);
  assert.ok(!JSON.stringify(result).includes('private'));
});
test('partial capture, absent results and mismatched identity never pass', async () => {
  const input = good(); input.capture.complete = false;
  assert.deepEqual(rules(await runSuite(input)), ['capture-incomplete']);
  input.capture.complete = true; input.capture.results = [];
  assert.deepEqual(rules(await runSuite(input)), ['capture-invalid']);
  input.capture.results = [{ command: 'exit-seven', termination: 'exit', exitCode: 0, stdout: '', stderr: '', elapsedMs: 1 }];
  assert.deepEqual(rules(await runSuite(input)), ['capture-invalid']);
});
test('unknown capture fields and elapsed timeout boundary cannot silently pass', async () => {
  const input = good(); input.capture.results[0].complete = false;
  assert.deepEqual(rules(await runSuite(input)), ['capture-invalid']);
  delete input.capture.results[0].complete;
  input.capture.results[0].elapsedMs = input.suite.cases[0].timeoutMs;
  assert.equal((await runSuite(input)).status, 'pass');
  input.capture.results[0].elapsedMs++;
  assert.deepEqual(rules(await runSuite(input)), ['command-timeout']);
  input.capture.results[0].elapsedMs = LIMITS.milliseconds;
  assert.deepEqual(rules(await runSuite(input)), ['command-timeout']);
  input.capture.results[0].elapsedMs++;
  assert.deepEqual(rules(await runSuite(input)), ['capture-invalid']);
});
test('captured output and expected output bounds accept N, refuse N+1', async () => {
  const input = good(); input.suite.cases[0].expected.stdout = 'x'.repeat(LIMITS.outputBytes);
  input.capture.results[0].stdout = 'x'.repeat(LIMITS.outputBytes);
  assert.equal((await runSuite(input)).status, 'pass');
  input.capture.results[0].stdout += 'x';
  assert.deepEqual(rules(await runSuite(input)), ['output-limit']);
  input.capture.results[0].stdout = 'x'.repeat(LIMITS.outputBytes);
  input.suite.cases[0].expected.stdout += 'x';
  assert.deepEqual(rules(await runSuite(input)), ['expectation-limit']);
});
test('case, depth, timeout and evaluation time bounds accept N and reject N+1', async () => {
  const input = good();
  input.suite.cases = Array.from({ length: LIMITS.cases }, () => structuredClone(input.suite.cases[0]));
  input.capture.results = Array.from({ length: LIMITS.cases }, () => structuredClone(input.capture.results[0]));
  assert.equal((await runSuite(input)).status, 'pass');
  input.suite.cases.push(structuredClone(input.suite.cases[0]));
  assert.deepEqual(rules(await runSuite(input)), ['record-limit']);
  const timeout = good(); timeout.suite.cases[0].timeoutMs = LIMITS.timeoutMs + 1;
  assert.deepEqual(rules(await runSuite(timeout)), ['timeout-invalid']);
  const nested = good(); assert.equal((await runSuite(nested)).status, 'pass');
  nested.capture.results[0].extra = { nested: { tooDeep: true } };
  assert.deepEqual(rules(await runSuite(nested)), ['depth-limit']);
  const exact = [0, LIMITS.milliseconds];
  assert.equal((await runSuite(good(), { now: () => exact.shift() ?? LIMITS.milliseconds })).status, 'pass');
  const late = [0, LIMITS.milliseconds + 1];
  assert.deepEqual(rules(await runSuite(good(), { now: () => late.shift() ?? LIMITS.milliseconds + 1 })), ['time-limit']);
});
test('case 10 sorts before case 2 by code unit', async () => {
  const input = good();
  input.suite.cases = Array.from({ length: 11 }, () => structuredClone(input.suite.cases[0]));
  input.capture.results = Array.from({ length: 11 }, (_, i) => ({ ...input.capture.results[0], stdout: i === 2 || i === 10 ? 'different' : 'fixture-ok\n' }));
  const result = await runSuite(input);
  assert.deepEqual(result.findings.map(f => f.location.pointer), ['/cases/10/expected/stdout', '/cases/2/expected/stdout']);
});
