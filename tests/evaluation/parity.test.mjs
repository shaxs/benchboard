// Entry point for the recorded-evidence parity suite (parity.suite.mjs), which reads owner-only
// recorded artifacts while loading. A public clone has none, so it reports one skipped test.
import test from 'node:test';
import { hasOwnerEvidence, OWNER_EVIDENCE_REASON } from '../owner-evidence.mjs';

if (hasOwnerEvidence('artifacts/broken-source', 'artifacts/starter-visible.json', 'artifacts/reference-repeat/hidden.json')) await import('./parity.suite.mjs');
else test('recorded parity suite', { skip: OWNER_EVIDENCE_REASON }, () => {});
