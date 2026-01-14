import test from 'node:test';
import assert from 'node:assert/strict';
import { runSuite, TOOL_ID, LIMITS } from '../src/index.mjs';

const good = () => ({ schemaVersion: '1', cases: [{ id: 'case-1', command: 'print-ok', timeoutMs: 1000, expected: { exitCode: 0, stdout: 'fixture-ok\n' } }] });

test('allowlisted example runs in a disposable fixture and matches expected output', async () => {
  const result = await runSuite(good());
  assert.equal(TOOL_ID, 'example-command-smoke-test');
  assert.equal(result.status, 'pass');
  assert.deepEqual(result.summary, { checked: 1, errors: 0, warnings: 0 });
  assert.deepEqual(result.findings, []);
});

const rules = report => report.findings.map(f => f.ruleId);

test('unknown command refuses the entire suite before any command executes', async () => {
  const input = good(); input.cases.push({ command: 'shell-danger', timeoutMs: 100, expected: { exitCode: 0, stdout: '' } });
  const result = await runSuite(input);
  assert.equal(result.status, 'fail');
  assert.deepEqual(rules(result), ['command-not-allowed']);
  assert.equal(result.summary.checked, 0);
  assert.ok(!JSON.stringify(result).includes('shell-danger'));
});

test('allowlisted wait command times out as a failure with bounded evidence', async () => {
  const input = { schemaVersion: '1', cases: [{ command: 'wait-250', timeoutMs: 30, expected: { exitCode: 0, stdout: '' } }] };
  const result = await runSuite(input);
  assert.equal(result.status, 'fail');
  assert.deepEqual(rules(result), ['command-timeout']);
  assert.equal(result.findings[0].evidence, 'timeoutMs=30');
});

test('stdout and exit expectations are checked without echoing output', async () => {
  const stdout = good(); stdout.cases[0].expected.stdout = 'secret-expected';
  const stdoutResult = await runSuite(stdout);
  assert.equal(stdoutResult.status, 'fail');
  assert.deepEqual(rules(stdoutResult), ['stdout-mismatch']);
  assert.ok(!JSON.stringify(stdoutResult).includes('secret-expected'));
  const exit = { schemaVersion: '1', cases: [{ command: 'exit-seven', timeoutMs: 1000, expected: { exitCode: 0, stdout: '' } }] };
  assert.equal((await runSuite(exit)).status, 'fail');
  assert.deepEqual(rules(await runSuite(exit)), ['exit-mismatch']);
});

test('child environment excludes ambient marker and executes no user arguments', async () => {
  const before = process.env.SMOKE_SECRET;
  process.env.SMOKE_SECRET = 'private-value';
  try {
    const input = { schemaVersion: '1', cases: [{ command: 'print-env', timeoutMs: 1000, expected: { exitCode: 0, stdout: 'absent\n' } }] };
    const result = await runSuite(input);
    assert.equal(result.status, 'pass');
    assert.ok(!JSON.stringify(result).includes('private-value'));
    input.cases[0].args = ['private-value'];
    const refused = await runSuite(input);
    assert.equal(refused.status, 'incomplete');
    assert.deepEqual(rules(refused), ['case-invalid']);
    assert.equal(refused.summary.checked, 0);
  } finally { if (before === undefined) delete process.env.SMOKE_SECRET; else process.env.SMOKE_SECRET = before; }
});

test('actual output bound accepts N and refuses N+1 without showing child output', async () => {
  const max = { schemaVersion: '1', cases: [{ command: 'print-max', timeoutMs: 1000, expected: { exitCode: 0, stdout: 'x'.repeat(LIMITS.outputBytes) } }] };
  assert.equal((await runSuite(max)).status, 'pass');
  const overflow = { schemaVersion: '1', cases: [{ command: 'print-overflow', timeoutMs: 1000, expected: { exitCode: 0, stdout: '' } }] };
  const result = await runSuite(overflow);
  assert.equal(result.status, 'incomplete');
  assert.deepEqual(rules(result), ['output-limit']);
  assert.ok(!JSON.stringify(result).includes('xxxx'));
  max.cases[0].expected.stdout += 'x';
  assert.deepEqual(rules(await runSuite(max)), ['expectation-limit']);
});

test('case, depth, timeout configuration and evaluation time bounds accept N and refuse N+1', async () => {
  const input = good(); input.cases = Array.from({ length: LIMITS.cases }, () => ({ command: 'print-ok', timeoutMs: LIMITS.timeoutMs, expected: { exitCode: 0, stdout: 'fixture-ok\n' } }));
  assert.equal((await runSuite(input)).status, 'pass');
  input.cases.push(input.cases[0]);
  assert.deepEqual(rules(await runSuite(input)), ['record-limit']);
  const deadline = good(); deadline.cases[0].timeoutMs = LIMITS.timeoutMs + 1;
  assert.deepEqual(rules(await runSuite(deadline)), ['timeout-invalid']);
  const nested = good();
  assert.equal((await runSuite(nested)).status, 'pass');
  nested.cases[0].expected.extra = { tooDeep: true };
  assert.deepEqual(rules(await runSuite(nested)), ['depth-limit']);
  const exact = [0, LIMITS.milliseconds, LIMITS.milliseconds];
  assert.equal((await runSuite(good(), { now: () => exact.shift() ?? LIMITS.milliseconds })).status, 'pass');
  let calls = 0;
  assert.deepEqual(rules(await runSuite(good(), { now: () => calls++ < 2 ? 0 : LIMITS.milliseconds + 1 })), ['time-limit']);
});

test('case 10 sorts before case 2 by code unit in emitted findings', async () => {
  const input = good();
  input.cases = Array.from({ length: 11 }, (_, i) => ({ command: 'print-ok', timeoutMs: 1000, expected: { exitCode: 0, stdout: i === 2 || i === 10 ? 'different' : 'fixture-ok\n' } }));
  const result = await runSuite(input);
  assert.equal(result.status, 'fail');
  assert.deepEqual(result.findings.map(f => f.location.pointer), ['/cases/10/expected/stdout', '/cases/2/expected/stdout']);
});
