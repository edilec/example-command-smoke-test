import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, symlink, link, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { LIMITS } from '../src/index.mjs';

const cli = join(import.meta.dirname, '../bin/example-command-smoke-test.mjs');
const suite = { schemaVersion: '1', cases: [{ command: 'print-ok', timeoutMs: 1000, expected: { exitCode: 0, stdout: 'fixture-ok\n' } }] };
const run = (root, ...extra) => spawnSync(process.execPath, [cli, '--root', root, '--suite', 'suite.json', ...extra], { encoding: 'utf8', env: process.env });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'example-suite-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'suite.json'), JSON.stringify(suite));
  return root;
}

test('CLI runs allowlisted suite and emits deterministic JSON only', async t => {
  const root = await fixture(t); const a = run(root), b = run(root);
  assert.equal(a.status, 0); assert.equal(a.stdout, b.stdout); assert.equal(a.stderr, '');
  assert.equal(JSON.parse(a.stdout).status, 'pass');
});

test('CLI refuses unknown command without running earlier allowlisted cases', async t => {
  const root = await fixture(t); const input = structuredClone(suite);
  input.cases.push({ command: 'arbitrary-shell', timeoutMs: 50, expected: { exitCode: 0, stdout: '' } });
  await writeFile(join(root, 'suite.json'), JSON.stringify(input));
  const result = run(root); const report = JSON.parse(result.stdout);
  assert.equal(result.status, 1); assert.equal(report.summary.checked, 0);
  assert.deepEqual(report.findings.map(f => f.ruleId), ['command-not-allowed']);
  assert.ok(!result.stdout.includes('arbitrary-shell'));
});

test('CLI timeout exits 1 and carries a bounded numeric timeout observation', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'suite.json'), JSON.stringify({ schemaVersion: '1', cases: [{ command: 'wait-250', timeoutMs: 30, expected: { exitCode: 0, stdout: '' } }] }));
  const result = run(root); assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.findings[0].ruleId, 'command-timeout'); assert.equal(report.findings[0].evidence, 'timeoutMs=30');
});

test('Markdown blocks beside suite are never parsed or executed', async t => {
  const root = await fixture(t), marker = join(root, 'should-not-exist');
  await writeFile(join(root, 'README.md'), `# Examples\n\n\`\`\`sh\ntouch ${marker}\n\`\`\`\n`);
  const result = run(root);
  assert.equal(result.status, 0); await assert.rejects(stat(marker));
});

test('CLI input byte bound accepts exact N and refuses N+1', async t => {
  const root = await fixture(t), body = JSON.stringify(suite);
  await writeFile(join(root, 'suite.json'), body + ' '.repeat(LIMITS.bytes - Buffer.byteLength(body)));
  assert.equal(run(root).status, 0);
  await writeFile(join(root, 'suite.json'), body + ' '.repeat(LIMITS.bytes + 1 - Buffer.byteLength(body)));
  const result = run(root); assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).findings[0].ruleId, 'byte-limit');
});

test('CLI malformed input reports incomplete without leaking contents; bad config has empty stdout', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'suite.json'), Buffer.from([0xff]));
  const badUtf8 = run(root); assert.equal(badUtf8.status, 2); assert.equal(JSON.parse(badUtf8.stdout).findings[0].ruleId, 'input-unreadable');
  await writeFile(join(root, 'suite.json'), '"secret-marker" not-json');
  const badJson = run(root); assert.equal(badJson.status, 2); assert.ok(!badJson.stdout.includes('secret-marker'));
  const badConfig = run(root, '--unknown'); assert.equal(badConfig.status, 2); assert.equal(badConfig.stdout, '');
});

test('CLI confines input realpaths and output destinations, allowing ordinary output', async t => {
  const root = await fixture(t), outside = await mkdtemp(join(tmpdir(), 'example-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const allowed = run(root, '--out', 'report.json'); assert.equal(allowed.status, 0);
  assert.equal(await readFile(join(root, 'report.json'), 'utf8'), allowed.stdout);
  await writeFile(join(outside, 'sentinel.json'), 'unchanged');
  await symlink(join(outside, 'sentinel.json'), join(root, 'linked.json'));
  const linked = run(root, '--out', 'linked.json'); assert.equal(linked.status, 2); assert.equal(linked.stdout, '');
  assert.equal(await readFile(join(outside, 'sentinel.json'), 'utf8'), 'unchanged');
  await symlink(outside, join(root, 'escape'));
  const parent = run(root, '--out', 'escape/report.json'); assert.equal(parent.status, 2); assert.equal(parent.stdout, '');
  await assert.rejects(stat(join(outside, 'report.json')));
  await symlink(join(outside, 'sentinel.json'), join(root, 'outside.json'));
  const inputEscape = spawnSync(process.execPath, [cli, '--root', root, '--suite', 'outside.json'], { encoding: 'utf8', env: process.env });
  assert.equal(inputEscape.status, 2); assert.equal(JSON.parse(inputEscape.stdout).status, 'incomplete');
});

test('CLI refuses hard-link output and missing-input aliases through symlinked parent', async t => {
  const root = await fixture(t);
  await link(join(root, 'suite.json'), join(root, 'hard.json'));
  const before = await readFile(join(root, 'suite.json'));
  const hard = run(root, '--out', 'hard.json'); assert.equal(hard.status, 2); assert.equal(hard.stdout, '');
  assert.deepEqual(await readFile(join(root, 'suite.json')), before);
  await symlink(root, join(root, 'alias'));
  for (const dest of ['missing.json', 'alias/missing.json']) {
    const result = spawnSync(process.execPath, [cli, '--root', root, '--suite', 'missing.json', '--out', dest], { encoding: 'utf8', env: process.env });
    assert.equal(result.status, 2); assert.equal(result.stdout, '');
    await assert.rejects(stat(join(root, 'missing.json')));
  }
});
