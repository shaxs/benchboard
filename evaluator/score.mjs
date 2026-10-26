export const caps = {
  visible: 7,
  functional: 30,
  persistence: 10,
  edge: 5,
  integration: 15,
  code: 5,
  usefulTests: 5,
  hygiene: 3,
};
export const uiCaps = {
  polish: 5,
  hierarchy: 3,
  board: 3,
  drawer: 3,
  feedback: 2,
  responsive: 2,
  consistency: 2,
};
const fraction = (passed, total) =>
  total > 0 ? Math.min(1, Math.max(0, passed / total)) : 0;
export function score(evidence, ui = null) {
  const areas = { visible: 7 * fraction(evidence.visiblePassed, 17) };
  const expected = { functional: 13, persistence: 4, edge: 4, integration: 4 };
  const seen = new Set();
  for (const t of evidence.hidden) {
    const group = {
      F: ['functional', 13],
      P: ['persistence', 4],
      E: ['edge', 4],
      I: ['integration', 4],
    }[t.id?.[0]];
    if (
      !group ||
      !/^([FPEI])\d{2}$/.test(t.id) ||
      Number(t.id.slice(1)) < 1 ||
      Number(t.id.slice(1)) > group[1] ||
      t.area !== group[0]
    )
      throw Error('Unknown hidden property or area');
    if (seen.has(t.id)) throw Error('Duplicate hidden property');
    seen.add(t.id);
  }
  for (const [area, count] of Object.entries(expected)) {
    const tests = evidence.hidden.filter((t) => t.area === area);
    if (tests.length !== count)
      throw Error('Incomplete hidden evidence for ' + area);
    areas[area] =
      caps[area] *
      fraction(tests.filter((t) => t.passed === true).length, count);
  }
  areas.code =
    (evidence.typecheck === true ? 2 : 0) +
    (evidence.build === true ? 2 : 0) +
    (evidence.noSuppression === true ? 1 : 0);
  const mutations = new Set(evidence.usefulTests?.killedMutations || []);
  const valid = new Set([
    'storage-drop',
    'input-drop',
    'focus-drop',
    'label-case',
    'date-order',
  ]);
  if ([...mutations].some((x) => !valid.has(x)))
    throw Error('Unknown useful-test mutation');
  areas.usefulTests =
    evidence.usefulTests?.baselinePassed && evidence.usefulTests?.addedCount > 0
      ? Math.min(5, mutations.size)
      : 0;
  areas.hygiene = [
    'visibleIntact',
    'lockedDependencies',
    'noSecrets',
    'noDebugLogging',
    'noNetwork',
  ].reduce(
    (n, k) => n + (evidence.hygiene[k] === true ? caps.hygiene / 5 : 0),
    0,
  );
  for (const k of Object.keys(caps))
    if (!Number.isFinite(areas[k]) || areas[k] < 0 || areas[k] > caps[k])
      throw Error('Invalid category score');
  const automated = Number(
    Object.values(areas)
      .reduce((a, b) => a + b, 0)
      .toFixed(4),
  );
  let human = null;
  if (ui !== null) {
    if (!ui.reviewer || !ui.reviewedAt || !ui.evidence)
      throw Error('Human score needs review provenance');
    if (ui.baselineCompared !== true)
      throw Error(
        'Participant UI review must compare with the supplied starter baseline',
      );
    for (const [k, max] of Object.entries(uiCaps))
      if (
        !Number.isInteger(ui.scores[k]) ||
        ui.scores[k] < 0 ||
        ui.scores[k] > max
      )
        throw Error('UI score outside cap: ' + k);
    for (const k of Object.keys(uiCaps))
      if (ui.scores[k] > 0 && !ui.improvements?.[k])
        throw Error(
          'Positive UI points need participant improvement evidence: ' + k,
        );
    human = Object.values(uiCaps).reduce(
      (n, _, i) => n + ui.scores[Object.keys(uiCaps)[i]],
      0,
    );
  }
  return {
    automated,
    automatedMaximum: 80,
    areas,
    humanUI: human,
    humanMaximum: 20,
    quality: human === null ? null : Number((automated + human).toFixed(4)),
    qualityMaximum: 100,
    status: human === null ? 'HUMAN_REVIEW_PENDING' : 'SCORED',
  };
}
