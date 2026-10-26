import Analytics from './components/Analytics';
import FilterBar from './components/Filters';
import Board from './components/Board';
import IssueDrawer from './components/IssueDrawer';
import { useEffect, useRef, useState } from 'react';
import { Model, select } from './model';
import { Filters, Issue } from './types';
const empty: Filters = {
  query: '',
  priority: '',
  assignee: '',
  label: '',
  status: '',
};
export default function App() {
  const [model] = useState(() => new Model());
  const [, render] = useState(0);
  const [filters, setFilters] = useState(empty);
  const [selected, setSelected] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const issue = model.state.issues.find((i) => i.id === selected);
  const visible = select(model.state.issues, filters);
  const stats = model.stats;
  const refresh = () => render((n) => n + 1);
  const close = () => {
    setSelected(null);
    setConfirm(false);
    requestAnimationFrame(() => returnFocus.current?.focus());
  };
  const open = (id: string) => {
    returnFocus.current = document.activeElement as HTMLElement;
    setSelected(id);
    setConfirm(false);
  };
  useEffect(() => {
    if (!selected) return;
    dialog.current?.querySelector<HTMLElement>('button,input')?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
      if (e.key === 'Tab') {
        const els = Array.from(
          dialog.current?.querySelectorAll<HTMLElement>(
            'button,input,textarea,select',
          ) ?? [],
        ).filter((el) => !el.hasAttribute('disabled'));
        const first = els[0],
          last = els.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [selected]);
  const filter = (key: keyof Filters, value: string) =>
    setFilters((f) => ({ ...f, [key]: value }));
  const patch = (key: keyof Issue, value: unknown) => {
    if (issue) {
      model.patch(issue.id, { [key]: value });
      refresh();
    }
  };
  const knownLabels = [
    ...new Set(model.state.issues.flatMap((i) => i.labels)),
  ].sort();
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          B<span>BenchBoard</span>
        </div>
        <p className="workspace">ENGINEERING WORKSPACE</p>
        <div className="nav-current">Project board</div>
        <p className="sidebar-note">
          A calmer place to ship
          <br />
          meaningful work.
        </p>
        <div className="team">
          MC <span>Product engineering</span>
        </div>
      </aside>
      <main>
        <header>
          <div>
            <p className="eyebrow">WORKSPACE / PROJECTS</p>
            <h1>Platform experience</h1>
            <p className="subtitle">
              Small improvements. Better everyday workflows.
            </p>
          </div>
          <button
            className="primary"
            onClick={() => {
              const id = model.create();
              refresh();
              open(id);
            }}
          >
            Create issue
          </button>
        </header>
        <Analytics stats={stats} />
        <FilterBar
          filters={filters}
          knownLabels={knownLabels}
          filter={filter}
          clear={() => setFilters(empty)}
        />
        <Board model={model} visible={visible} open={open} refresh={refresh} />
        {!visible.length && (
          <p role="status" className="empty-project">
            {model.state.issues.length
              ? 'No matching issues. Try clearing filters.'
              : 'No issues yet. Create your first issue.'}
          </p>
        )}
        <footer>
          <span>Local workspace · Your work stays on this device</span>
          <span role="status">{model.storageError || 'Saved locally'}</span>
        </footer>
      </main>
      {issue && (
        <IssueDrawer
          issue={issue}
          activity={model.state.activity}
          dialog={dialog}
          confirm={confirm}
          setConfirm={setConfirm}
          patch={patch}
          close={close}
          remove={() => {
            model.remove(issue.id);
            refresh();
            close();
          }}
        />
      )}
    </div>
  );
}
