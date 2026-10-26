// Captures the twelve UI review screenshots (starter and submission x 1440/1024/768 x board and
// drawer, height 1000) and returns the worksheet evidence list. Each target runs from a disposable
// copy with its own copy of the canonical starter dependencies, so nothing writes into starter/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SELECTION_POLICY_EXCLUSIONS } from '../packages/core/snapshot-copy.mjs';
import { INSTALLATION_ROOT } from './filesystem.mjs';

export const WIDTHS = Object.freeze([1440, 1024, 768]);
export const VIEWS = Object.freeze(['board', 'drawer']);
export const TARGETS = Object.freeze(['starter', 'submission']);
export const HEIGHT = 1000;
export const artifactIdOf = (target, width, view) => `${target}-${width}-${view}.png`;

const excluded = new Set(SELECTION_POLICY_EXCLUSIONS.map(name => name.toLowerCase()));

function copySource(source, destination) {
  fs.cpSync(source, destination, {
    recursive: true,
    filter: from => {
      const relative = path.relative(source, from);
      return !relative || !excluded.has(relative.split(path.sep)[0].toLowerCase());
    },
  });
  fs.cpSync(path.join(INSTALLATION_ROOT, 'starter', 'node_modules'), path.join(destination, 'node_modules'), { recursive: true });
}

async function openDrawer(page) {
  const card = page.getByRole('button', { name: /^BB-001(?=$|[^A-Za-z0-9_-])/ })
    .or(page.getByRole('link', { name: /^BB-001(?=$|[^A-Za-z0-9_-])/ }));
  try { await card.first().click({ timeout: 5000 }); }
  catch { await page.locator('[data-issue-id]').first().click({ timeout: 5000 }); }
  await page.getByRole('dialog').first().waitFor({ state: 'visible', timeout: 5000 });
}

async function captureTarget(browser, url, target, screensRoot) {
  const evidence = [];
  for (const width of WIDTHS) {
    for (const view of VIEWS) {
      const context = await browser.newContext({ viewport: { width, height: HEIGHT }, timezoneId: 'UTC', locale: 'en-US' });
      // Same containment as evaluation: the app may only reach its own origin.
      await context.route('**/*', route => (new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort()));
      const page = await context.newPage();
      let note = null;
      try {
        await page.goto(url, { waitUntil: 'load', timeout: 20000 });
        await page.locator('[data-issue-id]').first().waitFor({ timeout: 10000 }).catch(() => { note = 'board did not render issue cards'; });
        if (view === 'drawer') await openDrawer(page).catch(() => { note = 'issue drawer did not open'; });
      } catch { note = 'page did not load'; }
      const artifactId = artifactIdOf(target, width, view);
      const bytes = await page.screenshot({ path: path.join(screensRoot, artifactId) });
      await context.close();
      evidence.push({ artifactId, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), target, width, height: HEIGHT, view, note });
    }
  }
  return evidence;
}

/**
 * @param {{submissionSource:string, screensRoot:string}} request screensRoot must exist and be empty.
 * @returns {Promise<Array<{artifactId:string,bytes:number,sha256:string,target:string,width:number,height:number,view:string,note:string|null}>>}
 */
export async function captureScreenshots({ submissionSource, screensRoot }) {
  const { chromium } = await import('@playwright/test');
  const { localServer } = await import('../evaluator/local-server.mjs');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bbshot-'));
  const evidence = [];
  try {
    const sources = { starter: path.join(INSTALLATION_ROOT, 'starter'), submission: submissionSource };
    const browser = await chromium.launch({ headless: true });
    try {
      for (const target of TARGETS) {
        const app = path.join(scratch, target);
        copySource(sources[target], app);
        const server = await localServer(app);
        try { evidence.push(...await captureTarget(browser, server.url, target, screensRoot)); }
        finally { server.close(); }
      }
    } finally { await browser.close(); }
  } finally {
    // Vite's server may still hold files for a moment after close.
    for (let attempt = 0; attempt < 5; attempt++) {
      try { fs.rmSync(scratch, { recursive: true, force: true }); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 500)); }
    }
  }
  return evidence;
}

/** Worksheet evidence entries carry only the schema's fields. */
export const worksheetEvidence = evidence => evidence.map(({ artifactId, bytes, sha256, target, width, height, view }) => ({ artifactId, bytes, sha256, target, width, height, view }));
