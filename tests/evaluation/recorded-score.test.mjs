// Entry point for the recorded scorer replay suite (recorded-score.suite.mjs), which reads
// owner-only recorded artifacts while loading. A public clone has none, so it reports one skipped test.
import test from 'node:test';
import { hasOwnerEvidence, OWNER_EVIDENCE_REASON } from '../owner-evidence.mjs';

if (hasOwnerEvidence('artifacts/starter-report/report.json', 'artifacts/reference-report/report.json', 'artifacts/broken-report/report.json', 'artifacts/reference-repeat/hidden.json')) await import('./recorded-score.suite.mjs');
else test('recorded scorer replay suite', { skip: OWNER_EVIDENCE_REASON }, () => {});
