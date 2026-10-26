import {
  assignees,
  Filters,
  priorities,
  statuses,
  statusNames,
} from '../types';
export default function FilterBar({
  filters,
  knownLabels,
  filter,
  clear,
}: {
  filters: Filters;
  knownLabels: string[];
  filter: (key: keyof Filters, value: string) => void;
  clear: () => void;
}) {
  return (
    <section className="toolbar" aria-label="Search and filters">
      <input
        aria-label="Search issues"
        placeholder="Search issues…"
        value={filters.query}
        onChange={(e) => filter('query', e.target.value)}
      />
      <select
        aria-label="Filter priority"
        value={filters.priority}
        onChange={(e) => filter('priority', e.target.value)}
      >
        <option value="">All priorities</option>
        {priorities.map((p) => (
          <option key={p}>{p}</option>
        ))}
      </select>
      <select
        aria-label="Filter assignee"
        value={filters.assignee}
        onChange={(e) => filter('assignee', e.target.value)}
      >
        <option value="">All assignees</option>
        {[...assignees, 'Unassigned'].map((a) => (
          <option key={a}>{a}</option>
        ))}
      </select>
      <select
        aria-label="Filter label"
        value={filters.label}
        onChange={(e) => filter('label', e.target.value)}
      >
        <option value="">All labels</option>
        {knownLabels.map((l) => (
          <option key={l}>{l}</option>
        ))}
      </select>
      <select
        aria-label="Filter status"
        value={filters.status}
        onChange={(e) => filter('status', e.target.value)}
      >
        <option value="">All statuses</option>
        {statuses.map((s) => (
          <option value={s} key={s}>
            {statusNames[s]}
          </option>
        ))}
      </select>
      <button onClick={clear}>Clear filters</button>
    </section>
  );
}
