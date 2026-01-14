#!/usr/bin/env node
import { readFile, realpath, stat, lstat, writeFile, rename, unlink } from 'node:fs/promises';
import { resolve, relative, dirname, basename, isAbsolute, sep, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runSuite, incomplete, LIMITS } from '../src/index.mjs';

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  process.stdout.write('Usage: example-command-smoke-test --root DIR --suite FILE [--out FILE] [--human]\nSuite and output paths are relative to root. JSON report goes to stdout; --out also writes it.\n');
} else {
  let root, suite, out, human = false;
  try {
    for (let i = 0; i < args.length; i++) {
      const key = args[i];
      if (key === '--human') { if (human) throw new Error('duplicate'); human = true; continue; }
      if (!['--root', '--suite', '--out'].includes(key) || i + 1 >= args.length || args[i + 1].startsWith('--')) throw new Error('option');
      const value = args[++i];
      if (key === '--root') { if (root) throw new Error('duplicate'); root = value; }
      if (key === '--suite') { if (suite) throw new Error('duplicate'); suite = value; }
      if (key === '--out') { if (out) throw new Error('duplicate'); out = value; }
    }
    if (!root || !suite || isAbsolute(suite) || (out && isAbsolute(out))) throw new Error('path');
    root = await realpath(root);
    if (!(await stat(root)).isDirectory()) throw new Error('root');
  } catch { process.stderr.write('Invalid configuration. Use --help.\n'); process.exit(2); }
  const inside = path => { const rel = relative(root, path); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };
  const suiteName = resolve(root, suite);
  let suiteReal, result;
  try {
    suiteReal = await realpath(suiteName);
    if (!inside(suiteReal) || !(await stat(suiteReal)).isFile()) throw new Error('input-unreadable');
    if ((await stat(suiteReal)).size > LIMITS.bytes) throw new Error('byte-limit');
    const bytes = await readFile(suiteReal, { signal: AbortSignal.timeout(LIMITS.milliseconds) });
    if (bytes.length > LIMITS.bytes) throw new Error('byte-limit');
    result = await runSuite(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch (error) {
    const rule = error.message === 'byte-limit' ? 'byte-limit' : 'input-unreadable';
    result = incomplete(rule, rule === 'byte-limit' ? 'Suite exceeds 1048576 bytes.' : 'Suite could not be read, decoded, or parsed within the declared root.');
  }
  const rendered = `${JSON.stringify(result, null, 2)}\n`;
  if (out) {
    try {
      const destination = resolve(root, out), parent = await realpath(dirname(destination));
      if (!inside(parent) || !inside(destination)) throw new Error('outside root');
      const actualDestination = join(parent, basename(destination));
      if (destination === suiteName) throw new Error('output aliases named input');
      const canonicalNamed = await realpath(dirname(suiteName)).then(p => join(p, basename(suiteName))).catch(() => null);
      if (actualDestination === canonicalNamed) throw new Error('output aliases named input');
      let old;
      try { old = await lstat(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (old?.isSymbolicLink() || old?.isDirectory()) throw new Error('invalid output');
      if (old && suiteReal) {
        const source = await stat(suiteReal);
        if (old.dev === source.dev && old.ino === source.ino) throw new Error('output aliases input');
      }
      const temp = join(parent, `.${basename(destination)}.${randomUUID()}.tmp`);
      try { await writeFile(temp, rendered, { flag: 'wx', mode: 0o600 }); await rename(temp, destination); }
      catch (error) { await unlink(temp).catch(() => {}); throw error; }
    } catch { process.stderr.write('Output destination refused or write failed.\n'); process.exit(2); }
  }
  process.stdout.write(rendered);
  if (human) process.stderr.write(`Example smoke test: ${result.status}; ${result.summary.checked} commands attempted; ${result.summary.errors} errors.\n`);
  process.exitCode = result.status === 'pass' ? 0 : result.status === 'fail' ? 1 : 2;
}
