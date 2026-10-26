// C7a.S1.T5 — Synthetic module-load count refusal.
//
// Three independent cases in which release/profiles.mjs, copied as opaque bytes into a fresh
// owned temporary directory next to a FAKE minimal C0-like inventory.json, must refuse to import.
// The fixtures test loader robustness only: no participant identity claim follows from them, and
// no live inventory or original product file is modified here; the copied module bytes travel by
// copyFile as an opaque bundle and are not inspected as implementation text.
//
// Per release/profiles.d.mts, the module reads its adjacent participant inventory once at load.
// A well-formed JSON document whose declared participant.fileCount does not agree with the actual
// files value is refused at import by an ordinary Error with the decided message, distinct from
// the SyntaxError a malformed JSON document would surface. Each case below gets a fresh random
// directory so Node's module cache never sees a repeated path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRATCH_BASE = new URL('./.tmp/profile-authority/', import.meta.url);
const SOURCE_MODULE = fileURLToPath(new URL('../../../release/profiles.mjs', import.meta.url));
const SCHEMA = 'benchboard.c0.participant-inventory/1';
const EXPECTED_MESSAGE = 'Unsupported canonical participant inventory';

// Decided fakes. In memory only; the real inventory is never read.
const FAKES = [
  ['zero actual entries against declared fileCount 26', []],
  ['an object where an array is expected', {}],
  ['actual length 25 against declared fileCount 26', Array(25).fill({})],
];

async function refuse(files) {
  await mkdir(SCRATCH_BASE, { recursive: true });
  const directory = await mkdtemp(path.join(fileURLToPath(SCRATCH_BASE), 'case-'));
  try {
    await copyFile(SOURCE_MODULE, path.join(directory, 'profiles.mjs'));
    await writeFile(
      path.join(directory, 'inventory.json'),
      JSON.stringify({ schema: SCHEMA, participant: { fileCount: 26, files } }),
      'utf8',
    );
    await assert.rejects(
      () => import(pathToFileURL(path.join(directory, 'profiles.mjs')).href),
      (error) => {
        assert.ok(error instanceof Error, 'rejection must be a genuine Error instance');
        assert.equal(error.constructor.name, 'Error', 'refusal must be an ordinary Error');
        assert.ok(!(error instanceof SyntaxError), 'refusal is not a JSON SyntaxError');
        assert.ok(!(error instanceof TypeError), 'refusal is not a TypeError');
        assert.equal(error.name, 'Error');
        assert.equal(error.message, EXPECTED_MESSAGE);
        return true;
      },
      'expected an ordinary Error carrying the exact refusal message',
    );
  } finally {
    await rm(directory, { recursive: true, force: true }); // only this case's owned directory
  }
}

for (const [label, files] of FAKES) {
  test(`load-time authority refusal — ${label}`, () => refuse(files));
}
