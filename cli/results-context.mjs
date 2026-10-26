// Captain-owned cooperative companion publication. Retained residue is never adopted or deleted.
import fs from 'node:fs';
import path from 'node:path';
import { createStorage } from '../packages/core/storage.mjs';
import { createId } from '../packages/core/identity.mjs';
import { canonicalJson } from '../packages/core/manifest.mjs';
import { openRun } from '../packages/core/lifecycle.mjs';
import { validateCliRecord } from './context-contract.mjs';
import { externalRoot, existingDirectory, readOrdinaryJson, rejectIntegrity } from './filesystem.mjs';
import { CommandError } from './command-error.mjs';
const KIND = 'benchboard.cli.results.v1';
const key = opened => ({ relativePath: 'cli/results.json', kind: KIND, id: `${opened.manifestId}:cli-results` });
async function refresh(opened) {
  if (!opened?.request) rejectIntegrity();
  const current = await openRun(opened.request);
  externalRoot(current.runRoot);
  for (const field of ['runId', 'manifestId', 'manifestDigest', 'runRoot', 'stateRoot', 'workspaceRoot']) {
    if (opened[field] !== current[field]) rejectIntegrity();
  }
  return current;
}
function checkContext(value, opened) {
  const context = validateCliRecord(value);
  if (context.kind !== KIND || context.runId !== opened.runId || context.manifestId !== opened.manifestId ||
      context.manifestDigest !== opened.manifestDigest || context.runRoot !== opened.runRoot ||
      context.attemptsRoot !== path.join(context.resultsRoot, 'attempts') || context.storeRoot !== path.join(context.resultsRoot, 'store')) rejectIntegrity();
  for (const field of ['runRoot', 'resultsRoot', 'attemptsRoot', 'storeRoot']) {
    if (path.resolve(context[field]) !== context[field]) rejectIntegrity();
  }
  externalRoot(context.resultsRoot, [opened.runRoot]);
  externalRoot(context.attemptsRoot, [opened.runRoot, context.storeRoot]);
  externalRoot(context.storeRoot, [opened.runRoot, context.attemptsRoot]);
  return context;
}
async function readBound(opened, storage) {
  const file = path.join(opened.stateRoot, 'cli', 'results.json');
  try { fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  readOrdinaryJson(file);
  const context = checkContext(await storage.read(key(opened)), opened);
  readOrdinaryJson(path.join(context.resultsRoot, 'context.json'));
  const external = await createStorage({ root: context.resultsRoot }).read({ relativePath: 'context.json', kind: KIND, id: context.contextId });
  if (canonicalJson(context) !== canonicalJson(validateCliRecord(external))) rejectIntegrity();
  return context;
}
export async function readResultsContext(opened) {
  const current = await refresh(opened);
  return readBound(current, createStorage({ root: current.stateRoot }));
}
export async function ensureResultsContext(opened, override) {
  const current = await refresh(opened);
  const storage = createStorage({ root: current.stateRoot });
  return storage.withLock(async () => {
    await refresh(opened);
    const bound = await readBound(current, storage);
    if (bound) {
      if (override !== undefined && path.resolve(override) !== bound.resultsRoot) throw new CommandError('state');
      return bound;
    }
    const resultsRoot = externalRoot(override ?? `${current.runRoot}.benchboard-results`, [current.runRoot], true);
    // Exclusive root reservation precedes writes; failures preserve private incomplete residue.
    fs.mkdirSync(resultsRoot);
    existingDirectory(resultsRoot);
    const attemptsRoot = path.join(resultsRoot, 'attempts'), storeRoot = path.join(resultsRoot, 'store');
    fs.mkdirSync(attemptsRoot);
    fs.mkdirSync(storeRoot);
    const context = checkContext({ kind: KIND, schemaVersion: '1.0.0', contextId: createId('cli-context'),
      runId: current.runId, manifestId: current.manifestId, manifestDigest: current.manifestDigest,
      runRoot: current.runRoot, resultsRoot, attemptsRoot, storeRoot }, current);
    const external = createStorage({ root: resultsRoot });
    await external.createImmutable({ relativePath: 'context.json', kind: KIND, id: context.contextId, value: context });
    checkContext(context, await refresh(opened));
    await storage.createImmutable({ ...key(current), value: context });
    return readBound(current, storage);
  });
}
