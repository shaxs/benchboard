import fixture from './fixtures.json';
import type { State } from './types';
export const fresh = (): State => structuredClone(fixture) as State;
export function load(): State {
  return fresh();
}
