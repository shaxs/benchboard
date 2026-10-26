import { Issue, statuses, priorities, assignees } from './types';
export function summary(issues: Issue[]) {
  const count = (key: 'status' | 'priority' | 'assignee', value: string) =>
    issues.filter((i) => i[key] === value).length;
  const completed = count('status', 'done');
  return {
    total: issues.length,
    completed,
    percentage: issues.length
      ? Math.round((completed / issues.length) * 100)
      : 0,
    status: Object.fromEntries(statuses.map((s) => [s, count('status', s)])),
    priority: Object.fromEntries(
      priorities.map((p) => [p, count('priority', p)]),
    ),
    assignee: Object.fromEntries(
      [...assignees, ''].map((a) => [a || 'Unassigned', count('assignee', a)]),
    ),
  };
}
