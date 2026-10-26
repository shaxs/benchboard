// CLI-side content delegate for the two safe export formats. It takes a Report, builds the safe
// export projection through the Captain-owned export-contract boundary exactly once, and renders
// both formats through the accepted C5 renderers. Per its task packet it performs no serialization
// of the raw report, no filesystem or configuration access, no privacy scrubber of its own (the
// projection boundary in packages/results/export-contract.mjs is the privacy boundary), and no
// storage or destination policy; the writer and revalidation belong to the Captain. Errors thrown
// by the accepted C5 boundaries propagate unchanged.
import { createExportProjection } from '../packages/results/export-contract.mjs';
import { renderReportJSON, renderReportText } from '../packages/results/exports.mjs';

/**
 * Builds {json, text} for one accepted Report: the safe projection from createExportProjection,
 * rendered by renderReportJSON and renderReportText. The result object is frozen and carries the
 * two string fields; the input report is read, never mutated.
 */
export function exportContentOf(report) {
  const projection = createExportProjection(report);
  return Object.freeze({ json: renderReportJSON(projection), text: renderReportText(projection) });
}
