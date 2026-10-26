// Optional DSH adapter scaffold (C7a.S8.T1). Pure frozen metadata only: no runtime
// integration, telemetry, control, supervision, configuration or side effects.
// The peer package "@benchboard/synthetic-tooling" is declared optional in package.json.

export const adapterScaffold = Object.freeze({
  schemaVersion: '1.0.0',
  kind: 'AdapterPackageScaffold',
  adapter: 'dsh',
  status: 'scaffold-only',
  compatibleTooling: Object.freeze({
    name: '@benchboard/synthetic-tooling',
    version: '0.0.0-synthetic',
  }),
  capabilities: Object.freeze({
    runtimeIntegration: false,
    telemetry: false,
    executionAuthority: false,
    review: false,
    supervision: false,
    certification: false,
  }),
});
