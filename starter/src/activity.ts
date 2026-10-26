import { Activity } from './types';
export function newest(events: Activity[]) {
  return [...events].sort((a, b) =>
    new Date(b.timestamp)
      .toLocaleDateString('en-US')
      .localeCompare(new Date(a.timestamp).toLocaleDateString('en-US')),
  );
}
