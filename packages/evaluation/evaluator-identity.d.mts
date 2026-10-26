export interface DigestEntry { readonly path: string; readonly bytes: number; readonly sha256: string }
export interface InstalledEvaluatorIdentity {
  readonly evaluatorVersion: string; readonly scoringVersion: string; readonly hashAlgorithm: 'benchboard-sha256-tree-v1';
  readonly semanticManifest: readonly DigestEntry[]; readonly semanticDigest: string;
  readonly packageManifest: readonly DigestEntry[]; readonly packageDigest: string;
  readonly originalCandidate: Readonly<{ evaluator: string; scoring: string }>;
}
/** Internal test roots only. Public evaluation always uses installed assets. */
export declare function computeEvaluatorIdentity(options?: { root?: string; packageRoot?: string; lineage?: Readonly<{ candidateVersion: string; evaluator: string; scoring: string }> }): InstalledEvaluatorIdentity;
