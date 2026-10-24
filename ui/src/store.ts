// Page state in one place. Components read it with `useStore` and change it
// with `update`; every update re-renders the readers whose selection changed.
import { useEffect, useReducer, useRef } from 'preact/hooks';
import type { HistoryEntry } from './api.ts';
import type { DatabaseKind, Folder, Profile } from './model.ts';

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'failed';

export type ObjectKind = 'views' | 'routines' | 'triggers' | 'sequences';
export const OBJECT_KINDS: ObjectKind[] = ['views', 'routines', 'triggers', 'sequences'];

export interface TableTree {
  status: LoadStatus;
  error?: string;
  columns: number;
  indexes: number;
  foreignKeys: number;
}

export interface DatabaseTree {
  status: LoadStatus;
  error?: string;
  tables: string[];
  objects: Record<ObjectKind, string[]>;
  tableDetails: Record<string, TableTree>;
}

export interface ProfileTree {
  status: LoadStatus;
  error?: string;
  /** Every database the server lists (MySQL and MariaDB). */
  databases: string[];
  byDatabase: Record<string, DatabaseTree>;
  /** Key count of a Redis database. */
  keyCount?: number;
}

export type Tab =
  | { kind: 'overview'; id: 'overview' }
  | { kind: 'console'; id: string; profileID: string; title: string; sql: string; database?: string }
  | { kind: 'table'; id: string; profileID: string; database?: string; table: string; section: 'data' | 'structure' }
  | { kind: 'redis'; id: string; profileID: string }
  | { kind: 'nacos'; id: string; profileID: string; section: 'configs' | 'services' }
  | { kind: 'history'; id: string };

export type Dialog =
  | { kind: 'confirm'; title: string; message: string; confirmLabel: string; destructive: boolean; resolve: (ok: boolean) => void }
  | { kind: 'prompt'; title: string; label: string; value: string; confirmLabel: string; resolve: (value: string | null) => void }
  | { kind: 'choice'; title: string; options: { id: string; label: string }[]; resolve: (id: string | null) => void }
  | { kind: 'profile'; profile: Profile; isNew: boolean }
  | { kind: 'dbx' };

export interface Notice {
  id: number;
  text: string;
  tone: 'info' | 'error';
}

export interface State {
  status: LoadStatus;
  error?: string;
  profiles: Profile[];
  folders: Folder[];
  trees: Record<string, ProfileTree>;
  /** Tree node keys that are expanded. */
  expanded: string[];
  selectedNode?: string;
  tabs: Tab[];
  activeTab: string;
  history: HistoryEntry[];
  search: string;
  kindFilter: DatabaseKind | 'all';
  sort: 'name' | 'kind' | 'host';
  dialogs: Dialog[];
  notices: Notice[];
}

let state: State = {
  status: 'idle',
  profiles: [],
  folders: [],
  trees: {},
  expanded: [],
  tabs: [{ kind: 'overview', id: 'overview' }],
  activeTab: 'overview',
  history: [],
  search: '',
  kindFilter: 'all',
  sort: 'name',
  dialogs: [],
  notices: [],
};

const listeners = new Set<() => void>();

export const getState = () => state;

export function update(change: Partial<State> | ((current: State) => Partial<State>)): void {
  const next = typeof change === 'function' ? change(state) : change;
  state = { ...state, ...next };
  for (const listener of [...listeners]) listener();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The selected part of the state; the component re-renders when it changes. */
export function useStore<T>(select: (current: State) => T): T {
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const selected = select(state);
  const latest = useRef({ select, selected });
  latest.current = { select, selected };
  useEffect(
    () =>
      subscribe(() => {
        const { select, selected } = latest.current;
        if (!Object.is(select(state), selected)) rerender(0);
      }),
    [],
  );
  return selected;
}

export function profileByID(id: string): Profile | undefined {
  return state.profiles.find(profile => profile.id === id);
}

export function updateTree(profileID: string, change: (tree: ProfileTree) => ProfileTree): void {
  update(current => {
    const tree = current.trees[profileID] ?? { status: 'idle', databases: [], byDatabase: {} };
    return { trees: { ...current.trees, [profileID]: change(tree) } };
  });
}

export const emptyDatabaseTree = (): DatabaseTree => ({
  status: 'idle',
  tables: [],
  objects: { views: [], routines: [], triggers: [], sequences: [] },
  tableDetails: {},
});

export function updateDatabaseTree(profileID: string, database: string, change: (tree: DatabaseTree) => DatabaseTree): void {
  updateTree(profileID, tree => ({
    ...tree,
    byDatabase: { ...tree.byDatabase, [database]: change(tree.byDatabase[database] ?? emptyDatabaseTree()) },
  }));
}

export function setExpanded(key: string, expanded: boolean): void {
  update(current => {
    const has = current.expanded.includes(key);
    if (has === expanded) return {};
    return { expanded: expanded ? [...current.expanded, key] : current.expanded.filter(item => item !== key) };
  });
}

export function openTab(tab: Tab): void {
  update(current => {
    const existing = current.tabs.find(item => item.id === tab.id);
    return { tabs: existing ? current.tabs : [...current.tabs, tab], activeTab: tab.id };
  });
}

export function updateTab<K extends Tab['kind']>(id: string, change: (tab: Extract<Tab, { kind: K }>) => Partial<Extract<Tab, { kind: K }>>): void {
  update(current => ({
    tabs: current.tabs.map(tab => (tab.id === id ? ({ ...tab, ...change(tab as Extract<Tab, { kind: K }>) } as Tab) : tab)),
  }));
}

export function closeTab(id: string): void {
  if (id === 'overview') return;
  update(current => {
    const index = current.tabs.findIndex(tab => tab.id === id);
    const tabs = current.tabs.filter(tab => tab.id !== id);
    const activeTab = current.activeTab === id ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? 'overview') : current.activeTab;
    return { tabs, activeTab };
  });
}

let noticeIDs = 0;

export function notify(text: string, tone: Notice['tone'] = 'info'): void {
  const id = ++noticeIDs;
  update(current => ({ notices: [...current.notices.slice(-3), { id, text, tone }] }));
  setTimeout(() => update(current => ({ notices: current.notices.filter(notice => notice.id !== id) })), tone === 'error' ? 8000 : 4000);
}

function pushDialog(dialog: Dialog): void {
  update(current => ({ dialogs: [...current.dialogs, dialog] }));
}

export function closeDialog(dialog: Dialog): void {
  update(current => ({ dialogs: current.dialogs.filter(item => item !== dialog) }));
}

export function confirm(options: { title: string; message: string; confirmLabel: string; destructive?: boolean }): Promise<boolean> {
  return new Promise(resolve => pushDialog({ kind: 'confirm', destructive: false, ...options, resolve }));
}

export function prompt(options: { title: string; label: string; value?: string; confirmLabel: string }): Promise<string | null> {
  return new Promise(resolve => pushDialog({ kind: 'prompt', value: '', ...options, resolve }));
}

export function choose(options: { title: string; options: { id: string; label: string }[] }): Promise<string | null> {
  return new Promise(resolve => pushDialog({ kind: 'choice', ...options, resolve }));
}

export function editProfile(profile: Profile, isNew: boolean): void {
  pushDialog({ kind: 'profile', profile, isNew });
}

export function showDBXImport(): void {
  pushDialog({ kind: 'dbx' });
}
