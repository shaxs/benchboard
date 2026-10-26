# Run initialisation

`packages/core/init.mjs` turns an existing challenge definition plus explicitly
supplied identities into a fresh, immutable run container and a sealed C1
`RunManifest`. It is the seam between the released pieces — the challenge
exporter, the dependency preparer, the contract layer and the storage layer —
and it adds no policy of its own over theirs.

This document describes the public surface of the core initialisation API that
exists today, and it remains the exact reference for that API: the current
checkout command line (`cli/benchboard.mjs init`, documented in
[CLI.md](CLI.md)) forwards its work to `initialiseRun` from here. The run
lifecycle, evaluation and reporting have their own API guides
([MANUAL_LIFECYCLE.md](MANUAL_LIFECYCLE.md), [EVALUATION.md](EVALUATION.md),
[REPORTING.md](REPORTING.md)). For the current end-user walkthrough, see
[QUICKSTART.md](QUICKSTART.md) and [MANUAL_WORKFLOW.md](MANUAL_WORKFLOW.md).
This is **not** a product quickstart: nothing
here starts, seeds, runs or evaluates a benchmark participant.

- Import specifier: `./packages/core/init.mjs`
- Declarations: `packages/core/init.d.ts` and a byte-identical
  `packages/core/init.d.mts` sibling for ECMAScript-module consumers.
- Module identity recorded in state: `INIT_MODULE_ID` = `benchboard.core.init`.

## What this module does and does not do

It does:

- validate a request against the accepted contracts before it touches a
  filesystem,
- publish a workspace and a separate state root as one all-or-nothing
  transaction,
- seal one C1 `RunManifest` and record it immutably together with two companion
  records,
- verify bytes again immediately before publication, and
- remove only material it can prove it created when it fails.

It does not:

- start, stop or time a run — `init` never takes a start or stop clock, and the
  manifest records no run duration;
- install third-party packages;
- discover a version, model, provider, configuration or host path from the
  machine, the environment, or any parent directory;
- overwrite, rename over, or merge into an existing destination;
- package, publish, or version the product, or declare a `bin` entry.

## Entry points

| Export | Result | Use it for |
| --- | --- | --- |
| `init(request)` | `Promise<SealedRunManifest>` | The sealed run record, and nothing else. |
| `initialiseRun(request)` | `Promise<InitResult>` | The same run, reported in full. |

Both accept the identical request and perform the identical transaction; they
differ only in how much of the outcome they hand back. `initialiseRun` is the
complete report, and `init` is the record it sealed.

```js
import { init } from './packages/core/init.mjs';

const manifest = await init({
  output: '<absolute fresh output root>',
  challenge: {
    identity: challengeIdentity,          // accepted C1 ChallengeIdentity
    sourceRoot: '<absolute definition root>',
    fileManifest: ['README.md', /* … exactly the published workload … */],
    ownerRoots: ['<absolute root that must never enter the workspace>'],
    evaluatorRoots: ['<absolute root that must never enter the workspace>'],
  },
  dependencies: { mode: 'none' },
  toolingIdentity,                        // accepted C1 ToolingIdentity
  evaluatorIdentity,                      // accepted C1 EvaluatorIdentity
  architectureId: 'arch-example-run',
});
```

## The request

Every field is stated explicitly. There is no default root, no default
identity, and no fallback read from the environment.

