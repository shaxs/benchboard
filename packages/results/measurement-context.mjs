// Captain-owned C3 source capture; no telemetry importer, actor engine or public runtime injection.
import { withRunTransaction } from '../core/lifecycle.mjs';
import { FREEZE_PROOF_KIND } from '../core/freeze.mjs';
import { canonicalJson, sha256Hex } from '../core/manifest.mjs';
import { measurementProjectionInput, validateNeutralTokenInput } from './measurement-contract.mjs';

const digest = value => sha256Hex(canonicalJson(value));
export async function buildMeasurementContext({selection,manifest,bindings,bundle,metrics,reportId}) {
  const tokens = validateNeutralTokenInput(metrics);
  const captured = await withRunTransaction({runRoot:selection.runRoot,runId:selection.runId,manifestId:selection.manifestId,expectedDigest:selection.expectedDigest}, async context => ({
    lifecycle: context.lifecycle,
    proof: await context.storage.read({relativePath:`freeze/${selection.snapshotId}.json`,kind:FREEZE_PROOF_KIND,id:`${selection.manifestId}:snapshot-proof:${selection.snapshotId}`}),
  }));
  const sources = [{kind:'lifecycle',digest:digest(captured.lifecycle),record:captured.lifecycle},{kind:'snapshot-proof',digest:digest(captured.proof),record:captured.proof}];
  if (bundle) sources.push({kind:'evaluation',digest:digest(bundle),recordId:bundle.evaluationId});
  if (tokens) sources.push({kind:'token-input',digest:digest(tokens),record:tokens});
  const configuration = captured.lifecycle?.declaration ?? {harness:manifest.harness,model:manifest.configuration.model??null,workerCount:null,executionMode:'MANUAL',declaredCeilingMinutes:manifest.declaredCeilingMinutes??null};
  const projection = measurementProjectionInput({reportId,bindings,configuration,provenance:{sources},evidence:{bundle,bundleDigest:bundle?digest(bundle):null,evaluationId:bundle?.evaluationId??null},quality:bundle?.score??null});
  return {sources,configuration,projection};
}
