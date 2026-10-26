import type { ProcessRequest, ProcessResult } from './contracts.mjs';
export type { ProcessRequest, ProcessResult } from './contracts.mjs';
/**
 * Bounded, no-shell process runner. Resolves with a completed ProcessResult for ordinary exits
 * (including nonzero) and an infrastructure-error ProcessResult for spawn failure (distinct
 * MISSING_PREREQUISITE), timeout, cancellation, output overflow or abrupt termination. Timeout,
 * cancellation and overflow results settle only after the owned process tree has been reaped.
 * Logs are retained at the requested paths. Never throws for an ordinary child failure; invalid
 * internal request arguments throw TypeError. Paths are internal trusted absolute inputs.
 */
export declare function runProcess(request: ProcessRequest): Promise<ProcessResult>;
