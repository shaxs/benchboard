// Recorded owner evidence (artifacts/, workflow/) is gitignored and never published. Suites that
// replay or preserve it run in the owner checkout and skip, with this reason, in a public clone.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

export const OWNER_EVIDENCE_REASON = 'owner-only recorded evidence (artifacts/, workflow/) is not part of a public checkout';

/** True when every repository-relative path exists. */
export const hasOwnerEvidence = (...relative) => relative.every(entry => fs.existsSync(path.join(REPO_ROOT, entry)));

/** `test()` option: skip with the shared reason unless the named evidence exists. */
export const ownerEvidenceOption = (...relative) => (hasOwnerEvidence(...relative) ? {} : { skip: OWNER_EVIDENCE_REASON });
