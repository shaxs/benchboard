// Synthetic tooling installation metadata templates for packaged release profiles.
// Fixed, ordinary package metadata used only by synthetic scenarios; it is not an
// approval to expose evaluator or fixture content, and no install or support claim
// is made by reading it.
import { readFileSync } from 'node:fs';

const PACKAGE_JSON_URL = new URL('./templates/tooling-package.json', import.meta.url);
const PACKAGE_LOCK_URL = new URL('./templates/tooling-package-lock.json', import.meta.url);

// Returns the exact UTF-8 text of the two fixed template files, read relative to
// this module. Takes no arguments; native read errors pass through unchanged.
export function renderSyntheticPackageMetadata() {
  if (arguments.length !== 0) {
    throw new TypeError('Synthetic package metadata takes no arguments');
  }
  return Object.freeze({
    packageJson: readFileSync(PACKAGE_JSON_URL, 'utf8'),
    packageLock: readFileSync(PACKAGE_LOCK_URL, 'utf8'),
  });
}
