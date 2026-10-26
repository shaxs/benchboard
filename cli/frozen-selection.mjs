// Captain-owned selection policy. No implicit latest submission and no runtime injection.
import { verifyFrozenSubmission } from '../packages/core/freeze.mjs';
import { ArgumentError } from './arguments.mjs';
import { CommandError } from './command-error.mjs';

export function snapshotOption(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^snap-[a-f0-9]{32}$/.test(value)) throw new ArgumentError('INVALID_VALUE');
  return value;
}

// Pure projection of an accepted verifier result; not an authentication API.
export function selectFromVerification(verification) {
  if (!verification || !Array.isArray(verification.submissions) || !Array.isArray(verification.runFindings)) throw new CommandError('integrity');
  if (verification.runFindings.length > 0) throw new CommandError('integrity');
  if (verification.submissions.length === 0) throw new CommandError('state');
  if (verification.state !== 'FROZEN' || verification.ok !== true || verification.submissions.some(entry => entry.ok !== true)) throw new CommandError('integrity');
  if (verification.submissions.length !== 1) throw new CommandError('state');
  const selected = verification.submissions[0];
  return Object.freeze({ snapshotId: selected.snapshotId, frozenSubmissionId: selected.frozenSubmissionId,
    snapshotRoot: selected.snapshotRoot, treeDigest: selected.treeDigest, fileCount: selected.fileCount,
    byteCount: selected.byteCount, frozenAt: selected.frozenAt,
    workspaceMatchesFrozenInventory: verification.workspace?.matchesFrozenInventory ?? null });
}

export async function selectVerifiedFrozen(opened, snapshot) {
  const snapshotId = snapshotOption(snapshot);
  const request = { ...opened.request, ...(snapshotId === undefined ? {} : { snapshotId }) };
  return selectFromVerification(await verifyFrozenSubmission(request));
}
