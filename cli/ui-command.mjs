// Production C5 composition; all input, parent and filesystem policy stays in the Captain seams.
import { createId } from '../packages/core/identity.mjs';
import { createUIWorksheetTemplate } from '../packages/results/ui-worksheet.mjs';
import { attachUIReview } from '../packages/results/publication.mjs';
import { uiArgumentsOf } from './ui-arguments.mjs';
import { prepareUIContext } from './ui-context.mjs';
import { writePrivateTemplate } from './private-output.mjs';
import { summariseUITemplate, summariseUIAttachment } from './ui-summary.mjs';
import { CommandError } from './command-error.mjs';

export async function uiCommand(options, { signal } = {}) {
  if (signal?.aborted) throw new CommandError('cancelled');
  const parsed = uiArgumentsOf(options);
  const context = await prepareUIContext(parsed, options);
  if (signal?.aborted) throw new CommandError('cancelled');
  const { opened, parent } = context;
  if (context.mode === 'template') {
    const template = createUIWorksheetTemplate(parent);
    const output = writePrivateTemplate(context.output, template, context.protectedRoots);
    return summariseUITemplate({ opened, parent, output });
  }
  const child = await attachUIReview({ storeRoot: context.context.storeRoot, runRoot: opened.runRoot,
    evaluationRoot: context.evaluationRoot, parentReportId: parent.reportId,
    reportId: createId('report'), createdAt: new Date().toISOString(), worksheet: context.worksheet, reviewRoot: context.reviewRoot });
  // Core returns the actual committed child; a late signal never rolls it back or relabels it.
  return summariseUIAttachment({ opened, parent, child });
}
