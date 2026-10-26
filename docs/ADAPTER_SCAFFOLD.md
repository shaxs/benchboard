# DSH adapter scaffold — metadata only

The DSH adapter in this repository is a scaffold, not a working adapter. The package
[`adapters/dsh/package.json`](../adapters/dsh/package.json) describes the private synthetic
package `@benchboard/synthetic-adapter-dsh` at version `0.0.0-synthetic`, with `type: "module"`
and `exports: "./index.mjs"`, and its `files` list ships `index.mjs` only. The module at
[`adapters/dsh/index.mjs`](../adapters/dsh/index.mjs) exports a single deeply frozen literal,
`adapterScaffold`, which describes itself as `kind: "AdapterPackageScaffold"` with
`status: "scaffold-only"`. That literal is the whole export surface: it has no functions,
no options and nothing to attach, start, stop, supervise or certify.

Nothing in the scaffold connects to DSH at runtime. Importing the module directly, standalone,
performs no reads, writes, network calls, process launches or telemetry, and it requires no core,
DSH binary or configuration. Errors from the underlying package import path (native module load
failures, filesystem errors, syntax errors) are not wrapped.

The declared `compatibleTooling` value names `@benchboard/synthetic-tooling` at
`0.0.0-synthetic`, which is documented in [`INSTALLATION_METADATA.md`](INSTALLATION_METADATA.md)
and mirrored as an optional peer dependency in the adapter's package.json. This peer entry is
compatibility metadata only: no runtime version resolver, validation or incompatibility error
exists, and no other versions are declared compatible. Every capability in the literal's
`capabilities` block is explicitly `false` — runtime integration, telemetry, execution authority,
review, supervision and certification. These are unavailable, not claimed as working.

A real pack/install and live behavior are out of scope for this scaffold.
