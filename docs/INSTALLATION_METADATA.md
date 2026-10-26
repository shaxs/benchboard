# Synthetic package installation metadata

[`../release/installation-metadata.mjs`](../release/installation-metadata.mjs) exports
`renderSyntheticPackageMetadata()`, returning the static package metadata for the synthetic
profile; its types are the byte-identical `.d.ts`/`.d.mts` pair. The function takes no
arguments (`undefined` included); any argument throws a `TypeError` with the exact message
`Synthetic package metadata takes no arguments`. It returns a frozen object with the two string
fields `packageJson` and `packageLock`, the exact UTF-8 text of
[`../release/templates/tooling-package.json`](../release/templates/tooling-package.json) and
[`../release/templates/tooling-package-lock.json`](../release/templates/tooling-package-lock.json)
read module-relative; both must be readable and native read errors pass through unchanged. It
parses, validates or approves nothing, accepts no caller paths, options or files, writes
no output, and performs no install, `npm pack`, browser download, process, hook, network or
publication action.

## What the metadata describes

The package template declares `@benchboard/synthetic-tooling`, version `0.0.0-synthetic`,
`private: true`, `"type": "module"`, `bin` `benchboard` → `./cli/benchboard.mjs`, engines Node
24.13.1/npm 11.8.0, and the runtime dependencies `@playwright/test` 1.51.1 and `ajv` 8.17.1
(not dev-only), with no devDependencies, root lifecycle scripts or license field; the project
license is unresolved and the root stays private, dev-oriented. The `engines` entries are
preparation constraints, not clean-install, support or qualification statements.

The lock template is version 3 with `requires: true`; its root record agrees with the package
template on name, version, bin, engines and direct dependencies. Its nine records copy the
root lock deleting only the `dev` and `devOptional` flags, preserving resolved
public npm URLs and integrity hashes plus, where present, license declarations, funding,
optional, os and hasInstallScript metadata. They are static text only: not dependency
resolution or installation proof; preserving a `hasInstallScript` flag or the optional
`fsevents` record executes nothing and asserts nothing about Windows install or support.
Prettier is excluded as a formatter, not a runtime dependency, and Playwright browser
binaries remain a prerequisite the renderer never downloads or installs.

## What the file list is

The `files` array is a static synthetic allowlist naming the runtime CLI, core, evaluation,
results, schemas and manual adapter packages, starter, fixtures, the six explicit evaluator
semantic files, historical `runner/files.mjs`, the release inventory and the version file. It
is not the staged or archived inventory, not exposure approval for evaluator or fixture
content, nor authorization to copy private or ignored files. Staging and byte auditing
remain separate content checks; notice inventory records declarations only. No historical
runner or evaluator report command appears. Lock license statements are declarations
only; distribution and notice state are covered in
[NOTICE_INVENTORY.md](NOTICE_INVENTORY.md). No clean-install, readiness, legal, support or
archival claim is made here.
