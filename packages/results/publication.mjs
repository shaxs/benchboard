// Public production-only API: no injected storage, callbacks, hooks or lock-stealing options.
import { saveReportWithStorageHooks, readPublishedReportInternal, attachUIReviewInternal } from './publication-runtime.mjs';
export const saveReport=request=>saveReportWithStorageHooks(request,undefined);
export const readPublishedReport=request=>readPublishedReportInternal(request);
export const attachUIReview=request=>attachUIReviewInternal(request);
