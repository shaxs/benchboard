export const statuses = ['backlog', 'in-progress', 'done'] as const;
export const statusNames = {
  backlog: 'Backlog',
  'in-progress': 'In Progress',
  done: 'Done',
};
export const priorities = ['Critical', 'High', 'Medium', 'Low'] as const;
export const assignees = [
  'Maya Chen',
  'Alex Rivera',
  'Jordan Kim',
  'Sam Patel',
];
export const labels = [
  'frontend',
  'backend',
  'bug',
  'testing',
  'docs',
  'performance',
  'accessibility',
  'design',
];
export type Status = (typeof statuses)[number];
export type Priority = (typeof priorities)[number];
export interface Issue {
  id: string;
  title: string;
  description: string;
  status: Status;
  priority: Priority;
  assignee: string;
  labels: string[];
  order: number;
}
export interface Activity {
  id: string;
  issueId: string;
  timestamp: string;
  message: string;
}
export interface State {
  version: 1;
  issues: Issue[];
  activity: Activity[];
}
export interface Filters {
  query: string;
  priority: string;
  assignee: string;
  label: string;
  status: string;
}
