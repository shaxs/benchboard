import { Issue, Status, statuses } from './types';
import { load } from './persistence';
import { normalizeLabels } from './labels';
import { summary } from './analytics';
export { fresh, load } from './persistence';
export { normalizeLabels } from './labels';
export { select } from './filters';
export { summary } from './analytics';
export { newest } from './activity';
export class Model {
  state = load();
  stats = summary(this.state.issues);
  storageError = '';
  constructor() {
    this.save();
  }
  save() {
    try {
      localStorage.setItem('benchboard', JSON.stringify(this.state));
      this.storageError = '';
    } catch {
      this.storageError = 'Changes could not be saved locally.';
    }
  }
  event(issueId: string, message: string) {
    this.state.activity = [
      ...this.state.activity,
      {
        id: crypto.randomUUID(),
        issueId,
        timestamp: new Date().toISOString(),
        message,
      },
    ];
  }
  ordered(status: Status) {
    return this.state.issues
      .filter((i) => i.status === status)
      .sort((a, b) => a.order - b.order);
  }
  renumber() {
    for (const status of statuses)
      this.ordered(status).forEach((issue, index) => (issue.order = index));
  }
  patch(id: string, patch: Partial<Issue>) {
    const issue = this.state.issues.find((i) => i.id === id);
    if (!issue) return;
    const next = { ...patch };
    delete next.id;
    if (next.title !== undefined) {
      next.title = next.title.trim();
      if (!next.title) return;
    }
    if (next.labels) next.labels = normalizeLabels(next.labels);
    if (next.status && next.status !== issue.status)
      next.order = this.ordered(next.status).length;
    const changed = Object.keys(next).filter(
      (k) =>
        JSON.stringify(issue[k as keyof Issue]) !==
        JSON.stringify(next[k as keyof Issue]),
    );
    if (!changed.length) return;
    Object.assign(issue, next);
    this.renumber();
    const message = changed.includes('status')
      ? 'Status changed'
      : changed.includes('priority')
        ? 'Priority changed'
        : changed.includes('assignee')
          ? 'Assignee changed'
          : changed.includes('labels')
            ? 'Labels changed'
            : 'Issue edited';
    this.event(id, message);
    this.stats = summary(this.state.issues);
    this.save();
  }
  move(id: string, status: Status, beforeId?: string) {
    const issue = this.state.issues.find((i) => i.id === id);
    if (!issue || id === beforeId) return;
    const before = JSON.stringify(
      this.state.issues.map((i) => [i.id, i.status, i.order]),
    );
    const target = this.ordered(status).filter((i) => i.id !== id);
    const index = beforeId
      ? target.findIndex((i) => i.id === beforeId)
      : target.length;
    target.splice(index < 0 ? target.length : index, 0, issue);
    issue.status = status;
    target.forEach((i, n) => (i.order = n));
    this.renumber();
    if (
      JSON.stringify(
        this.state.issues.map((i) => [i.id, i.status, i.order]),
      ) === before
    )
      return;
    this.event(id, 'Issue moved');
    this.stats = summary(this.state.issues);
    this.save();
  }
  remove(id: string) {
    if (!this.state.issues.some((i) => i.id === id)) return;
    this.state.issues = this.state.issues.filter((i) => i.id !== id);
    this.renumber();
    this.event(id, 'Issue deleted');
    this.stats = summary(this.state.issues);
    this.save();
  }
  create() {
    const id = 'BB-' + crypto.randomUUID();
    this.state.issues.push({
      id,
      title: 'Untitled issue',
      description: '',
      status: 'backlog',
      priority: 'Medium',
      assignee: '',
      labels: [],
      order: this.ordered('backlog').length,
    });
    this.event(id, 'Issue created');
    this.stats = summary(this.state.issues);
    this.save();
    return id;
  }
}
