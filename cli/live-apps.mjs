// Builds the starter and a submission as static sites with relative asset paths, so the review page
// can serve both from its own port for a human to click through. Each build runs in a disposable copy
// with its own copy of the canonical starter dependencies, as the screenshots do.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { INSTALLATION_ROOT } from './filesystem.mjs';
import { TARGETS, copySource } from './screenshots.mjs';

const BUILD_TIMEOUT_MS = 5 * 60000;

function viteBuild(app, outDir) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(app, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--base', './', '--outDir', outDir, '--emptyOutDir'],
      { cwd: app, env: { ...process.env, PWD: app }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let log = '';
    child.stdout.on('data', chunk => { log += chunk; });
    child.stderr.on('data', chunk => { log += chunk; });
    const timer = setTimeout(() => child.kill(), BUILD_TIMEOUT_MS);
    child.on('error', error => { clearTimeout(timer); resolve({ ok: false, log: String(error.message) }); });
    child.on('close', code => { clearTimeout(timer); resolve({ ok: code === 0 && fs.existsSync(path.join(outDir, 'index.html')), log }); });
  });
}

/**
 * @returns {Promise<{sites: Record<string, string|null>, failures: Record<string, string>, close: () => void}>}
 * A site is null when its build failed; failures holds the tail of that build's log.
 */
export async function buildLiveApps(submissionSource) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bblive-'));
  const sources = { starter: path.join(INSTALLATION_ROOT, 'starter'), submission: submissionSource };
  const sites = {}, failures = {};
  try {
    for (const target of TARGETS) {
      const app = path.join(scratch, target), site = path.join(scratch, `${target}-site`);
      copySource(sources[target], app);
      const built = await viteBuild(app, site);
      sites[target] = built.ok ? site : null;
      if (!built.ok) failures[target] = built.log.trim().slice(-1500);
    }
  } catch (error) {
    fs.rmSync(scratch, { recursive: true, force: true });
    throw error;
  }
  return { sites, failures, close: () => fs.rmSync(scratch, { recursive: true, force: true }) };
}

const TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.map': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8',
});

/**
 * Resolves a request path inside a built site: files are served as they are, extensionless paths
 * fall back to index.html (client-side routes), and nothing outside the site is reachable.
 * @returns {{file: string, type: string}|null}
 */
export function siteFile(site, requestPath) {
  let relative;
  try { relative = decodeURIComponent(requestPath); } catch { return null; }
  const file = path.resolve(site, '.' + path.posix.normalize('/' + relative));
  if (file !== site && !file.startsWith(site + path.sep)) return null;
  const isFile = candidate => { try { return fs.statSync(candidate).isFile(); } catch { return false; } };
  if (isFile(file)) return { file, type: TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream' };
  if (path.extname(file) === '') return { file: path.join(site, 'index.html'), type: TYPES['.html'] };
  return null;
}
