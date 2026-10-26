// Default diagnostics deliberately never serialize collaborator messages or details.
import { InitError } from '../packages/core/init.mjs';
import { LifecycleError } from '../packages/core/lifecycle.mjs';
import { ResetError } from '../packages/core/reset.mjs';
import { StorageError } from '../packages/core/storage.mjs';
import { PathError } from '../packages/core/paths.mjs';
import { ContractValidationError } from '../packages/core/manifest.mjs';
import { ChallengeExportError } from '../packages/core/challenge-export.mjs';
import { DependencyError } from '../packages/core/dependencies.mjs';
import { EvaluationRefusalError, EvaluationInfrastructureError } from '../packages/evaluation/contracts.mjs';
import { EvaluationIntegrityError } from '../packages/evaluation/bundle-contract.mjs';
import { PublicationError } from '../packages/results/artifact-verification.mjs';
import { ReportIntegrityError } from '../packages/results/report-contract.mjs';
import { MeasurementIntegrityError } from '../packages/results/measurement-contract.mjs';
import { UIWorksheetError } from '../packages/results/ui-contract.mjs';
import { ExportIntegrityError } from '../packages/results/export-contract.mjs';
import { ArgumentError } from './arguments.mjs';
import { CommandError, CATEGORIES } from './command-error.mjs';
import { CliError } from './init.mjs';
export { CommandError } from './command-error.mjs';
const stateCodes = new Set(['NOT_FOUND', 'ROOT_NOT_FOUND', 'OUTPUT_EXISTS', 'OUTPUT_UNUSABLE',
  'STATE_TRANSITION_REFUSED', 'DECLARATION_ALREADY_BOUND', 'DECLARATION_INVALID', 'ATTESTATION_INVALID', 'RECOVERY_REQUIRED',
  'ERR_STORAGE_LOCK_CONFLICT', 'ERR_STORAGE_TARGET_EXISTS', 'ERR_STORAGE_DUPLICATE_IDENTITY', 'ERR_STORAGE_IMMUTABLE_REPLACEMENT',
  'RESET_OUTPUT_NOT_FRESH', 'RESET_OUTPUT_UNUSABLE', 'RESET_STATE_REFUSED', 'RESET_JOURNAL_INCOMPLETE',
  'PUBLICATION_DUPLICATE', 'PUBLICATION_INCOMPLETE', 'MISSING_PREREQUISITE', 'ERR_STORAGE_NOT_FOUND',
  'OPTION_REQUIRED', 'DEPENDENCY_MODE_MISMATCH', 'PREPARED_ROOT_REQUIRED', 'CACHE_PROVENANCE_REQUIRED',
  'CACHE_LOCK_MISSING', 'TARGET_EXISTS', 'TARGET_PRESENT', 'SCRATCH_ROOT_REQUIRED',
  'NPM_EXECUTABLE_REQUIRED', 'NPM_EXECUTABLE_NOT_FOUND', 'NPM_LOCKFILE_REQUIRED', 'NPM_LOCKFILE_MISSING']);
const infrastructureCodes = new Set(['INTERNAL', 'STATE_WRITE_FAILED', 'CLEANUP_FAILED', 'INIT_FAILED_ROLLED_BACK',
  'ERR_STORAGE_REGISTRY_UNAVAILABLE', 'ERR_STORAGE_WRITE_FAILED', 'RESET_INITIALISE_FAILED',
  'ERR_STORAGE_PUBLISH_FAILED', 'ERR_STORAGE_PUBLISH_UNSUPPORTED',
  'NPM_SPAWN_FAILED', 'NPM_TIMEOUT', 'NPM_EXIT_NONZERO', 'NPM_OUTPUT_UNBOUNDED',
  'STAGING_FAILED', 'PUBLICATION_RETAINED', 'PUBLICATION_PARTIAL', 'ERR_STORAGE_LOCK_UNAVAILABLE']);
const PREPARED_INPUT_DIAGNOSTIC = Object.freeze({
  ...CATEGORIES.state,
  guidance: 'Prepared mode requires --prepared-root and --source-root with compatible verified cache and lock provenance. Check the current command with --help; preserve retained state.',
});
export function diagnosticOf(error) {
  if (error instanceof CommandError) return CATEGORIES[error.category];
  if (error instanceof ArgumentError) return CATEGORIES.usage;
  if (error instanceof CliError) return CATEGORIES[error.code === 'INPUT_INVALID' ? 'integrity' : 'usage'];
  if (error instanceof EvaluationIntegrityError || error instanceof ReportIntegrityError || error instanceof MeasurementIntegrityError || error instanceof UIWorksheetError || error instanceof ExportIntegrityError) return CATEGORIES.integrity;
  if (error instanceof DependencyError && ['PREPARED_ROOT_REQUIRED', 'CACHE_PROVENANCE_REQUIRED', 'CACHE_LOCK_MISSING'].includes(error.code)) {
    return PREPARED_INPUT_DIAGNOSTIC;
  }
  if (error instanceof EvaluationInfrastructureError) return CATEGORIES[error.code === 'CANCELLED' ? 'cancelled' : 'infrastructure'];
  if (error instanceof InitError || error instanceof LifecycleError || error instanceof ResetError ||
      error instanceof StorageError || error instanceof DependencyError || error instanceof PublicationError) {
    if (stateCodes.has(error.code)) return CATEGORIES.state;
    if (infrastructureCodes.has(error.code)) return CATEGORIES.infrastructure;
    // Wrapped storage failures are not evidence of an integrity violation.
    if (['STORAGE_REFUSED', 'RESET_STORAGE_REFUSED'].includes(error.code)) {
      // C3 preserves only this controlled storage code, not an Error cause.
      if (stateCodes.has(error.details?.storageCode)) return CATEGORIES.state;
      const cause = error.details?.cause ?? error.cause;
      if (cause instanceof StorageError) return diagnosticOf(cause);
      return CATEGORIES.infrastructure;
    }
    return CATEGORIES.integrity;
  }
  if (error instanceof PathError || error instanceof ContractValidationError || error instanceof ChallengeExportError ||
      error instanceof EvaluationRefusalError) return CATEGORIES.integrity;
  // Raw bounded-file observations can report missing prerequisites before an
  // owning collaborator constructs its typed refusal; never expose their text.
  if (error instanceof Error && ['ENOENT', 'ENOTDIR'].includes(error.code)) return CATEGORIES.state;
  if (error instanceof Error && ['ELOOP', 'EISDIR'].includes(error.code)) return CATEGORIES.integrity;
  return CATEGORIES.infrastructure;
}
