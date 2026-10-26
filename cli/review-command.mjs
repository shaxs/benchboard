// `review`: human UI scoring for a finished `run` folder without handling any files. It serves a
// loopback-only page with the twelve screenshots side by side, builds the bound worksheet from the
// form and attaches it through the existing `ui` command. With --ai-judge it runs the judge instead.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { uiCaps } from '../evaluator/score.mjs';
import { validateUIWorksheetFacts } from '../packages/results/ui-validation.mjs';
import { CommandError } from './command-error.mjs';
import { uiCommand } from './ui-command.mjs';
import { exportCommand } from './export-command.mjs';
import { RUN_LAYOUT, RunFailure } from './run-command.mjs';
import { WIDTHS, VIEWS, artifactIdOf, worksheetEvidence } from './screenshots.mjs';
import { HarnessError, harnessProfile, resolveExecutable } from './harness-profiles.mjs';

const CATEGORY_LABELS = Object.freeze({
  polish: 'Overall polish', hierarchy: 'Information hierarchy', board: 'Cards / board', drawer: 'Issue drawer',
  feedback: 'Feedback and states', responsive: 'Responsive behaviour', consistency: 'Consistency',
});
const progress = text => process.stderr.write(`benchboard review: ${text}\n`);
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');

function loadRun(dirOption) {
  const dir = path.resolve(dirOption);
  const summaryFile = path.join(dir, RUN_LAYOUT.summary);
  let summary;
  try { summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8')); }
  catch { throw new RunFailure(`${summaryFile} was not found; review needs a folder made by benchboard run`); }
  if (summary.status !== 'SCORED' || !summary.evaluation) throw new RunFailure('This run has no automated score yet, so there is nothing to review');
  if (!summary.screenshots?.evidence) throw new RunFailure('This run has no screenshots; the review page needs them');
  return { dir, summary, summaryFile };
}

/** Builds the bound worksheet from the blank template and the submitted form. Pure. */
export function worksheetFrom(template, evidence, form, { reviewId, reviewedAt }) {
  const scores = {}, notes = {}, improvements = {};
  for (const key of Object.keys(uiCaps)) {
    scores[key] = Number(form.scores?.[key]);
    notes[key] = String(form.notes?.[key] ?? '').trim();
    const improvement = form.improvements?.[key];
    if (scores[key] > 0 && improvement) {
      const [width, view] = String(improvement.pair ?? '').split(':');
      improvements[key] = { description: String(improvement.description ?? '').trim(),
        starterArtifactId: artifactIdOf('starter', width, view), submissionArtifactId: artifactIdOf('submission', width, view) };
    }
  }
  return { ...template, reviewId, reviewer: String(form.reviewer ?? '').trim(), reviewedAt, baselineCompared: true,
    evidence: worksheetEvidence(evidence), scores, notes, improvements };
}

function pageHtml({ summary, token }) {
  const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const pairs = WIDTHS.flatMap(width => VIEWS.map(view => ({ width, view })));
  const gallery = pairs.map(({ width, view }) => `
    <section class="pair"><h3>${width}px · ${view}</h3><div class="shots">
      <figure><img loading="lazy" src="/screens/${artifactIdOf('starter', width, view)}?t=${token}" alt="starter ${width} ${view}"><figcaption>Starter</figcaption></figure>
      <figure><img loading="lazy" src="/screens/${artifactIdOf('submission', width, view)}?t=${token}" alt="submission ${width} ${view}"><figcaption>Submission</figcaption></figure>
    </div></section>`).join('');
  const options = pairs.map(({ width, view }) => `<option value="${width}:${view}">${width}px ${view}</option>`).join('');
  const categories = Object.entries(uiCaps).map(([key, cap]) => `
    <fieldset data-key="${key}"><legend>${esc(CATEGORY_LABELS[key] ?? key)} <span class="cap">0–${cap}</span></legend>
      <label>Score <select name="score">${Array.from({ length: cap + 1 }, (_, n) => `<option>${n}</option>`).join('')}</select></label>
      <label>What you saw <textarea name="note" rows="2" required minlength="3"></textarea></label>
      <div class="improvement" hidden>
        <label>What improved over the starter <textarea name="description" rows="2" minlength="12"></textarea></label>
        <label>Based on <select name="pair">${options}</select></label>
      </div>
    </fieldset>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>BenchBoard UI review</title><style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1d1d1f;--muted:#666;--line:#ddd;--accent:#2457d6}
@media (prefers-color-scheme:dark){:root{--bg:#151515;--fg:#eee;--muted:#aaa;--line:#333;--accent:#7aa2ff}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,sans-serif}
main{display:grid;grid-template-columns:minmax(0,1fr) 380px;gap:24px;padding:16px 24px;max-width:1800px;margin:auto}
@media (max-width:1000px){main{grid-template-columns:1fr}}
h1{font-size:20px;margin:0 0 4px}.muted{color:var(--muted)}
.pair h3{font-size:14px;margin:18px 0 6px}.shots{display:grid;grid-template-columns:1fr 1fr;gap:10px}
figure{margin:0}img{width:100%;border:1px solid var(--line);border-radius:6px;cursor:zoom-in}figcaption{font-size:12px;color:var(--muted)}
img.zoom{position:fixed;inset:2vh 2vw;width:96vw;height:96vh;object-fit:contain;background:var(--bg);z-index:9;cursor:zoom-out}
form{position:sticky;top:12px;align-self:start;max-height:calc(100vh - 24px);overflow:auto}
fieldset{border:1px solid var(--line);border-radius:8px;margin:0 0 10px;padding:8px 10px}legend{font-weight:600}.cap{color:var(--muted);font-weight:400}
label{display:block;margin:4px 0;font-size:13px}textarea,select,input{width:100%;box-sizing:border-box;font:inherit;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:4px 6px}
button{width:100%;padding:10px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer}
#result{margin-top:10px;white-space:pre-wrap}
</style></head><body><main>
<div><h1>UI review</h1><p class="muted">${esc([summary.agent, summary.model].filter(Boolean).join(' · '))} · automated ${esc(summary.automated)} / 80. Compare each submission with the starter. Positive points need a visible improvement over the starter. Click a screenshot to enlarge it.</p>${gallery}</div>
<form id="f"><label>Reviewer <input name="reviewer" required minlength="2" value="${esc(os.userInfo().username)}"></label>${categories}
<button type="submit">Save review</button><div id="result" role="status"></div></form>
</main><script>
document.querySelectorAll('img').forEach(i=>i.addEventListener('click',()=>i.classList.toggle('zoom')));
document.querySelectorAll('fieldset').forEach(f=>{const s=f.querySelector('[name=score]'),b=f.querySelector('.improvement');
  const sync=()=>{const on=Number(s.value)>0;b.hidden=!on;b.querySelector('textarea').required=on};s.addEventListener('change',sync);sync()});
document.getElementById('f').addEventListener('submit',async e=>{e.preventDefault();const r=document.getElementById('result');
  const form={reviewer:e.target.reviewer.value,scores:{},notes:{},improvements:{}};
  document.querySelectorAll('fieldset').forEach(f=>{const k=f.dataset.key;form.scores[k]=Number(f.querySelector('[name=score]').value);
    form.notes[k]=f.querySelector('[name=note]').value;if(form.scores[k]>0)form.improvements[k]={description:f.querySelector('[name=description]').value,pair:f.querySelector('[name=pair]').value}});
  r.textContent='Saving…';const res=await fetch('/submit?t=${token}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(form)});
  const body=await res.json();r.textContent=res.ok?'Saved. Human UI '+body.humanUI+' / 20, quality '+body.quality+' / 100. You can close this tab.':'Not saved: '+body.error;
  if(res.ok)e.target.querySelector('button').disabled=true});
</script></body></html>`;
}

function openBrowser(url) {
  const [file, args] = process.platform === 'win32' ? ['explorer.exe', [url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(file, args, { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref(); } catch { /* the URL is printed */ }
}

async function humanReview({ dir, summary, summaryFile }, { signal, open }) {
  const reviewRoot = path.join(dir, 'review');
  fs.mkdirSync(reviewRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:.]/g, '');
  const templateFile = path.join(reviewRoot, `template-${stamp}.json`);
  await uiCommand({ '--run': summary.runRoot, '--template': true, '--evaluation': summary.evaluation.evaluationId, '--output': templateFile });
  const template = JSON.parse(fs.readFileSync(templateFile, 'utf8'));
  const screensRoot = summary.screenshots.root, token = crypto.randomBytes(16).toString('hex');
  const allowed = new Set(summary.screenshots.evidence.map(entry => entry.artifactId));
  return await new Promise((resolve, reject) => {
    const server = http.createServer(async (request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1');
      const send = (status, type, body) => { response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }); response.end(body); };
      if (url.searchParams.get('t') !== token) return send(403, 'text/plain', 'forbidden');
      if (request.method === 'GET' && url.pathname === '/') return send(200, 'text/html; charset=utf-8', pageHtml({ summary, token }));
      const shot = /^\/screens\/([^/]+)$/.exec(url.pathname);
      if (request.method === 'GET' && shot && allowed.has(shot[1])) return send(200, 'image/png', fs.readFileSync(path.join(screensRoot, shot[1])));
      if (request.method !== 'POST' || url.pathname !== '/submit') return send(404, 'text/plain', 'not found');
      let body = '';
      for await (const chunk of request) { body += chunk; if (body.length > 1048576) return send(413, 'application/json', '{"error":"too large"}'); }
      try {
        const worksheet = worksheetFrom(template, summary.screenshots.evidence, JSON.parse(body),
          { reviewId: `review-${crypto.randomUUID()}`, reviewedAt: new Date().toISOString() });
        // The accepted validator's own message tells the reviewer what to fix.
        validateUIWorksheetFacts(worksheet, template);
        const worksheetFile = path.join(reviewRoot, `worksheet-${stamp}.json`);
        writeJson(worksheetFile, worksheet);
        const attached = await uiCommand({ '--run': summary.runRoot, '--input': worksheetFile, '--review-root': screensRoot });
        const exportDir = path.join(dir, `export-reviewed-${stamp}`);
        await exportCommand({ '--run': summary.runRoot, '--evaluation': summary.evaluation.evaluationId, '--report': attached.reportId, '--output': exportDir });
        const record = { reportId: attached.reportId, reviewer: worksheet.reviewer, reviewedAt: worksheet.reviewedAt, humanUI: attached.humanUI, quality: attached.quality, export: exportDir };
        summary.humanReviews = [...(summary.humanReviews ?? []), record];
        Object.assign(summary, { humanUI: attached.humanUI, quality: attached.quality });
        writeJson(summaryFile, summary);
        send(200, 'application/json', JSON.stringify(record));
        server.close();
        resolve(record);
      } catch (error) {
        send(400, 'application/json', JSON.stringify({ error: error?.name === 'UIWorksheetError' ? error.message : 'the review could not be attached; see the terminal' }));
        if (error?.name !== 'UIWorksheetError') progress(`attach failed: ${error?.message ?? error}`);
      }
    });
    signal?.addEventListener('abort', () => { server.close(); reject(new CommandError('cancelled')); }, { once: true });
    server.listen(0, '127.0.0.1', () => {
      const pageUrl = `http://127.0.0.1:${server.address().port}/?t=${token}`;
      progress(`review page: ${pageUrl}`);
      progress('waiting for you to save the review (Ctrl+C to stop)');
      if (open) openBrowser(pageUrl);
    });
  });
}

async function aiReview({ summary, summaryFile }, options) {
  const profile = harnessProfile(options['--agent'] ?? summary.agent);
  const env = { ...process.env };
  const executable = resolveExecutable(options['--agent-bin'] ?? profile.defaultBin ?? '', { env });
  if (!executable) throw new RunFailure(`${profile.name} was not found; pass --agent and --agent-bin`);
  const { runAiJudge } = await import('./ai-judge.mjs');
  progress(`AI judge (${options['--ai-judge']}) scoring the UI`);
  summary.aiJudge = await runAiJudge({ profile, executable, major: profile.probe(executable, env).major, model: options['--ai-judge'],
    screensRoot: summary.screenshots.root, evidence: summary.screenshots.evidence, outputRoot: path.join(summary.dir, RUN_LAYOUT.agent), env });
  writeJson(summaryFile, summary);
  return summary.aiJudge;
}

export async function reviewCommand(options, { signal } = {}) {
  if (signal?.aborted) throw new CommandError('cancelled');
  try {
    const loaded = loadRun(options['--dir']);
    if (options['--ai-judge'] !== undefined) {
      const judged = await aiReview(loaded, options);
      return Object.freeze({ command: 'review', mode: 'ai', aiUI: judged.total, scores: judged.scores, summary: loaded.summaryFile });
    }
    const record = await humanReview(loaded, { signal, open: options['--no-open'] !== true });
    return Object.freeze({ command: 'review', mode: 'human', ...record, summary: loaded.summaryFile });
  } catch (error) {
    if (error instanceof RunFailure || error instanceof HarnessError) {
      progress(error.message);
      throw new CommandError(error.category ?? 'state');
    }
    throw error;
  }
}
