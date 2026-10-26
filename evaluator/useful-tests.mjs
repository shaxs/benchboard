import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { root, files } from '../runner/files.mjs';
export const usefulMutations = [
  'storage-drop',
  'input-drop',
  'focus-drop',
  'label-case',
  'date-order',
];
export const mutationDomains = {
  'storage-drop': 'persistence',
  'input-drop': 'interaction',
  'focus-drop': 'accessibility',
  'label-case': 'normalization',
  'date-order': 'chronology',
};
export function mutationSetup(id) {
  const patch = {
    'storage-drop':
      "Storage.prototype.setItem=function(key,value){if(key==='benchboard')return;return original.call(this,key,value)};",
    'input-drop':
      "window.EventTarget.prototype.dispatchEvent=function(event){if(event.type==='input'||event.type==='change')return true;return original.call(this,event)};",
    'focus-drop': 'HTMLElement.prototype.focus=function(){};',
    'label-case':
      'String.prototype.toLowerCase=function(){const s=String(this);return /[A-Z]/.test(s)&&/[a-z]/.test(s)?s:original.call(this)};',
    'date-order':
      'Date.parse=function(value){const time=original(value);return Number.isFinite(time)?-time:time};',
  }[id];
  const target = {
    'storage-drop': 'Storage.prototype.setItem',
    'input-drop': 'window.EventTarget.prototype.dispatchEvent',
    'focus-drop': 'HTMLElement.prototype.focus',
    'label-case': 'String.prototype.toLowerCase',
    'date-order': 'Date.parse',
  }[id];
  if (!patch) throw Error('Unknown mutation');
  return `import {beforeEach,afterEach} from 'vitest';const original=${target};beforeEach(()=>{${patch}});afterEach(()=>{${target}=original;});`;
}
export function usefulTestsTrusted(app, destination) {
  if (path.resolve(app) !== path.join(root, 'reference'))
    throw Error(
      'Host mutation tests restricted to owner reference. Use owner-only cooperative submission evaluation after participants stop.',
    );
  return usefulTestsCooperative(app, destination);
}
// Owner-only, after participant capabilities stop. Cooperative trust model; not OS containment.
export function usefulTestsCooperative(app, destination) {
  fs.mkdirSync(destination, { recursive: true });
  const initial = files(path.join(root, 'starter/tests'));
  const extra = files(path.join(app, 'tests')).filter(
    (p) => !initial.includes(p) && /\.(test|spec)\.[cm]?[jt]sx?$/.test(p),
  );
  if (!extra.length)
    return { addedCount: 0, baselinePassed: false, killedMutations: [] };
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-useful-'));
  try {
    for (const p of files(app)) {
      if (p === 'vite.config.ts') continue;
      const to = path.join(scratch, p);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(path.join(app, p), to);
    }
    fs.cpSync(
      path.join(app, 'node_modules'),
      path.join(scratch, 'node_modules'),
      { recursive: true },
    );
    const config = (setup) =>
      `import {defineConfig} from 'vitest/config';import react from '@vitejs/plugin-react';export default defineConfig({plugins:[react()],test:{environment:'jsdom',setupFiles:['./tests/setup.ts'${setup ? ",'./mutation.setup.mjs'" : ''}]}});`;
    const run = (id) => {
      fs.writeFileSync(path.join(scratch, 'vite.config.ts'), config(!!id));
      if (id)
        fs.writeFileSync(
          path.join(scratch, 'mutation.setup.mjs'),
          mutationSetup(id),
        );
      const report = path.join(destination, id || 'baseline') + '.json';
      const p = spawnSync(
        process.execPath,
        [
          path.join(scratch, 'node_modules/vitest/vitest.mjs'),
          'run',
          ...extra.map((x) => 'tests/' + x),
          '--reporter=json',
          '--outputFile=' + report,
        ],
        { cwd: scratch, encoding: 'utf8', timeout: 60000, windowsHide: true },
      );
      if (p.error) throw p.error;
      const result = JSON.parse(fs.readFileSync(report));
      return result;
    };
    const baseline = run(null);
    const addedCount = baseline.numTotalTests;
    const baselinePassed = baseline.numFailedTests === 0 && addedCount > 0;
    const killedMutations = [];
    if (baselinePassed)
      for (const id of usefulMutations) {
        const result = run(id);
        if (result.numFailedTests > 0 && result.numTotalTests === addedCount)
          killedMutations.push(id);
      }
    return {
      addedCount,
      baselinePassed,
      killedMutations,
      method:
        'Five independent fault domains: persistence, interaction, accessibility, normalization, chronology; added tests alone; no test-count reward',
    };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
