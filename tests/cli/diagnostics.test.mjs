import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticOf, CommandError } from '../../cli/diagnostics.mjs';
import { InitError } from '../../packages/core/init.mjs';
import { LifecycleError } from '../../packages/core/lifecycle.mjs';
import { EvaluationInfrastructureError, EvaluationRefusalError } from '../../packages/evaluation/contracts.mjs';
import { EvaluationIntegrityError } from '../../packages/evaluation/bundle-contract.mjs';
import { DependencyError } from '../../packages/core/dependencies.mjs';
import { CliError } from '../../cli/init.mjs';
import { ReportIntegrityError } from '../../packages/results/report-contract.mjs';
import { MeasurementIntegrityError } from '../../packages/results/measurement-contract.mjs';
import { StorageError } from '../../packages/core/storage.mjs';
import { UIWorksheetError } from '../../packages/results/ui-contract.mjs';
import { ExportIntegrityError } from '../../packages/results/export-contract.mjs';

test('default diagnostics never expose arbitrary exception messages, stacks, codes or details', () => {
  const canary = 'PRIVATE_SENTINEL_endpoint_credential_path';
  for (const error of [new Error(canary), Object.assign(new Error(canary), { code: canary, details: canary }),
    new InitError('OUTPUT_EXISTS', canary), new InitError(canary, canary),
    new LifecycleError('PROVENANCE_MISMATCH', canary), new EvaluationRefusalError(canary, canary),
    new EvaluationInfrastructureError('browser', 'MISSING_PREREQUISITE', canary)]) {
    assert.ok(!JSON.stringify(diagnosticOf(error)).includes(canary));
  }
});
test('connected initialization maps each controlled dependency execution failure as infrastructure', () => {
  for (const code of ['NPM_SPAWN_FAILED', 'NPM_TIMEOUT', 'NPM_EXIT_NONZERO', 'NPM_OUTPUT_UNBOUNDED',
    'STAGING_FAILED', 'PUBLICATION_RETAINED', 'PUBLICATION_PARTIAL', 'CLEANUP_FAILED']) {
    const error = new DependencyError(code, 'private output must not leak');
    assert.equal(diagnosticOf(error).exitCode, 5, code);
    assert.equal(JSON.stringify(diagnosticOf(error)).includes('private'), false);
  }
});
test('connected adapters classify actual parser, missing-input and C4 integrity error vocabularies', () => {
  for (const [error, exit] of [
    [new CliError('OPTION_VALUE_INVALID', 'private'), 2],
    [new CliError('INPUT_INVALID', 'private'), 4],
    [new InitError('OPTION_REQUIRED', 'private'), 3],
    [new EvaluationIntegrityError('private'), 4],
    [Object.assign(new Error('private missing path'), { code: 'ENOENT' }), 3],
    [Object.assign(new Error('private inaccessible path'), { code: 'EACCES' }), 5],
  ]) assert.equal(diagnosticOf(error).exitCode, exit);
});
test('prepared prerequisite guidance names both required flags without copying raw error text', () => {
  for (const code of ['PREPARED_ROOT_REQUIRED', 'CACHE_PROVENANCE_REQUIRED', 'CACHE_LOCK_MISSING']) {
    const result = diagnosticOf(new DependencyError(code, 'PRIVATE_PREPARED_INPUT_CANARY'));
    assert.equal(result.exitCode, 3);
    assert.equal(result.code, 'CLI_STATE');
    assert.match(result.guidance, /--prepared-root/);
    assert.match(result.guidance, /--source-root/);
    assert.match(result.guidance, /compatible verified cache and lock provenance/);
    assert.match(result.guidance, /current command with --help/);
    assert.equal(result.guidance.includes('Check init --help'), false, 'shared reset/init guidance is command-neutral');
    assert.equal(JSON.stringify(result).includes('PRIVATE_PREPARED_INPUT_CANARY'), false);
  }
  for (const code of ['CACHE_LOCK_MISMATCH', 'CACHE_DIGEST_MISMATCH', 'DEPENDENCY_DIGEST_MISMATCH']) {
    assert.equal(diagnosticOf(new DependencyError(code, 'PRIVATE_MISMATCH_CANARY')).exitCode, 4, code);
  }
});
test('stable categories preserve usage/state/safety/infrastructure/cancellation distinctions', () => {
  for (const [error, exit] of [[new CommandError('usage'), 2], [new InitError('OUTPUT_EXISTS', 'private'), 3],
    [new LifecycleError('STORAGE_REFUSED', 'private', { storageCode: 'ERR_STORAGE_LOCK_CONFLICT' }), 3],
    [new LifecycleError('PROVENANCE_MISMATCH', 'private'), 4], [new Error('private'), 5],
    [new EvaluationInfrastructureError('build', 'CANCELLED', 'private'), 130]]) {
    assert.equal(diagnosticOf(error).exitCode, exit);
  }
});
test('evaluation report and measurement integrity errors remain private-safe refusals, not infrastructure', () => {
  for (const error of [new ReportIntegrityError('PRIVATE_REPORT_CANARY'), new MeasurementIntegrityError('PRIVATE_MEASUREMENT_CANARY')]) {
    const diagnostic = diagnosticOf(error);
    assert.equal(diagnostic.exitCode, 4);
    assert.equal(diagnostic.code, 'CLI_INTEGRITY');
    assert.equal(JSON.stringify(diagnostic).includes('PRIVATE_'), false);
  }
});
test('actual C1 immutable publication IO failures are infrastructure rather than integrity accusations', () => {
  for (const code of ['ERR_STORAGE_PUBLISH_FAILED', 'ERR_STORAGE_PUBLISH_UNSUPPORTED']) {
    const diagnostic = diagnosticOf(new StorageError(code, 'PRIVATE_STORAGE_PUBLICATION_CANARY'));
    assert.equal(diagnostic.exitCode, 5);
    assert.equal(JSON.stringify(diagnostic).includes('PRIVATE_'), false);
  }
});
test('worksheet metadata refusal stays integrity without exposing its private review or schema text', () => {
  const diagnostic = diagnosticOf(new UIWorksheetError('PRIVATE_WORKSHEET_REVIEWER_NARRATIVE_CANARY'));
  assert.equal(diagnostic.exitCode, 4);
  assert.equal(diagnostic.code, 'CLI_INTEGRITY');
  assert.equal(JSON.stringify(diagnostic).includes('PRIVATE_'), false);
});
test('safe export contract refusal is a controlled integrity error, never a raw report dump', () => {
  const diagnostic = diagnosticOf(new ExportIntegrityError());
  assert.equal(diagnostic.exitCode, 4);
  assert.equal(diagnostic.code, 'CLI_INTEGRITY');
  assert.equal(JSON.stringify(diagnostic).includes('Invalid safe export projection'), false);
});
test('a raw exclusive-directory collision stays infrastructure and never discloses a foreign destination', () => {
  const error = Object.assign(new Error('PRIVATE_EXPORT_RACE_PATH'), { code: 'EEXIST', path: 'PRIVATE_FOREIGN_DESTINATION' });
  const diagnostic = diagnosticOf(error);
  assert.equal(diagnostic.exitCode, 5);
  assert.equal(diagnostic.code, 'CLI_INFRASTRUCTURE');
  assert.equal(JSON.stringify(diagnostic).includes('PRIVATE_'), false);
});
