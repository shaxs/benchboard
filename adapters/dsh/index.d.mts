// Scaffold-only type declarations (C7a.S8.T3). Types mirror the exact frozen literal
// exported by adapters/dsh/index.mjs. No runtime behavior is declared: the export is a
// frozen metadata literal with no functions, options or callable surface.

export declare const adapterScaffold: {
  readonly schemaVersion: '1.0.0';
  readonly kind: 'AdapterPackageScaffold';
  readonly adapter: 'dsh';
  readonly status: 'scaffold-only';
  readonly compatibleTooling: Readonly<{
    readonly name: '@benchboard/synthetic-tooling';
    readonly version: '0.0.0-synthetic';
  }>;
  readonly capabilities: Readonly<{
    readonly runtimeIntegration: false;
    readonly telemetry: false;
    readonly executionAuthority: false;
    readonly review: false;
    readonly supervision: false;
    readonly certification: false;
  }>;
};
