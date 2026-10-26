/** Public manual lifecycle. Raw persistence belongs only to the internal command engine. */
import * as engine from './lifecycle-internal.mjs';
export { LIFECYCLE_ERROR_CODES, LIFECYCLE_MODULE_ID, LIFECYCLE_SCHEMA_VERSION, LIFECYCLE_STATE_KIND, LIFECYCLE_EVENT_KIND, LIFECYCLE_STATE_RELATIVE_PATH, LIFECYCLE_JOURNAL_DIRECTORY, RUN_MANIFEST_STATE_KEY, LIFECYCLE_DERIVED_STATE, LIFECYCLE_COMMITTED_STATES, LIFECYCLE_EVENT_KINDS, FREEZE_PRECONDITIONS, LIFECYCLE_TRANSITIONS, LIFECYCLE_EXECUTION_MODE, STOP_ASSURANCE, STOP_ENFORCED, LifecycleError, DEFAULT_CLOCK, readClockReading, elapsedBetween, startRun, stopRun, readRunLifecycle, reconcileRun, freezePreconditionFor, lifecycleStateDigestOf, lifecycleEventDigestOf, lifecycleCanonicalJson } from './lifecycle-internal.mjs';
function readOnlyStorage(storage) {
 const facade={root:storage.root};
 for(const name of ['read','list','inspect'])if(typeof storage[name]==='function')facade[name]=(...args)=>storage[name](...args);
 return Object.freeze(facade);
}
export async function openRun(request){return engine.openRun(request);}
export async function withRunTransaction(request,callback){if(typeof callback!=='function')return engine.withRunTransaction(request,callback);return engine.withRunTransaction(request,context=>{const safe=Object.freeze({...context,storage:readOnlyStorage(context.storage),get lifecycle(){return context.lifecycle;}});return callback(safe);});}
