import type { RefObject } from 'react';
import { newest } from '../model';
import {
  Activity,
  Issue,
  assignees,
  priorities,
  statuses,
  statusNames,
} from '../types';
export default function IssueDrawer({
  issue,
  activity,
  dialog,
  confirm,
  setConfirm,
  patch,
  close,
  remove,
}: {
  issue: Issue;
  activity: Activity[];
  dialog: RefObject<HTMLDivElement | null>;
  confirm: boolean;
  setConfirm: (value: boolean) => void;
  patch: (key: keyof Issue, value: unknown) => void;
  close: () => void;
  remove: () => void;
}) {
  return (
    <div className="overlay" onClick={close}>
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Issue details"
        className="drawer"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="drawer-head">
          <span>{issue.id}</span>
          <button onClick={close}>Close</button>
        </div>
        <h2>Issue details</h2>
        <label>
          Title
          <input
            aria-label="Title"
            key={issue.id + 'title' + issue.title}
            defaultValue={issue.title}
            onBlur={(e) => {
              patch('title', e.target.value);
              e.target.value = issue.title;
            }}
          />
        </label>
        <label>
          Description
          <textarea
            aria-label="Description"
            key={issue.id + 'description' + issue.description}
            defaultValue={issue.description}
            onBlur={(e) => patch('description', e.target.value)}
          />
        </label>
        <div className="fields">
          <label>
            Status
            <select
              aria-label="Status"
              value={issue.status}
              onChange={(e) => patch('status', e.target.value)}
            >
              {statuses.map((s) => (
                <option key={s} value={s}>
                  {statusNames[s]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Priority
            <select
              aria-label="Priority"
              value={issue.priority}
              onChange={(e) => patch('priority', e.target.value)}
            >
              {priorities.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </label>
          <label>
            Assignee
            <select
              aria-label="Assignee"
              value={issue.assignee}
              onChange={(e) => patch('assignee', e.target.value)}
            >
              <option value="">Unassigned</option>
              {assignees.map((a) => (
                <option key={a}>{a}</option>
              ))}
            </select>
          </label>
        </div>
        <label>
          Labels
          <input
            aria-label="Labels"
            key={issue.id + 'labels' + issue.labels.join(',')}
            defaultValue={issue.labels.join(', ')}
            onBlur={(e) => patch('labels', e.target.value.split(','))}
          />
        </label>
        <h3>Activity</h3>
        <ul aria-label="Activity" className="activity">
          {newest(activity.filter((e) => e.issueId === issue.id)).map((e) => (
            <li key={e.id}>
              <span>{e.message}</span>
              <time dateTime={e.timestamp}>
                {new Date(e.timestamp).toLocaleString()}
              </time>
            </li>
          ))}
        </ul>
        <div className="danger-zone">
          {confirm ? (
            <>
              <p>Delete this issue? This cannot be undone.</p>
              <button onClick={() => setConfirm(false)}>Cancel</button>
              <button className="danger" onClick={remove}>
                Confirm delete
              </button>
            </>
          ) : (
            <button className="danger" onClick={() => setConfirm(true)}>
              Delete issue
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
