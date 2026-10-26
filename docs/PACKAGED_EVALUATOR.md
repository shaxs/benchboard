# Packaged evaluator identity and synthetic rendering

Two runtime modules make up the packaged-evaluator verification story:
[`../packages/evaluation/packaged-identity.mjs`](../packages/evaluation/packaged-identity.mjs)
verifies an installed, pinned copy, and
[`../release/packaged-evaluator.mjs`](../release/packaged-evaluator.mjs) renders
that pinned copy at build time. Profile metadata rules live in
[RELEASE_PROFILES.md](RELEASE_PROFILES.md); this guide describes how the two
modules relate and where their trust ends.

## Verification: selected domains and carried lineage

`verifyPackagedEvaluator()` takes no arguments and no options, resolves a fixed
installation root two levels above its own module URL, and reads only the fixed
`packages/evaluation/packaged-assets.json` descriptor plus the files and
directories it names. The semantic manifest covers the six evaluator semantic
files, the four canonical starter tooling files, and at least one
`starter/tests` and one `fixtures` file; the package manifest additionally
covers the installed verifier and descriptor bytes themselves, so the
descriptor does not list its own entries. Every selected byte is rechecked
before the result is returned. The selected semantic and wrapper domains are
not the historical evaluator whole-tree audit; other namespaces such as CLI
tooling, dependencies and starter sources sit outside these scopes and belong
to other boundaries. `originalCandidate` carries the declared, pinned
historical evaluator and scoring lineage (see RELEASE_PROFILES.md) rather than
being recomputed from the reduced tree. In an unprepared checkout the
descriptor pin is a placeholder constant, not a SHA-256 digest, so
verification refuses there by design: the existing checkout identity path and
its whole-tree checks remain the way to measure a checkout, and a packaged
run requires a prepared installation. All failures surface as
`PackagedEvaluatorError` (`ERR_PACKAGED_EVALUATOR_INTEGRITY`) with a fixed
message, and no verification detail escapes the error.

## Synthetic rendering and its trust limits

At build time `renderSyntheticEvaluatorVerifier(profile, descriptorBytes)`
validates the release profile against the rules in RELEASE_PROFILES.md, then
requires the synthetic profile and bounded descriptor bytes. It reads the
fixed verifier template, hashes the exact descriptor bytes, and changes only
the unique descriptor-pin constant line. Nothing is written by the renderer:
the caller installs the matching descriptor bytes adjacent to the copied
synthetic verifier.

The compiled pin does one job: it detects descriptor substitution relative to
that generated verifier. It is not publisher authentication, and it does not
attest a license or exposure approval, arbitrary builder assertions, or
changes to the verifier code and trusted runtime themselves. Rendering is an
explicit build-time construction, not a runtime caller bypass; the generated
verifier accepts no real release profile. File checks are cooperative
integrity checks, not an atomic sandbox or power-loss guarantee.

No automatic production dispatch of the packaged evaluation exists yet; the
checkout paths above remain unchanged, and wiring an installed workflow is a
later, separate decision.
