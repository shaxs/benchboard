// Captain-owned explicit local JSON projections for the UI commands, never privacy-safe exports.
// They receive already-verified private facts: the parent's exact accepted report for the template
// path and the child's exact accepted report after a committed C5 publication. They do not validate,
// verify, authenticate or scrub; the command handler calls these only after a successful private
// template write or a committed child publication. No worksheet, reviewer identity, evidence
// bundle, configuration, error or root fields appear here. No report verification is performed
// here; the Captain provides accepted facts.
export function summariseUITemplate({ opened, parent, output }) {
  return Object.freeze({
    command: 'ui',
    mode: 'template',
    runId: opened.runId,
    manifestId: opened.manifestId,
    parentReportId: parent.reportId,
    parentReportDigest: parent.reportDigest,
    evaluationId: parent.evidence.evaluationId,
    snapshotId: parent.bindings.snapshotId,
    output,
    worksheetComplete: false,
    humanReview: 'NOT_REVIEWED',
    humanUI: null,
    quality: null,
  });
}

export function summariseUIAttachment({ opened, parent, child }) {
  return Object.freeze({
    command: 'ui',
    mode: 'attach',
    runId: opened.runId,
    manifestId: opened.manifestId,
    parentReportId: parent.reportId,
    parentReportDigest: parent.reportDigest,
    reportId: child.reportId,
    reportDigest: child.reportDigest,
    evaluationId: child.evidence.evaluationId,
    snapshotId: child.bindings.snapshotId,
    humanReview: child.execution.humanReview,
    automated: child.quality.automated,
    humanUI: child.quality.humanUI,
    quality: child.quality.quality,
  });
}
