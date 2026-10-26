import { Activity } from './types';
export function newest(events: Activity[]) {
  return [...events].sort(
    (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp),
  );
}
