#!/usr/bin/env node
import { readFile, realpath, stat, lstat, writeFile, rename, unlink } from 'node:fs/promises';
import { resolve, relative, dirname, basename, isAbsolute, sep, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runSuite, incomplete, LIMITS } from '../src/index.mjs';

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  process.stdout.write('Usage: example-command-smoke-test --root DIR --suite FILE --capture FILE [--out FILE] [--human]\nSuite and capture are exported local evidence; no commands run.\n');
} else {
  let root, suite, capture, out, human = false;
  try {
    for (let i = 0; i < args.length; i++) {
      const key = args[i];
      if (key === '--human') { if (human) throw new Error('duplicate'); human = true; continue; }
      if (!['--root', '--suite', '--capture', '--out'].includes(key) || i + 1 >= args.length || args[i + 1].startsWith('--')) throw new Error('option');
      const value = args[++i];
      if (key === '--root') { if (root) throw new Error('duplicate'); root = value; }
      if (key === '--suite') { if (suite) throw new Error('duplicate'); suite = value; }
      if (key === '--capture') { if (capture) throw new Error('duplicate'); capture = value; }
      if (key === '--out') { if (out) throw new Error('duplicate'); out = value; }
    }
    if (!root || !suite || !capture || [suite, capture, out].filter(Boolean).some(isAbsolute)) throw new Error('path');
    root = await realpath(root);
    if (!(await stat(root)).isDirectory()) throw new Error('root');
  } catch { process.stderr.write('Invalid configuration. Use --help.\n'); process.exit(2); }
  const inside = path => { const rel = relative(root, path); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };
  const names = [suite, capture];
  async function readDocument(name) {
    const file = await realpath(resolve(root, name));
    if (!inside(file) || !(await stat(file)).isFile()) throw new Error('input-unreadable');
    if ((await stat(file)).size > LIMITS.bytes) throw new Error('byte-limit');
    const bytes = await readFile(file, { signal: AbortSignal.timeout(LIMITS.milliseconds) });
    if (bytes.length > LIMITS.bytes) throw new Error('byte-limit');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  }
  let result, values = [];
  for (const name of names) {
    try { values.push(await readDocument(name)); }
    catch (error) {
      const rule = error.message === 'byte-limit' ? 'byte-limit' : 'input-unreadable';
      result = incomplete(rule, rule === 'byte-limit' ? 'Evidence exceeds 1048576 bytes.' : 'Evidence could not be read, decoded, or parsed within the declared root.');
      break;
    }
  }
  if (!result) result = await runSuite({ suite: values[0], capture: values[1] });
  const rendered = `${JSON.stringify(result, null, 2)}\n`;
  if (out) {
    try {
      const destination = resolve(root, out), parent = await realpath(dirname(destination));
      if (!inside(parent) || !inside(destination)) throw new Error('outside root');
      const actualDestination = join(parent, basename(destination));
      for (const name of names) {
        const named = resolve(root, name);
        if (destination === named) throw new Error('output aliases named input');
        const canonicalNamed = await realpath(dirname(named)).then(p => join(p, basename(named))).catch(() => null);
        if (actualDestination === canonicalNamed) throw new Error('output aliases named input');
      }
      let old;
      try { old = await lstat(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (old?.isSymbolicLink() || old?.isDirectory()) throw new Error('invalid output');
      if (old) for (const name of names) {
        const file = await realpath(resolve(root, name)).catch(() => null);
        if (!file || !inside(file)) continue;
        const source = await stat(file);
        if (old.dev === source.dev && old.ino === source.ino) throw new Error('output aliases input');
      }
      const temp = join(parent, `.${basename(destination)}.${randomUUID()}.tmp`);
      try { await writeFile(temp, rendered, { flag: 'wx', mode: 0o600 }); await rename(temp, destination); }
      catch (error) { await unlink(temp).catch(() => {}); throw error; }
    } catch { process.stderr.write('Output destination refused or write failed.\n'); process.exit(2); }
  }
  process.stdout.write(rendered);
  if (human) process.stderr.write(`Example smoke test: ${result.status}; ${result.summary.checked} captured results compared; ${result.summary.errors} errors.\n`);
  process.exitCode = result.status === 'pass' ? 0 : result.status === 'fail' ? 1 : 2;
}