| Field | Required | Notes |
| --- | --- | --- |
| `output` | yes | Absolute host path of the container to create. Must not exist. |
| `challenge` | yes | Exactly the five keys named by `CHALLENGE_PACKAGE_KEYS`. |
| `dependencies` | yes | `{ mode, … }`; see [Dependency modes](#dependency-modes). |
| `toolingIdentity` | yes | Validated by the accepted contract validator. |
| `evaluatorIdentity` | yes | Validated by the accepted contract validator. |
| `architectureId` | yes | Identifier of the run's architecture domain; must differ from the architecture id of every bound identity. |
| `architectureKind` | no | Forwarded to the manifest. |
| `harness` | no | Forwarded to the manifest. |
| `securityModel` | no | One of `INIT_SECURITY_MODELS`. Unstated is recorded as `UNSPECIFIED`. |
| `expectedSessionPolicy` | no | Forwarded to the manifest. |
| `declaredCeilingMinutes` | no | Must not exceed the ceiling the challenge identity binds. |
| `configuration` | no | Only the contract's own fields. An unrecognised field is refused, not ignored. |
| `notes` | no | Forwarded to the manifest. |
| `createdAt` | no | Observed creation time. Not a clock reading of the run. |
| `beforeWorkspacePublication` | no | Test seam invoked once before the workspace is published. |
| `beforeStatePublication` | no | Test seam invoked once before the state records are published. |

An unrecognised top-level request field is refused with `INVALID_OPTION`. The
two `before*` hooks exist so a caller can observe a specific stage boundary;
they are not a product extension point.

The accepted `ChallengePackage` fields are `identity`, `sourceRoot`,
`fileManifest`, `ownerRoots`, `evaluatorRoots`. Deep validation of the package
belongs to the released exporter; this module does not re-implement it.

### Known facts are recorded as unknown, never guessed

A run fact nobody stated is persisted as `null` or omitted — never as `0`, an
empty string, or a plausible value. The same rule governs the configuration
block: an unstated field is reported as unknown, and a field that is not part of
the contract is refused outright rather than carried along.

## Dependency modes

`DEPENDENCY_MODES` is `['none', 'prepared', 'install']`, mirroring the released
preparer's own declaration.

| Mode | Additional fields | Behaviour |
| --- | --- | --- |
| `none` | — | No dependencies. The workspace holds only the published workload. |
| `prepared` | `preparedRoot`, `sourceRoot`, optional `expectedDependencyDigest` | A prepared dependency tree is copied in from a cache the caller already has, and its digest is provenance-checked. |
| `install` | `npmExecutable`, `sourceRoot`, optional `scratchRoot` | Explicit bounded `npm ci` in isolated scratch; a private cache is retired without deleting unrelated staging material. See [Install validation limits](#install-validation-limits). |

Fields that do not belong to the stated mode are refused with
`DEPENDENCY_MODE_MISMATCH` before any work starts, so a request cannot mean two
different things.

## The result of `initialiseRun`

`InitResult` is frozen. Its shape:

| Path | Meaning |
| --- | --- |
| `schemaVersion`, `kind`, `module` | Identity of this report. |
| `manifest` | The sealed C1 `RunManifest`, read back from storage. |
| `output` | The container root. |
| `workspace.root` | The published workspace root. |
| `workspace.workloadDigest`, `workspace.workloadAlgorithmId`, `workspace.fileCount` | Workload identity in the workload hash domain. |
| `workspace.dependencyDirectory` | Where dependencies landed, or `null`. |
| `state.root` | The state root, which is outside the workspace. |
| `state.insideWorkspace` | Always `false`; recorded so the boundary is observable. |
| `state.runRecord`, `state.dependencyRecord`, `state.exportRecord` | State-relative paths of the three records. |
| `state.dependencyMetadata` | State-relative path of the preparer's own metadata record. |
| `state.runRecordDigest`, `state.dependencyRecordDigest`, `state.exportRecordDigest` | Storage record digests. |
| `dependency.mode`, `dependency.digest`, `dependency.algorithmId` | Dependency identity in the dependency hash domain. |
| `workload.digest`, `workload.algorithmId`, `workload.fileCount` | The workload identity as the exporter computed it. |
| `durationMs` | Wall time of the initialisation call. Not a run duration. |

Two things in this report are deliberately unequal and must stay so:

- `state.runRecordDigest` is the digest of the storage record envelope.
  `manifest.manifestDigest` is the sealed self-digest inside the record. They are
  computed over different bytes.
- `workload.digest` and `dependency.digest` come from **different hash domains**
  (`WORKLOAD_HASH_ALGORITHM_ID` and `DEPENDENCY_HASH_ALGORITHM_ID`). They are
  never interchangeable and never comparable to each other.

## Container layout

```text
<output>/
  workspace/                      # the participant-visible tree
    … the published workload …
    node_modules/                 # only for `prepared` and `install`
  .benchboard/                    # the run state root; never inside workspace/
    state/run.json
    state/dependencies.json
    state/export.json
    dependencies/.benchboard-dependencies.json
```

`workspace/` and `.benchboard/` are named by `WORKSPACE_DIRECTORY_NAME` and
`STATE_DIRECTORY_NAME`. The state root sitting outside the workspace is the
point: run bookkeeping and dependency metadata are not visible to, and are not
writable from inside, the participant workspace.

The paths reported in the result are **final published paths**. Staging paths
never appear in a result or in a persisted record.

## The transaction

One call publishes one container, or leaves nothing usable behind.

1. The request and the package are validated; nothing is written yet.
2. The output is reserved by an exclusive create, so a concurrent writer cannot
   claim the same destination.
3. The source bytes are verified against the bound identity, the workload is
   copied into private staging, the staged bytes are checked, and the **source
   bytes are verified again** immediately before publication.
4. The dependency stage is prepared for the stated mode.
5. The state root and the three records are published.
6. The container is published and then read back and re-validated. After all
   caller hooks, the complete dependency tree (without workload skip names) is
   hashed again and must match both the prepared identity and persisted companion.
   A separate physical workspace check uses no skip-name exemptions: outside the
   permitted top-level dependency directory, only declared workload files and
   their parent directories may exist. Mode `none` rejects `node_modules` of any
   filesystem kind; undeclared `.git`, `dist`, nested generated names, links and
   special entries are refused without following foreign link targets.
   Each successfully published state record and its storage registry are tracked
   incrementally, so a later state-publication failure can retire owned bytes
   without adopting foreign entries.
7. On any failure, only material this call provably created is removed. Material
   it did not create is left exactly where it was found. Material it cannot
   remove is disclosed on `CLEANUP_FAILED` rather than destroyed.

A destination that already exists is refused with `OUTPUT_EXISTS` — never
reused, never merged into, never renamed over.

## Persisted records

One sealed C1 `RunManifest` plus two companion records, all written through the
accepted storage layer as immutable, each under its own storage identity:

| Record | Identity |
| --- | --- |
| run record | `INIT_STATE_KIND` and the manifest id |
| dependency companion | `INIT_STATE_KIND` and `<manifestId>:dependencies` |
| export companion | `INIT_STATE_KIND` and `<manifestId>:export` |

- The run record **is** the sealed manifest. The dependency companion carries
  the dependency identity and metadata, and the export companion the workload
  identity; those live in their own hashed records because the C1 schema has no
  field for them and none was invented.
- The dependency metadata written by the preparer sits under the state root,
  reported at `state.dependencyMetadata` relative to that root.
- No field is added to the persisted `RunManifest`, and no field is restated in
  it under a second name. Bindings appear once, under `bindings.tooling`,
  `bindings.challenge`, and `bindings.evaluator`.
- Records are immutable. Replacing one through the storage layer fails; there is
  no in-place update path.

## Errors

Every refusal carries one machine-readable code. `InitError` exposes it as
`error.code`, and its `message` already begins with that code followed by `": "`
— so a reporter prints the message as it stands and must not prepend the code
again. Details are on `error.details`; a rollback may add
`error.rolledBackTo.removed` (an array of paths), and an incomplete rollback adds
`error.cleanup`.

`INIT_ERROR_CODES` has 21 codes.

| Code | It means |
| --- | --- |
| `INVALID_ARGUMENT` | The request is missing or is not a plain object. |
| `INVALID_OPTION` | An option has the wrong type or an unrecognised field. |
| `OPTION_REQUIRED` | A required option was not supplied. |
| `INVALID_ROOT` | A root is not an absolute host path. |
| `ROOT_NOT_FOUND` | An explicit root does not exist or is not a directory. |
| `LINK_OR_SPECIAL` | A path component is a symbolic link or a special file. |
| `ROOTS_OVERLAP` | The output would equal, contain, or sit inside a protected or owned root. |
| `DEPENDENCY_MODE_INVALID` | The mode is not one of the three declared modes. |
| `DEPENDENCY_MODE_MISMATCH` | Dependency options do not match the stated mode. |
| `IDENTITY_INVALID` | A supplied identity failed the accepted contract validation. |
| `IDENTITY_COLLISION` | A run or identity identifier collides with another. |
| `CEILING_EXCEEDED` | A ceiling exceeds the ceiling the challenge identity binds. |
| `DOMAIN_CONFLATION` | A version or digest was used in the wrong identity domain. |
| `OUTPUT_EXISTS` | The destination exists, or a concurrent writer reserved it first. |
| `OUTPUT_UNUSABLE` | The output parent is missing, is a file, or refused the create. |
| `PUBLICATION_INVALID` | A published container failed read-back verification. |
| `STATE_WRITE_FAILED` | A state record could not be written or read back. |
| `DEPENDENCY_RESULT_INVALID` | An accepted dependency returned an unrecordable shape. |
| `INIT_FAILED_ROLLED_BACK` | The call failed and its own material is gone again. |
| `CLEANUP_FAILED` | Material this call created could not be removed and is disclosed. |
| `INTERNAL` | A failure this module cannot attribute to a named refusal. |

### Errors from the collaborators

The seam does not relabel a collaborator's verdict. A dependency refusal can
therefore surface as the preparer's own error with its own codes, and a
workload-mismatch refusal as the exporter's own error with its own codes. A
caller that must classify every failure should switch on `error.code` and treat
an unrecognised code as a failure rather than as success, and should not assume
that every error is an `InitError`.

## Security boundary and honest limits

- **Explicit roots only.** No root, identity, version, model, provider, or
  configuration is inferred from the environment, from configuration, or from a
  parent directory. There is no `process.env` read and no process spawn.
- **Protected roots are refused.** An output that equals, contains, or sits
  inside a source, owner, or evaluator root is rejected before any write. Native
  absolute root spellings reject dot segments, controls and unsupported aliases;
  redundant separators are normalized before comparisons. Every existing output
  ancestor is inspected for links/junctions before the first directory is created.
- **Owner and evaluator roots never enter the workspace.** The exported workload
  is exactly the published file set — the released exporter pins its count — and
  the boundary roots are excluded from it by contract.
- **Links and special files are refused**, along with path traversal and
  case-only name collisions.
- **The workload file count is the contract.** A published workload that does
  not match the expected published file set is refused, so a partial or
  over-broad publish cannot be reported as success.
- **This is cooperative validation, not adversarial containment.** Byte and
  identity checks are re-run before publication and after it, but a cooperating
  process that shares the filesystem can still race them, and the module claims
  no protection against a hostile process, privilege separation, power loss, or
  atomic-visibility guarantees. The manifest's security model is recorded as
  stated, or `UNSPECIFIED`; the accepted model list is re-exported as
  `INIT_SECURITY_MODELS` rather than restated here, so it cannot drift from the
  validator that judges the same field. Choosing a stronger model is deployment
  work, not something this module can assert by itself.
- **Two hash domains.** See the warning above; mixing them is the single easiest
  way to corrupt run attribution.
- **Immutable after publication.** Correcting a published record means a new run,
  not an edit.

## Command-line handler

`cli/init.mjs` is a thin handler that parses a command line, forwards the whole
operation to `initialiseRun`, and reports the outcome. It owns no policy: the
API's verdict is printed with the API's own code, and a collaborator's verdict
keeps the code its author gave it.

This section documents that standalone handler only. For the current checkout
command line, whose `init` command takes flags only (no positional operand) and
states the manual harness explicitly, see [CLI.md](CLI.md).

### Implemented options

One positional argument is required: the output root.

| Option | Purpose |
| --- | --- |
| `--architecture-id <id>` | The run's architecture domain. |
| `--dependency-mode none\|prepared\|install` | The dependency mode. Unstated means `none`. |
| `--prepared-root <path>` | Prepared mode: the cache to copy from. |
| `--source-root <path>` | The definition root (prepared and install modes). |
| `--scratch-root <path>` | Install mode: the private staging root. |
| `--npm-executable <path>` | Install mode: the package manager to use. |
| `--expected-dependency-digest <hex>` | Provenance expectation for the dependencies. |
| `--help` | Print the usage contract and exit successfully. |

The remaining run facts are **not** flags yet. A caller states them
through `runInit({ …, statement })`, whose accepted keys are
`INITIALIZABLE_STATEMENT_KEYS`.

`--dependency-mode` is intentionally the only place a default appears: the parser
reports only what was actually stated, and the handler applies "no mode means
`none`" once, where a command line becomes a request.

### Refused options

`UNIMPLEMENTED_OPTIONS` lists 15 option names the eventual product CLI will need.
Passing one exits with `CLI_ERROR_CODES.UNKNOWN_OPTION` and status `2`, and
points at `--help`. They are refused by name rather than silently ignored, so
the implemented boundary is machine-readable and cannot widen by accident.

### Exit statuses and handler codes

`CLI_EXIT_CODES` is `{ SUCCESS: 0, FAILURE: 1, USAGE: 2 }`. `2` means the request
was unusable before anything was attempted; `1` means the API refused or failed.
The handler never exits `0` without a result.

`CLI_ERROR_CODES` is `USAGE`, `UNKNOWN_OPTION`, `DUPLICATE_OPTION`,
`OPTION_VALUE_MISSING`, `OPTION_VALUE_INVALID`, `INPUT_INVALID`. Like `InitError`,
a `CliError` message already begins with its code.

On success `main` prints the `summariseResult(result)` object: status, output,
workspace and state roots, workload digest and file count, dependency mode and
digest, manifest id, run id, and duration. It restates no digest it did not
receive and adds no claim.

### Handler boundary

`cli/init.mjs` does no packaging work: no `bin` declaration, no version
declaration, no package manifest discovery, no module-resolution strategy, no
host or runner access, and no publication. Full command-line identity,
packaging, and option coverage are later work.

## Install validation limits

The public install suites exercise orchestration end to end with a deterministic
no-network process adapter: locked bytes, private npm cache, dependency digest,
immutable run state, final roots and storage read-back. Separate validation on
Windows, Node 24.13.1 and npm 11.8.0 invokes actual npm `ci` through the bounded
native process adapter against one synthetic local `file:` dependency, using
`--offline`, a deny registry, disabled lifecycle scripts and an empty private cache.
It verifies an ordinary dependency tree is produced, inventoried and published,
source and staged locked bytes stay unchanged, and initializer companion/state
read-back agrees. `package-lock-only` is forced false for `ci` so packages are
actually installed. The local fixture's resolution is explicitly bound before
freezing its lockfile because dependency staging does not relocate relative local
inputs. Existing npm-option warnings are recorded; generalized local-resolution
portability, networked benchmark installation and other operating systems are
not qualified by this fixture.
An actual install is opt-in and may require network access; `offline: true`
refuses install rather than silently using a global cache. Use an explicit
compatible prepared cache for offline operation.

The helper treats `node_modules` and its isolated `.npm-cache` as declared
process-output surfaces. It captures their ownership once after the process
adapter settles, which requires the adapter's writers to have stopped; later
replacements are not re-adopted. Other staging entries remain foreign. Cleanup
requires recorded filesystem creation identities and ancestor proofs as well as
file digests; it removes only unchanged owned files and empty owned directories.
Changed, replaced or unrelated material remains with residue diagnostics.

Caller environment overrides are limited to the helper's runtime forwarding
allowlist. npm cache, user-config and global-config paths are reserved and forced
inside private staging; caller npm configuration, credential, proxy and registry
redirects are refused. Windows may add harmless profile variables during process
creation, so this is not a promise of a child environment containing no ambient
variables. No real user credential/configuration files were read for validation.

If metadata persistence fails after dependency publication, the helper reports
the verified retained, partial or unreadable publication fate and actual digest
instead of implying that no dependency bytes were committed. These are cooperative
filesystem guarantees, not adversarial OS containment or atomic visibility.
Initialization is never reported successful when cleanup or integrity checks fail.

## Scope boundary

In scope today: one command line plus the API entry points; explicit `none`,
`prepared` and `install` orchestration; the sealed run record and its two companions.

Out of scope, and not implied by anything above: the packaged product CLI, run
execution, freezing a submission, evaluation, scoring and reporting, packaging
and release, and any hosted service.

## Testing and the public boundary

The executable specification includes `tests/initialization/init.test.mjs` and
its sibling acceptance and helper suites. Set `BENCHBOARD_TEST_TMP` (or
`BENCHBOARD_TEST_SCRATCH_ROOT`) to an **absolute**, explicitly contained scratch
root; the suites create and remove their own unique subdirectories there. Current
project validation and final review runs require this explicit contained setting.
Without either variable, the public suites use their repository-contained ignored
test scratch fallback. They do not fall back to an operating-system-temporary or
sibling project directory, and no shipped core or CLI module reads either variable.

Running that fixture activity is product-contract testing. It does not seed,
run, or evaluate a benchmark participant or a calibration run.

Nothing in `packages/core/init.mjs` or `cli/init.mjs` references private
instructions, run history, a participant submission, evaluator-internal data,
credentials, or a developer-specific host path. Every path the public surface
accepts is supplied by the caller.
