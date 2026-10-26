// Captain-owned safe-pair/marker publication. Cooperative ownership checks, not OS durability.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateExportProjection } from '../packages/results/export-contract.mjs';
import { renderReportJSON, renderReportText } from '../packages/results/exports.mjs';
import { assertDirectoryChain } from '../packages/evaluation/staging.mjs';
import { explicitFilePath } from './private-output.mjs';
import { externalRoot, readOrdinaryBytes, rejectIntegrity } from './filesystem.mjs';
import { CommandError } from './command-error.mjs';

export const EXPORT_NAMES = Object.freeze(['report.json', 'report.txt']);
export const EXPORT_MARKER = 'EXPORT_COMPLETE.json';
const MAX_BYTES = 16777216;
const identity = stat => `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function safePair(json, text) {
  if (typeof json !== 'string' || typeof text !== 'string' || Buffer.byteLength(json) > MAX_BYTES || Buffer.byteLength(text) > MAX_BYTES) rejectIntegrity();
  let value;
  try { value = JSON.parse(json); } catch { rejectIntegrity(); }
  const projection = validateExportProjection(value);
  if (json !== renderReportJSON(projection) || text !== renderReportText(projection)) rejectIntegrity();
  return [Buffer.from(json), Buffer.from(text)];
}

export function publishSafeExport({ output: supplied, json, text, protectedRoots }) {
  // Validate the closed C5 privacy projection and exact format parity before filesystem mutation.
  const pair = safePair(json, text);
  const output = explicitFilePath(supplied);
  try {
    const prior = fs.lstatSync(output);
    if (prior.isSymbolicLink() || (!prior.isDirectory() && !prior.isFile())) rejectIntegrity();
    throw new CommandError('state');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  externalRoot(output, protectedRoots, true);
  const parent = path.dirname(output), chain = JSON.stringify(assertDirectoryChain(parent));
  const marker = Buffer.from(JSON.stringify({ kind: 'benchboard.cli.safe-export.v1', schemaVersion: '1.0.0',
    files: EXPORT_NAMES.map((name, index) => ({ path: name, bytes: pair[index].length, sha256: digest(pair[index]) })) }, null, 2) + '\n');
  const expected = new Map([...EXPORT_NAMES.map((name, index) => [name, pair[index]]), [EXPORT_MARKER, marker]]);
  const owned = new Map();
  let rootClaim;
  const verifyRoot = () => {
    if (rootClaim === undefined || JSON.stringify(assertDirectoryChain(parent)) !== chain) rejectIntegrity();
    const stat = fs.lstatSync(output);
    if (!stat.isDirectory() || stat.isSymbolicLink() || identity(stat) !== rootClaim) rejectIntegrity();
  };
  const verifyFile = name => {
    verifyRoot();
    const claim = owned.get(name), file = path.join(output, name);
    if (!claim) rejectIntegrity();
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || identity(before) !== claim.identity) rejectIntegrity();
    const bytes = readOrdinaryBytes(file, MAX_BYTES);
    if (!bytes.equals(expected.get(name))) rejectIntegrity();
    const after = fs.lstatSync(file);
    if (!after.isFile() || after.nlink !== 1 || identity(after) !== claim.identity) rejectIntegrity();
    verifyRoot();
    return bytes;
  };
  const membership = names => {
    verifyRoot();
    const entries = fs.readdirSync(output, { withFileTypes: true });
    if (entries.some(entry => !entry.isFile() || entry.isSymbolicLink()) ||
        entries.map(entry => entry.name).sort().join('\0') !== [...names].sort().join('\0')) rejectIntegrity();
  };
  const verifyBundle = complete => {
    membership(complete ? [...EXPORT_NAMES, EXPORT_MARKER] : EXPORT_NAMES);
    const actualJSON = verifyFile(EXPORT_NAMES[0]), actualText = verifyFile(EXPORT_NAMES[1]);
    safePair(actualJSON.toString('utf8'), actualText.toString('utf8'));
    if (complete) verifyFile(EXPORT_MARKER); // Exact closed marker, hashes and byte counts already bound above.
    membership(complete ? [...EXPORT_NAMES, EXPORT_MARKER] : EXPORT_NAMES);
  };
  const write = name => {
    membership(owned.keys());
    let descriptor, failed = false, failure;
    try {
      descriptor = fs.openSync(path.join(output, name), 'wx', 0o600);
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.nlink !== 1) rejectIntegrity();
      owned.set(name, { identity: identity(stat) });
      fs.writeFileSync(descriptor, expected.get(name));
    } catch (error) { failed = true; failure = error; }
    finally {
      if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch (error) { if (!failed) { failed = true; failure = error; } } }
    }
    if (failed) throw failure;
    verifyFile(name);
  };
  try {
    fs.mkdirSync(output, { mode: 0o700 });
    rootClaim = identity(fs.lstatSync(output));
    verifyRoot();
    for (const name of EXPORT_NAMES) write(name);
    verifyBundle(false);
    write(EXPORT_MARKER);
    verifyBundle(true);
    return Object.freeze({ output, complete: true, files: EXPORT_NAMES, completionMarker: EXPORT_MARKER });
  } catch (error) {
    let complete = false, removed = false;
    try { verifyBundle(true); complete = true; } catch {}
    if (!complete && rootClaim !== undefined) {
      // No recursive delete or adoption: only exact still-identified owned files can be retired.
      for (const name of [...owned.keys()].reverse()) {
        try { verifyFile(name); fs.unlinkSync(path.join(output, name)); } catch {}
      }
      try { verifyRoot(); if (fs.readdirSync(output).length === 0) { fs.rmdirSync(output); removed = true; } } catch {}
    }
    // Structured local fate never replaces the original error or becomes default stderr.
    try { Object.defineProperty(error, 'exportFate', { value: Object.freeze({ complete,
      cleanup: rootClaim === undefined ? 'unclaimed' : removed ? 'removed' : 'retained' }) }); } catch {}
    throw error;
  }
}
