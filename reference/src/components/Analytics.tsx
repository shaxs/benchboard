import type { summary } from '../model';
import { Status, statusNames } from '../types';
export default function Analytics({
  stats,
}: {
  stats: ReturnType<typeof summary>;
}) {
  return (
    <section className="analytics" aria-label="Analytics">
      <div>
        <span>Total issues</span>
        <output aria-label="Total issues">{stats.total}</output>
      </div>
      <div>
        <span>Completed</span>
        <output aria-label="Completed issues">{stats.completed}</output>
      </div>
      <div>
        <span>Completion</span>
        <output aria-label="Completion percentage">{stats.percentage}%</output>
        <progress value={stats.percentage} max="100" />
      </div>
      <details>
        <summary>Workload breakdown</summary>
        <div className="breakdown">
          {Object.entries(stats.status).map(([s, n]) => (
            <p key={s}>
              {statusNames[s as Status]}{' '}
              <output aria-label={'Count ' + statusNames[s as Status]}>
                {n}
              </output>
            </p>
          ))}
          {Object.entries(stats.priority).map(([s, n]) => (
            <p key={s}>
              {s} <output aria-label={'Count ' + s}>{n}</output>
            </p>
          ))}
          {Object.entries(stats.assignee).map(([s, n]) => (
            <p key={s}>
              {s} <output aria-label={'Count ' + s}>{n}</output>
            </p>
          ))}
        </div>
      </details>
    </section>
  );
}
