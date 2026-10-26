import fixture from './fixtures.json';
import {
  Issue,
  Activity,
  State,
  statuses,
  priorities,
  assignees,
} from './types';
import { normalizeLabels } from './labels';
export const fresh = (): State => structuredClone(fixture) as State;
const validIssue = (x: unknown): x is Issue => {
  if (!x || typeof x !== 'object') return false;
  const i = x as Issue;
  return (
    typeof i.id === 'string' &&
    !!i.id &&
    typeof i.title === 'string' &&
    !!i.title.trim() &&
    typeof i.description === 'string' &&
    statuses.includes(i.status) &&
    priorities.includes(i.priority) &&
    typeof i.assignee === 'string' &&
    (i.assignee === '' || assignees.includes(i.assignee)) &&
    Array.isArray(i.labels) &&
    i.labels.every((l) => typeof l === 'string') &&
    Number.isInteger(i.order) &&
    i.order >= 0
  );
};
const validActivity = (x: unknown): x is Activity => {
  if (!x || typeof x !== 'object') return false;
  const e = x as Activity;
  return (
    typeof e.id === 'string' &&
    typeof e.issueId === 'string' &&
    typeof e.message === 'string' &&
    typeof e.timestamp === 'string' &&
    Number.isFinite(Date.parse(e.timestamp))
  );
};
export function load(): State {
  try {
    const raw = localStorage.getItem('benchboard');
    if (!raw) return fresh();
    const data = JSON.parse(raw);
    const issues =
      data.version === 0
        ? data.tasks
        : data.version === 1
          ? data.issues
          : undefined;
    if (
      !Array.isArray(issues) ||
      !issues.every(validIssue) ||
      new Set(issues.map((i) => i.id)).size !== issues.length ||
      !Array.isArray(data.activity) ||
      !data.activity.every(validActivity)
    )
      return fresh();
    const next: State = {
      version: 1,
      issues: issues.map((i) => ({ ...i, labels: normalizeLabels(i.labels) })),
      activity: data.activity,
    };
    return next;
  } catch {
    return fresh();
  }
}
