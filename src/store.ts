import { useSyncExternalStore } from 'react';
import type { DiffSpec, RefsResult, RepoInfo, StashEntry, WorkingStatus } from '../shared/types';

type Listener = () => void;

export interface Store<T> {
  get(): T;
  set(patch: Partial<T> | ((s: T) => Partial<T>)): void;
  subscribe(l: Listener): () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<Listener>();
  return {
    get: () => state,
    set(patch) {
      const p = typeof patch === 'function' ? patch(state) : patch;
      state = { ...state, ...p };
      listeners.forEach((l) => l());
    },
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

export function useStore<T extends object, S>(store: Store<T>, selector: (s: T) => S): S {
  return useSyncExternalStore(store.subscribe, () => selector(store.get()));
}

// ---------------------------------------------------------------------------

export type TabView =
  | { type: 'diff'; specs: DiffSpec[]; index: number; context?: string }
  | { type: 'blame'; path: string; rev?: string }
  | { type: 'history'; path: string }
  | { type: 'compare'; a: string; b: string }
  | { type: 'compareFiles'; from: string; to: string }
  | { type: 'merge'; path: string };

export interface Tab {
  id: string;
  title: string;
  tooltip?: string;
  preview?: boolean;
  view: TabView;
}

export interface LogFilter {
  text: string;
  branches: string[];
  author: string;
  since: string;
  path: string;
}

export const emptyFilter: LogFilter = { text: '', branches: [], author: '', since: '', path: '' };

export interface Task {
  id: number;
  title: string;
}

export interface AppState {
  repoPath: string | null;
  info: RepoInfo | null;
  status: WorkingStatus | null;
  refs: RefsResult | null;
  stashes: StashEntry[];
  /** Bumped whenever refs may have moved so the log reloads. */
  logVersion: number;
  tasks: Task[];
  tabs: Tab[];
  activeTab: string;
  leftPanel: 'commit' | 'stash' | null;
  logFilter: LogFilter;
  /** Request for the log to select and reveal a commit. */
  reveal: { hash: string; seq: number } | null;
  /** Commit message draft (kept across panel switches). */
  commitMessage: string;
  amend: boolean;
}

export const LOG_TAB = 'log';

export const app = createStore<AppState>({
  repoPath: null,
  info: null,
  status: null,
  refs: null,
  stashes: [],
  logVersion: 0,
  tasks: [],
  tabs: [],
  activeTab: LOG_TAB,
  leftPanel: (localStorage.getItem('gv.leftPanel') as AppState['leftPanel']) ?? 'commit',
  logFilter: emptyFilter,
  reveal: null,
  commitMessage: '',
  amend: false,
});

export const useApp = <S,>(selector: (s: AppState) => S) => useStore(app, selector);

// ---------------------------------------------------------------------------
// Persisted UI preferences

export function usePref<T>(key: string, initial: T): [T, (v: T) => void] {
  const value = useStore(prefs, (s) => (key in s ? (s[key] as T) : initial));
  return [value, (v: T) => setPref(key, v)];
}

const PREFS_KEY = 'gv.prefs';
const prefs = createStore<Record<string, unknown>>(
  (() => {
    try {
      return JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}');
    } catch {
      return {};
    }
  })(),
);

export function getPref<T>(key: string, initial: T): T {
  const s = prefs.get();
  return key in s ? (s[key] as T) : initial;
}

export function setPref(key: string, value: unknown) {
  prefs.set({ [key]: value });
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs.get()));
  } catch {
    // storage unavailable
  }
}
