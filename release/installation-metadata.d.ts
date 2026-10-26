/** Declarations for the synthetic package metadata renderer at
 *  release/installation-metadata.mjs. The module reads two fixed, module-relative
 *  template files and returns their static metadata; it accepts no paths, options
 *  or caller input, and it performs no install, validation or approval step. */

/** The static synthetic package metadata: the exact UTF-8 text of the two fixed
 *  template files `release/templates/tooling-package.json` and
 *  `release/templates/tooling-package-lock.json`, read relative to the module.
 *  There are no null fields. The returned object and both strings are readable
 *  but the frozen result is treated as read-only; no nested structure beyond the
 *  two strings exists. */
export interface SyntheticPackageMetadata {
  readonly packageJson: string;
  readonly packageLock: string;
}

/** Renders the static synthetic package metadata. The function takes no arguments
 *  — even `undefined` counts as an argument — and any argument throws a TypeError
 *  with the exact fixed message `Synthetic package metadata takes no arguments`.
 *  Both shipped template files must be present and readable; a native read error
 *  from either passes through unchanged. The call parses, normalizes or validates
 *  nothing, selects no release approval, reads no caller file, writes no output,
 *  and performs no install, process, hook or network action. */
export declare function renderSyntheticPackageMetadata(): SyntheticPackageMetadata;
