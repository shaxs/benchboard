import { Issue, Filters } from './types';
export function select(issues: Issue[], f: Filters) {
  const query = f.query.trim().toLowerCase();
  return issues.filter((i) => {
    const checks = [
      !f.priority || i.priority === f.priority,
      !f.assignee ||
        (f.assignee === 'Unassigned' ? !i.assignee : i.assignee === f.assignee),
      !f.label || i.labels.includes(f.label),
      !f.status || i.status === f.status,
    ];
    return (
      ((!f.priority && !f.assignee && !f.label && !f.status) ||
        [
          f.priority && checks[0],
          f.assignee && checks[1],
          f.label && checks[2],
          f.status && checks[3],
        ].some(Boolean)) &&
      (!query ||
        [i.title, i.description, i.assignee, ...i.labels]
          .join(' ')
          .toLowerCase()
          .includes(query))
    );
  });
}
