// Optional AI judge for the 20-point UI rubric. Advisory only: its scores are saved beside the
// run and never attached as the human review the report's humanUI requires.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { uiCaps } from '../evaluator/score.mjs';
import { spawnPlanFor, HarnessError } from './harness-profiles.mjs';
import { runAgentProcess } from './agent-process.mjs';

const CATEGORY_TEXT = Object.freeze({
  polish: 'overall polish',
  hierarchy: 'information hierarchy',
  board: 'cards and board',
  drawer: 'issue drawer',
  feedback: 'feedback and states',
  responsive: 'responsive behaviour across the three widths',
  consistency: 'visual consistency',
});

export function judgePrompt(images) {
  const categories = Object.entries(uiCaps).map(([key, cap]) => `${key} (0-${cap}): ${CATEGORY_TEXT[key] ?? key}`).join('; ');
  const files = images.map(image => `${path.basename(image)}`).join(', ');
  return [
    'You are reviewing the visual UI quality of an issue-board web app. The attached screenshots are',
    'the unchanged STARTER app and the SUBMISSION built from it, each at widths 1440, 1024 and 768',
    `and in two views (board, open issue drawer). Files: ${files}.`,
    'Score only visible product quality of the submission, and award positive points in a category',
    'only for a concrete visible improvement over the starter; inherited presentation earns zero.',
    `Categories and maxima: ${categories}.`,
    'Reply with only one valid JSON object (double-quoted keys and strings), no prose and no code fence,',
    'with two members: scores, mapping each category key to an integer, and notes, mapping each',
    'category key to one sentence describing what you saw.',
  ].join(' ');
}

/** Validates the judge's JSON reply against the UI caps. Returns null when it is unusable. */
export function parseJudgeReply(text) {
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let value;
  try { value = JSON.parse(text.slice(start, end + 1)); } catch { return null; }
  if (!value?.scores || typeof value.scores !== 'object') return null;
  const scores = {}, notes = {};
  for (const [key, cap] of Object.entries(uiCaps)) {
    const score = value.scores[key];
    if (!Number.isInteger(score) || score < 0 || score > cap) return null;
    scores[key] = score;
    notes[key] = typeof value.notes?.[key] === 'string' ? value.notes[key].slice(0, 2000) : '';
  }
  return { scores, notes, total: Object.values(scores).reduce((sum, score) => sum + score, 0) };
}

/**
 * @returns {Promise<{kind:'AI_JUDGE_ADVISORY',model:string,harness:string,total:number,scores:object,notes:object}>}
 */
export async function runAiJudge({ profile, executable, major, model, screensRoot, evidence, outputRoot, env }) {
  if (!profile.judgeArgs) throw new HarnessError(`The ${profile.name} harness cannot run the AI judge; use --agent opencode or claude`);
  const images = evidence.map(entry => path.join(screensRoot, entry.artifactId));
  const prompt = judgePrompt(images);
  const args = profile.judgeArgs({ model, prompt, images, imageRoot: screensRoot, major });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bbjudge-'));
  try {
    const stdoutFile = path.join(outputRoot, 'ai-judge.stdout.log'), stderrFile = path.join(outputRoot, 'ai-judge.stderr.log');
    const outcome = await runAgentProcess(spawnPlanFor(executable, args, { env }), { cwd, env, stdoutFile, stderrFile, timeoutMs: 15 * 60000 });
    if (outcome.spawnError) throw new HarnessError(`AI judge could not start: ${outcome.spawnError}`);
    const parsed = parseJudgeReply(profile.judgeText(fs.readFileSync(stdoutFile, 'utf8')));
    if (!parsed) throw new HarnessError('AI judge reply was not valid rubric JSON; see ai-judge.stdout.log');
    return { kind: 'AI_JUDGE_ADVISORY', model, harness: profile.name, judgedAt: new Date().toISOString(), ...parsed };
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}
