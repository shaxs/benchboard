/* Test-support probe for tests/contracts/identity-paths.test.mjs.
 *
 * Some rejections cannot be produced portably on every host: a real FIFO needs
 * POSIX mkfifo, a real file symlink needs developer/privileged create rights,
 * and a case-only name pair cannot even be created on a case-insensitive
 * volume. This probe runs in its own Node process, patches the `node:fs`
 * namespace object that the runtime modules read (plain property assignment, no
 * source change, no module-graph hack), and drives the real public API over
 * synthetic directory entries so those guard branches are exercised
 * deterministically on Windows, Linux and macOS.
 *
 * It writes one JSON object to stdout and exits non-zero on an internal
 * problem. It is test support, not a product surface, and it imports nothing
 * outside `node:*` and the two modules under test. It cleans up its own
 * scratch directory at process end; the parent `.tmp/identity` container
 * stays (the focused test owns it). */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventoryTree } from '../../../../packages/core/identity.mjs';
import { resolveWithinRoot } from '../../../../packages/core/paths.mjs';

/**
 * Scratch containment: the probe writes only into the project-contained,
 * locally ignored `tests/contracts/.tmp/identity/` directory (same policy as
 * the focused test), or under `BENCHBOARD_TEST_SCRATCH_ROOT` when that
 * environment variable is supplied at run time. No host-level temporary
 * directory is used and no private absolute path is baked into this file.
 */
function scratchRoot() {
  const override = process.env.BENCHBOARD_TEST_SCRATCH_ROOT;
  if (override !== void 0 && override.length > 0) {
    if (!path.isAbsolute(override)) {
      throw new Error(`BENCHBOARD_TEST_SCRATCH_ROOT must be an absolute directory, got ${JSON.stringify(override)}`);
    }
    fs.mkdirSync(override, { recursive: true });
    return override;
  }
  const contained = fileURLToPath(new URL('../../.tmp/identity/', import.meta.url));
  fs.mkdirSync(contained, { recursive: true });
  return contained;
}

const scratch = fs.mkdtempSync(path.join(scratchRoot(), 'benchboard-t1-stub-'));

const original = {
  lstatSync: fs.lstatSync.bind(fs),
  statSync: fs.statSync.bind(fs),
  readdirSync: fs.readdirSync.bind(fs),
  readFileSync: fs.readFileSync.bind(fs),
};

const intercept = { lstat: new Map(), stat: new Map(), readdir: new Map(), read: new Map() };
const key = (target) => path.resolve(String(target));

fs.lstatSync = (...args) => { const hit = intercept.lstat.get(key(args[0])); return hit === void 0 ? original.lstatSync(...args) : hit; };
fs.statSync = (...args) => { const hit = intercept.stat.get(key(args[0])); return hit === void 0 ? original.statSync(...args) : hit; };
fs.readdirSync = (...args) => { const hit = intercept.readdir.get(key(args[0])); return hit === void 0 ? original.readdirSync(...args) : hit; };
fs.readFileSync = (...args) => { const hit = intercept.read.get(key(args[0])); return hit === void 0 ? original.readFileSync(...args) : hit; };

function stats({ link = false, file = false, directory = false }) {
  return {
    isSymbolicLink: () => link,
    isFile: () => file,
    isDirectory: () => directory,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFifo: () => false,
    isSocket: () => false,
    size: 2,
  };
}

const dirent = (name) => ({ name, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false });

/* What Node reports for a fifo/socket/device entry: neither file nor dir. */
const specialDirent = (name) => ({
  name,
  isFile: () => false,
  isDirectory: () => false,
  isSymbolicLink: () => false,
  isFifo: () => true,
  isSocket: () => false,
});

function emptyRoot(name) {
  const root = path.join(scratch, name);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function reset() {
  for (const map of Object.values(intercept)) map.clear();
}

function capture(action) {
  try {
    const value = action();
    return { threw: false, value: typeof value === 'string' ? value : null };
  } catch (error) {
    return { threw: true, name: error.name, code: error.code === void 0 ? null : error.code, message: error.message };
  }
}

const results = {};

// A non-regular entry (FIFO/socket/device class) is refused instead of hashed.
reset();
{
  const root = emptyRoot('special-entry');
  const synthetic = path.join(root, 'weird.fifo');
  intercept.readdir.set(key(root), [specialDirent('weird.fifo')]);
  intercept.lstat.set(key(synthetic), stats({}));
  results.inventorySpecialEntry = capture(() => inventoryTree({ root }));
}

// Two entries that differ only by case/folding are refused on every host.
reset();
{
  const root = emptyRoot('fold-entry');
  for (const name of ['Note.txt', 'note.txt']) {
    const synthetic = path.join(root, name);
    intercept.lstat.set(key(synthetic), stats({ file: true }));
    intercept.stat.set(key(synthetic), { size: 2 });
    intercept.read.set(key(synthetic), Buffer.from('x\n'));
  }
  intercept.readdir.set(key(root), [dirent('Note.txt'), dirent('note.txt')]);
  results.inventoryFoldCollision = capture(() => inventoryTree({ root }));
}

// A link entry is refused even where file links cannot be created at all.
reset();
{
  const root = emptyRoot('link-entry');
  const synthetic = path.join(root, 'link.txt');
  intercept.readdir.set(key(root), [dirent('link.txt')]);
  intercept.lstat.set(key(synthetic), stats({ link: true }));
  results.inventoryLinkEntry = capture(() => inventoryTree({ root }));
}

// resolveWithinRoot: the target itself is a link.
reset();
{
  const root = emptyRoot('rw-target-link');
  intercept.lstat.set(key(path.join(root, 'link')), stats({ link: true }));
  results.resolveTargetLink = capture(() => resolveWithinRoot({ root, relativePath: 'link' }));
}

// resolveWithinRoot: the target is a special file.
reset();
{
  const root = emptyRoot('rw-target-special');
  intercept.lstat.set(key(path.join(root, 'special')), stats({}));
  results.resolveTargetSpecial = capture(() => resolveWithinRoot({ root, relativePath: 'special' }));
}

// resolveWithinRoot: the requested spelling differs from disk only by case.
reset();
{
  const root = emptyRoot('rw-fold');
  intercept.lstat.set(key(path.join(root, 'note.txt')), stats({ file: true }));
  intercept.readdir.set(key(root), ['Note.txt']);
  results.resolveFoldSpelling = capture(() => resolveWithinRoot({ root, relativePath: 'note.txt' }));
}

// Control: the guards must not fire without cause, a plain file still resolves.
reset();
{
  const root = emptyRoot('rw-control');
  fs.writeFileSync(path.join(root, 'real.txt'), 'x\n');
  results.resolveRegularControl = capture(() => resolveWithinRoot({ root, relativePath: 'real.txt' }));
}

process.stdout.write(`${JSON.stringify({ ok: true, scratchWasUnder: path.dirname(scratch), results })}\n`);
fs.rmSync(scratch, { recursive: true, force: true });
