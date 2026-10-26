// Declarations for release/packaged-evaluator.mjs.
// Runtime behavior is defined by that module; these types describe its public surface.

/**
 * Synchronous synthetic build-time renderer. The release profile is validated
 * first, so ReleaseProfileError and native module-load errors propagate; a
 * participant profile is refused with TypeError; owner-development and end-user-tooling
 * are refused earlier by the S1 validator with ReleaseProfileError. The descriptor
 * input must be a Uint8Array (Buffer instances are acceptable) of at most
 * 4194304 bytes, and a header with schemaVersion 1.0.0, kind
 * PackagedEvaluatorAssets and authorization synthetic-only is required;
 * otherwise TypeError. JSON parse failures surface as SyntaxError, and a fixed
 * template read failure or a non-unique template marker surfaces as a native
 * error or an ordinary Error.
 *
 * Returns a fresh Uint8Array of generated verifier module bytes in which the
 * fixed template's descriptor pin constant is replaced by the SHA-256 digest of
 * the exact descriptor bytes. The renderer validates the header but not the
 * full descriptor contents; the generated verifier performs that validation
 * when it runs. The function is a build-time construction, not a runtime
 * verification override, bypass or approval, and the generated verifier accepts
 * no real release profile.
 */
export declare function renderSyntheticEvaluatorVerifier(profile: unknown, descriptorBytes: Uint8Array): Uint8Array;
