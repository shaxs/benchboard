# Packaged CLI identity loader

This guide describes the packaged CLI story as identities only: how a
synthetic loader is rendered at build time, and how it loads installed
identity records in a prepared package. It links
[`../cli/installation.mjs`](../cli/installation.mjs),
[`../cli/packaged-installation.mjs`](../cli/packaged-installation.mjs),
[`../release/packaged-cli.mjs`](../release/packaged-cli.mjs), and
[PACKAGED_EVALUATOR.md](PACKAGED_EVALUATOR.md), which covers the analogous
packaged evaluator verifier.

## Two layers, two pins

`loadInstallation()` takes no arguments and reads the fixed
`cli/installation.json` descriptor. Its development path is unchanged; when
the descriptor kind is
`benchboard.cli.synthetic-installation.v1` it dispatches to
`loadPackagedInstallation()` instead. That loader also takes no arguments:
there is no root, mode, digest or lineage option, and it resolves the fixed
installation root itself.

`renderSyntheticCliLoader(profile, descriptorBytes)` in the release module
is the build-time side. It validates the release profile first, then
requires the synthetic profile and bounded descriptor bytes, checks the
descriptor header, reads the fixed `cli/packaged-installation.mjs` template,
and replaces the unique placeholder-pin constant with the SHA-256 digest of
the exact descriptor bytes. The renderer writes nothing. Like the evaluator
verifier rendering, the compiled pin proves the descriptor relative to the
generated code; it is not a signature, builder assertion or runtime proof
(see PACKAGED_EVALUATOR.md).

## Separate contracts and domains

The exact descriptor contract is
`benchboard.cli.synthetic-installation.v1`, schema 1.0.0, authorization
`synthetic-only`, package `@benchboard/synthetic-tooling` version
`0.0.0-synthetic`. The numeric tooling, challenge and evaluator versions in
the descriptor stay separate from that package version and from the
historical candidate release train cross-checked against
`version.json` and `release/inventory.json`. The loader verifies the pinned
index (`cli/installed-assets.json`), binds the index entries to their
declared byte counts and digests, and walks the whole application tree
outside the three anchor files (`cli/installation.json`,
`cli/installed-assets.json`, `cli/packaged-installation.mjs`), so missing,
changed or extra files and empty directories refuse. The reported
`assetManifest` includes the actual three anchor bytes after verification,
and the tooling identity records component `synthetic-package-cli`,
tooling id `benchboard-tooling-cli-synthetic-package`, a
`synthetic:<asset digest>` revision, a synthetic-only note and computed
digest provenance. The resealed synthetic tooling record is recursively frozen, including
its provenance, so callers cannot mutate it away from its identity digest.
Challenge and evaluator records carry the same verified
domains as the development path, with exposure `OWNER_LOCAL`, transparency
`LOCAL_VISIBLE` and no secrecy claim.

## Prepared trust boundary and errors

The root `node_modules` tree is an explicitly trusted prepared-prerequisite
state outside the asset index; the loader does not authenticate dependency
runtime or integrity here. Failures surface as a `CommandError` in category
`integrity` with message `CLI_INTEGRITY`, without echoed input paths or cause fields. Native
error stacks are private local diagnostics. The unchanged class inherits `name: 'Error'`;
its constructor is `CommandError`. A
native static-import failure before the loader entry point is not wrapped.
Dropping a synthetic descriptor into an unprepared checkout does not bypass
the refusal there.

## Explicit limits

This story loads identities. The existing
`computeEvaluatorIdentity()`/`evaluateFrozen` checkout dispatch is
unchanged, and installed end-to-end evaluation, manual offline acceptance
and distribution are later decisions. File checks are cooperative, not an
atomic sandbox or power-loss guarantee.
ADS/reparse-point qualification is not claimed. Q2 exposure/utility and Q4 project license
remain unresolved; this synthetic identity surface authorizes no real end-user distribution.
