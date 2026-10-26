import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const preload = new URL('../../packages/evaluation/exit-witness.mjs', import.meta.url).href;
const key = 'BENCHBOARD_EVALUATION_EXIT_WITNESS';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-eval-exit-witness-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, file: path.join(root, 'exit.json'), nonce: randomBytes(24).toString('hex') };
}
function run(f, program, env = { [key]: JSON.stringify({ file: f.file, nonce: f.nonce }) }) {
  return spawnSync(process.execPath, ['--import', preload, '-e', program], { cwd: f.root, env, encoding: 'utf8', windowsHide: true, timeout: 5000 });
}

test('normal Node exits 0/1/134 retain actual exit facts and nonce-bound completion evidence', t => {
  for (const code of [0, 1, 134]) {
    const f = fixture(t), child = run(f, `process.exit(${code})`);
    assert.equal(child.status, code, child.stderr); assert.equal(child.signal, null);
    const record = JSON.parse(fs.readFileSync(f.file, 'utf8'));
    assert.deepEqual(record, { version: 1, nonce: f.nonce, pid: child.pid, exitCode: code, normal: true });
    assert.ok(fs.statSync(f.file).size < 256);
  }
});

test('abort has no normal-exit witness; uncaught exception is observed without swallowing it', t => {
  const aborted = fixture(t), child = run(aborted, 'process.abort()');
  assert.ok(child.status !== 0 || child.signal !== null); assert.equal(fs.existsSync(aborted.file), false);
  const thrown = fixture(t), failed = run(thrown, 'throw new Error("controlled uncaught tool failure")');
  assert.notEqual(failed.status, 0); assert.match(failed.stderr, /controlled uncaught tool failure/);
  assert.equal(JSON.parse(fs.readFileSync(thrown.file, 'utf8')).normal, false);
});

test('private key is removed, and inheriting the preload without a key is a no-op', t => {
  const f = fixture(t), child = run(f, `console.log(Object.hasOwn(process.env,${JSON.stringify(key)}))`);
  assert.equal(child.status, 0); assert.equal(child.stdout.trim(), 'false');
  const noKey = fixture(t), standalone = run(noKey, 'console.log("no witness requested")', {});
  assert.equal(standalone.status, 0); assert.equal(fs.existsSync(noKey.file), false);
});

test('a tool-owned exception handler retains its ordinary failure semantics', t => {
  const f = fixture(t);
  const child = run(f, 'process.on("uncaughtException",()=>{console.log("handled by tool");process.exitCode=1;});throw new Error("tool handled failure");');
  assert.equal(child.status, 1); assert.equal(child.stdout.trim(), 'handled by tool');
  assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).normal, true);
});

test('invalid configuration fails before tool execution and exclusive create never replaces foreign metadata', t => {
  const invalid = fixture(t), result = run(invalid, 'console.log("must not run")', { [key]: JSON.stringify({ file: 'relative', nonce: invalid.nonce }) });
  assert.notEqual(result.status, 0); assert.equal(result.stdout, ''); assert.match(result.stderr, /Invalid private Node exit-witness request/);
  const occupied = fixture(t); fs.writeFileSync(occupied.file, 'foreign-canary');
  const completed = run(occupied, 'console.log("normal exit");process.exit(1)');
  assert.equal(completed.status, 1); assert.equal(completed.stdout.trim(), 'normal exit'); assert.equal(fs.readFileSync(occupied.file, 'utf8'), 'foreign-canary');
});
