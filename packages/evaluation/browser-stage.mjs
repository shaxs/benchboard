// Browser stage. The parent entry is the Captain-fixed worker protocol; the child handler wraps
// the unchanged loopback server and browser property evaluator with a bounded server log and
// guaranteed closure of the acquired server. The semantic modules load only by dynamic import
// inside the child handler, so no facade path or unit test loads Playwright, and the T2 runner is
// never imported here.
import fs from 'node:fs';
import path from 'node:path';
import { EvaluationInfrastructureError, runWorkerStage } from './contracts.mjs';

const STAGE = 'browser';

// Mirrors the child-side prerequisite classification the Captain's stage-worker applies to raw
// failures, so a missing Chromium executable or vite install is a MISSING_PREREQUISITE
// infrastructure error and never a set of failed properties. Per S1 AC3 an explicit timeout stays
// distinct (TIMEOUT); an ordinary server or tool crash remains TOOL_CRASH.
const MISSING_PREREQUISITE_PATTERN = /executable doesn't exist|executable.*not.*exist|cannot find (?:module|package)|ENOENT/i;
const TIMEOUT_PATTERN = /timed out|timeout/i;

function classify(message) {
  if (MISSING_PREREQUISITE_PATTERN.test(message)) return 'MISSING_PREREQUISITE';
  if (TIMEOUT_PATTERN.test(message)) return 'TIMEOUT';
  return 'TOOL_CRASH';
}

function asInfrastructure(message, error) {
  if (error instanceof EvaluationInfrastructureError) return error;
  const text = String(error?.message ?? error ?? '');
  return new EvaluationInfrastructureError(STAGE, classify(text), message, { cause: text.slice(0, 4000) });
}

// Byte-exact bound: maxOutputBytes is a byte budget, so truncation happens on the encoded buffer.
// Returns the written buffer plus whether the source exceeded the bound.
function bounded(bytes, maxOutputBytes) {
  const buffer = Buffer.from(String(bytes));
  return buffer.byteLength <= maxOutputBytes
    ? { buffer, oversized: false }
    : { buffer: buffer.subarray(0, maxOutputBytes), oversized: true };
}

// Writes the bounded server log and returns an OUTPUT_LIMIT detail string when the source was
// truncated, or null when it fit.
function writeServerLog(artifactRoot, text, maxOutputBytes) {
  const { buffer, oversized } = bounded(text, maxOutputBytes);
  fs.writeFileSync(path.join(artifactRoot, 'server.log'), buffer);
  return oversized
    ? 'server.log exceeded its ' + maxOutputBytes + '-byte bound and was written only as a bounded prefix'
    : null;
}

export function runBrowserStage(context) {
  return runWorkerStage(context, STAGE);
}

export async function executeBrowserStage(request, dependencies = {}) {
  let startServer = dependencies.localServer;
  if (!startServer) startServer = (await import('../../evaluator/local-server.mjs')).localServer;
  let evaluateProperties = dependencies.browserEvaluate;
  if (!evaluateProperties) evaluateProperties = (await import('../../evaluator/browser.mjs')).browserEvaluate;

  fs.mkdirSync(request.artifactRoot, { recursive: true });

  let server;
  try {
    server = await startServer(request.appRoot);
  } catch (error) {
    // No handle was acquired, so nothing may be closed. The unchanged helper carries the server's
    // accumulated diagnostics inside the thrown message, so they are retained as a bounded
    // server.log instead of being discarded.
    const primary = asInfrastructure('Browser stage loopback server failed to start', error);
    const diagnostics = String(error?.message ?? error ?? '');
    if (diagnostics) {
      try {
        const limitDetail = writeServerLog(request.artifactRoot, diagnostics, request.maxOutputBytes);
        if (limitDetail) primary.details.outputLimit = limitDetail;
      } catch (logError) {
        primary.details.cleanupErrors = ['server log write: ' + String(logError.message ?? logError).slice(0, 2000)];
      }
    }
    throw primary;
  }

  let results = null;
  let primary = null;
  try {
    // Fixed call shape: url and artifact root only, never a property filter — all 25 properties run.
    results = await evaluateProperties(server.url, request.artifactRoot);
  } catch (error) {
    primary = asInfrastructure('Browser stage property evaluation failed', error);
  } finally {
    const cleanupErrors = [];
    let logText = '';
    try {
      logText = String(server.logs ? server.logs() : '');
    } catch (error) {
      cleanupErrors.push('server logs: ' + String(error.message ?? error).slice(0, 2000));
    }
    try {
      const closed = server.close();
      if (closed != null && typeof closed.then === 'function') await closed;
    } catch (error) {
      cleanupErrors.push('server close: ' + String(error.message ?? error).slice(0, 2000));
    }
    // The acquired server is always closed before the bounded log is written, so a log-classification
    // failure can never strand the server.
    let limitDetail = null;
    try {
      limitDetail = writeServerLog(request.artifactRoot, logText, request.maxOutputBytes);
    } catch (error) {
      cleanupErrors.push('server log write: ' + String(error.message ?? error).slice(0, 2000));
    }
    if (primary) {
      // Preserve the primary cause; a cleanup or limit problem rides along as extra detail.
      if (cleanupErrors.length) primary.details.cleanupErrors = cleanupErrors;
      if (limitDetail) primary.details.outputLimit = limitDetail;
      throw primary;
    }
    // A truncated log means the recorded evidence is incomplete: an explicit OUTPUT_LIMIT failure,
    // never a silent success.
    if (limitDetail) {
      throw new EvaluationInfrastructureError(STAGE, 'OUTPUT_LIMIT', 'Browser stage server log exceeded its bound and was truncated', {
        outputLimit: limitDetail, ...(cleanupErrors.length ? { cleanupErrors } : {}),
      });
    }
    if (cleanupErrors.length) {
      throw new EvaluationInfrastructureError(STAGE, 'CLEANUP_FAILED', 'Browser stage cleanup did not complete cleanly', { cleanupErrors });
    }
  }
  return results;
}
