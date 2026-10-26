// Captain-owned exact source materialization. C2 remains the only run exporter.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inventoryTree, sha256 } from '../packages/core/identity.mjs';
import { validateRecord, canonicalJson } from '../packages/core/manifest.mjs';
import { assertDisjointRoots } from '../packages/core/paths.mjs';
import { assertDirectoryChain } from '../packages/evaluation/staging.mjs';
import { INSTALLATION_ROOT, readOrdinaryBytes, rejectIntegrity } from './filesystem.mjs';

const identity = stat => `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
function safeRelative(file) {
  if (typeof file !== 'string' || path.isAbsolute(file) || /[\\:\x00-\x1f\x7f]/.test(file) ||
      file.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) rejectIntegrity();
  return file;
}
function sameChain(root, chain) {
  if (canonicalJson(assertDirectoryChain(root)) !== canonicalJson(chain)) rejectIntegrity();
}
export function prepareChallengeSource(installation) {
  if (installation?.root !== INSTALLATION_ROOT || installation.challenge?.sourceRoot !== path.join(INSTALLATION_ROOT, 'starter')) rejectIntegrity();
  const challenge = installation.challenge;
  validateRecord('ChallengeIdentity', challenge.identity);
  const inventory = challenge.identity.starterInventory;
  if (!Array.isArray(inventory) || inventory.length !== 26 ||
      canonicalJson(challenge.fileManifest) !== canonicalJson(inventory.map(entry => entry[0]))) rejectIntegrity();
  const names = inventory.map(entry => safeRelative(entry[0]));
  if (new Set(names.map(file => file.toLowerCase())).size !== 26) rejectIntegrity();
  const parent = path.resolve(os.tmpdir());
  assertDirectoryChain(parent);
  assertDisjointRoots([INSTALLATION_ROOT, parent]);
  assertDisjointRoots([fs.realpathSync.native(INSTALLATION_ROOT), fs.realpathSync.native(parent)]);
  const root = fs.mkdtempSync(path.join(parent, 'bb-cli-source-'));
  const chain = assertDirectoryChain(root), claims = new Map([['', { directory: true, identity: identity(fs.lstatSync(root)) }]]);
  let removed = false;
  function checkParents(relative) {
    sameChain(root, chain);
    const parts = relative.split('/');
    for (let length = 1; length < parts.length; length += 1) {
      const directory = parts.slice(0, length).join('/'), claim = claims.get(directory);
      const stat = fs.lstatSync(path.join(root, directory));
      if (!claim?.directory || !stat.isDirectory() || stat.isSymbolicLink() || identity(stat) !== claim.identity) rejectIntegrity();
    }
  }
  function checkEntry(relative) {
    checkParents(relative);
    const claim = claims.get(relative), file = path.join(root, relative), stat = fs.lstatSync(file);
    if (!claim || stat.isSymbolicLink() || identity(stat) !== claim.identity || stat.isDirectory() !== claim.directory) rejectIntegrity();
    if (!claim.directory && (!stat.isFile() || stat.nlink !== 1 || sha256(readOrdinaryBytes(file)) !== claim.digest)) rejectIntegrity();
    checkParents(relative);
    return claim;
  }
  function checkWholeTree() {
    let seen = 0;
    function walk(relative) {
      const claim = checkEntry(relative);
      seen += 1;
      if (!claim.directory) return;
      const entries = fs.readdirSync(path.join(root, relative));
      if (entries.length > 64) rejectIntegrity();
      for (const name of entries) {
        const child = relative ? `${relative}/${name}` : name;
        if (!claims.has(child)) rejectIntegrity(); // Never enter an unowned directory.
        walk(child);
      }
    }
    walk('');
    if (seen !== claims.size) rejectIntegrity();
  }
  function dispose() {
    if (removed) return Object.freeze({ status: 'removed', root });
    try {
      checkWholeTree();
      for (const [relative, claim] of [...claims].reverse()) {
        if (claim.directory) continue;
        checkEntry(relative);
        fs.unlinkSync(path.join(root, relative));
      }
      for (const [relative, claim] of [...claims].reverse()) {
        if (!claim.directory) continue;
        checkEntry(relative);
        fs.rmdirSync(path.join(root, relative));
      }
      removed = true;
      return Object.freeze({ status: 'removed', root });
    } catch {
      return Object.freeze({ status: 'retained', root });
    }
  }
  try {
    for (const [relative, digest] of inventory) {
      sameChain(root, chain);
      const parts = relative.split('/');
      for (let length = 1; length < parts.length; length += 1) {
        const directory = parts.slice(0, length).join('/');
        if (claims.has(directory)) { checkEntry(directory); continue; }
        fs.mkdirSync(path.join(root, directory));
        claims.set(directory, { directory: true, identity: identity(fs.lstatSync(path.join(root, directory))) });
      }
      const bytes = readOrdinaryBytes(path.join(challenge.sourceRoot, relative));
      if (sha256(bytes) !== digest) rejectIntegrity();
      const target = path.join(root, relative);
      fs.writeFileSync(target, bytes, { flag: 'wx' });
      claims.set(relative, { directory: false, identity: identity(fs.lstatSync(target)), digest });
    }
    checkWholeTree();
    if (inventoryTree({ root, skipNames: [] }).digest !== challenge.identity.workloadDigest) rejectIntegrity();
    return Object.freeze({ sourceRoot: root, dispose });
  } catch (error) {
    // A failed materialization has no cleanup authority over unrecorded partial bytes.
    // Retain it, expose the local path only as structured private error context.
    if (error instanceof Error) Object.defineProperty(error, 'sourceResidue', { value: root });
    throw error;
  }
}
