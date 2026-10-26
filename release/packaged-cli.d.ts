// Declarations for release/packaged-cli.mjs.
// Runtime behavior is defined by that module; these types describe its public surface.

/**
 * Synchronous synthetic build-time renderer for the packaged CLI identity
 * loader. The release profile is validated first (S1), so ReleaseProfileError
 * and native module-load errors propagate unchanged; a profile other than
 * the synthetic one that is refused there surfaces earlier from the S1
 * validator with ReleaseProfileError. A participant profile accepted by S1 is
 * refused here with TypeError. After S1, the descriptor input must be
 * a Uint8Array (Buffer instances are acceptable) of at most 2097152 bytes,
 * otherwise TypeError. The captured bytes are decoded as UTF-8 and parsed,
 * so JSON parse failures surface as SyntaxError; a descriptor header with
 * kind benchboard.cli.synthetic-installation.v1, schemaVersion 1.0.0 and
 * authorization synthetic-only is required there, otherwise TypeError. The
 * fixed template module URL relative to this module is read, with native
 * read errors passing through, and a non-unique pin marker in the template
 * raises an ordinary Error.
 *
 * Only the descriptor header is checked here; the full descriptor contents
 * are validated later by the generated loader when it runs. Returns a fresh
 * Uint8Array (currently a Buffer subtype) of mutable generated loader bytes
 * in which the fixed template's descriptor-pin constant is replaced by the
 * SHA-256 digest of the exact captured descriptor bytes. There is no caller
 * root or template option. Rendering is a build-time construction relative
 * to the generated code, not a signature, authenticity or builder assertion,
 * a runtime bypass, or an approval of arbitrary code or runtime behavior.
 */
export declare function renderSyntheticCliLoader(profile: unknown, descriptorBytes: Uint8Array): Uint8Array;
