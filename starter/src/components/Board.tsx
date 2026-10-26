import type { Model } from '../model';
import { Issue, Status, statuses, statusNames } from '../types';
export default function Board({
  model,
  visible,
  open,
  refresh,
}: {
  model: Model;
  visible: Issue[];
  open: (id: string) => void;
  refresh: () => void;
}) {
  void model;
  void refresh;
  return (
    <div className="board">
      {statuses.map((status) => (
        <section
          className={'column ' + status}
          aria-label={statusNames[status]}
          key={status}
        >
          <h2>
            <span className="dot" />
            {statusNames[status]}
            <span className="count">
              {visible.filter((i) => i.status === status).length}
            </span>
          </h2>
          <div className="cards">
            {visible
              .filter((i) => i.status === status)
              .sort((a, b) => a.order - b.order)
              .map((i) => (
                <article key={i.id} className="card" data-issue-id={i.id}>
                  <button
                    className="card-open"
                    aria-label={i.id + ' ' + i.title}
                    onClick={() => open(i.id)}
                  >
                    <div className="card-top">
                      <span className="issue-id">{i.id}</span>
                      <span className={'priority ' + i.priority.toLowerCase()}>
                        {i.priority}
                      </span>
                    </div>
                    <h3>{i.title}</h3>
                    <div className="tags">
                      {i.labels.map((l) => (
                        <span key={l}>{l}</span>
                      ))}
                    </div>
                    <div className="assignee">
                      <span className="avatar">
                        {i.assignee
                          ? i.assignee
                              .split(' ')
                              .map((s) => s[0])
                              .join('')
                          : '—'}
                      </span>
                      {i.assignee || 'Unassigned'}
                    </div>
                  </button>
                  <select
                    disabled
                    className="quick-move"
                    aria-label={'Move ' + i.id}
                    value={i.status}
                    onChange={(e) => {
                      model.move(i.id, e.target.value as Status);
                      refresh();
                    }}
                  >
                    {statuses.map((s) => (
                      <option key={s} value={s}>
                        {statusNames[s]}
                      </option>
                    ))}
                  </select>
                </article>
              ))}
          </div>
          {!visible.some((i) => i.status === status) && (
            <p className="empty">No issues here</p>
          )}
        </section>
      ))}
    </div>
  );
}
