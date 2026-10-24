// What the page does in response to the user, apart from the views' own
// requests: loading saved connections, organizing them, loading the tree,
// and opening tabs.
import { api, db, rowsOf, type HistoryEntry, type Row } from './api.ts';
import { errorCode, errorMessage, getState as getSavedState, invoke, saveState } from './bridge.ts';
import { t } from './i18n.ts';
import { automaticName, isSQL, isWithin, listsDatabases, normalizeProfile, type Folder, type Profile } from './model.ts';
import type { StatementKind } from './sql.ts';
import {
  confirm, emptyDatabaseTree, getState, notify, OBJECT_KINDS, openTab, profileByID, prompt, setExpanded, subscribe,
  update, updateDatabaseTree, updateTree, type ObjectKind, type Tab,
} from './store.ts';
import { columnsOf, field, foreignKeyName, indexName, objectName, tableName } from './values.ts';

export function failure(error: unknown): string {
  return errorCode(error) === 'database.credentialsUnavailable' ? t('Lithe could not reach the system credential store.') : errorMessage(error);
}

export function reportFailure(error: unknown): void {
  notify(failure(error), 'error');
}

// MARK: Saved connections

interface SavedPageState {
  tabs: Tab[];
  activeTab: string;
  expanded: string[];
}

export async function loadWorkspace(): Promise<void> {
  update({ status: 'loading', error: undefined });
  try {
    const [workspace, history, saved] = await Promise.all([api.load(), api.history(), getSavedState<SavedPageState>()]);
    const profiles = workspace.profiles.map(normalizeProfile);
    const ids = new Set(profiles.map(profile => profile.id));
    const tabs = (saved?.tabs ?? []).filter(tab => !('profileID' in tab) || ids.has(tab.profileID));
    if (!tabs.some(tab => tab.id === 'overview')) tabs.unshift({ kind: 'overview', id: 'overview' });
    update({
      status: 'ready',
      profiles,
      folders: workspace.folders,
      history,
      tabs,
      activeTab: tabs.some(tab => tab.id === saved?.activeTab) ? saved!.activeTab : 'overview',
      expanded: saved?.expanded ?? [],
    });
  } catch (error) {
    update({ status: 'failed', error: failure(error) });
  }
}

/** Keeps open tabs and expanded nodes across page reloads, within the host's 64 KiB. */
export function persistPageState(): () => void {
  let last = '';
  return subscribe(() => {
    const { tabs, activeTab, expanded, status } = getState();
    if (status !== 'ready') return;
    const state: SavedPageState = {
      tabs: tabs.map(tab => (tab.kind === 'console' && tab.sql.length > 16_384 ? { ...tab, sql: tab.sql.slice(0, 16_384) } : tab)),
      activeTab,
      expanded: expanded.slice(-200),
    };
    let text = JSON.stringify(state);
    if (text.length > 60_000) {
      state.tabs = state.tabs.map(tab => (tab.kind === 'console' ? { ...tab, sql: '' } : tab));
      text = JSON.stringify(state);
    }
    if (text !== last) {
      last = text;
      saveState(state);
    }
  });
}

export async function saveProfile(profile: Profile, password: string | undefined): Promise<Profile> {
  const named = profile.name.trim() ? profile : { ...profile, name: automaticName(profile) };
  const saved = normalizeProfile(await api.saveProfile(named, password));
  update(current => {
    const exists = current.profiles.some(item => item.id === saved.id);
    return {
      profiles: exists ? current.profiles.map(item => (item.id === saved.id ? saved : item)) : [...current.profiles, saved],
      trees: { ...current.trees, [saved.id]: { status: 'idle', databases: [], byDatabase: {} } },
    };
  });
  return saved;
}

export async function removeProfile(profile: Profile): Promise<void> {
  const ok = await confirm({
    title: t('Remove connection?'),
    message: t('“{name}” and its saved password and query history will be removed.', { name: profile.name }),
    confirmLabel: t('Remove'),
    destructive: true,
  });
  if (!ok) return;
  try {
    await api.deleteProfile(profile.id);
    update(current => {
      const { [profile.id]: _removed, ...trees } = current.trees;
      return {
        profiles: current.profiles.filter(item => item.id !== profile.id),
        trees,
        tabs: current.tabs.filter(tab => !('profileID' in tab) || tab.profileID !== profile.id),
        activeTab: current.tabs.some(tab => tab.id === current.activeTab && 'profileID' in tab && tab.profileID === profile.id)
          ? 'overview'
          : current.activeTab,
        history: current.history.filter(entry => entry.profileID !== profile.id),
      };
    });
  } catch (error) {
    reportFailure(error);
  }
}

export async function duplicateProfile(profile: Profile): Promise<void> {
  try {
    const copy = normalizeProfile(await api.duplicateProfile(profile.id, t('{name} Copy', { name: profile.name })));
    update(current => ({ profiles: [...current.profiles, copy] }));
  } catch (error) {
    reportFailure(error);
  }
}

/** Saves a new order or folder tree; a stale list reloads instead. */
async function saveOrganization(profiles: Profile[], folders: Folder[]): Promise<void> {
  const previous = getState();
  update({ profiles, folders });
  try {
    await api.saveOrganization(profiles, folders);
  } catch (error) {
    update({ profiles: previous.profiles, folders: previous.folders });
    reportFailure(error);
    if (errorCode(error) === 'database.staleOrganization') await loadWorkspace();
  }
}

export function moveProfile(profileID: string, folderID: string | null): Promise<void> {
  const { profiles, folders } = getState();
  return saveOrganization(profiles.map(profile => (profile.id === profileID ? { ...profile, folderID } : profile)), folders);
}

const sameName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;

/**
 * Creates the folders of `path` ("a/b/c") below `parentID`, reusing folders
 * that exist, and returns the innermost one's ID.
 */
export async function createFolder(path: string, parentID: string | null = null, moveProfileID?: string): Promise<string | null> {
  const parts = path.split('/').map(part => part.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  let folders = [...getState().folders];
  let parent = parentID;
  for (const name of parts) {
    const existing = folders.find(folder => folder.parentID === parent && sameName(folder.name, name));
    if (existing) {
      parent = existing.id;
    } else {
      const folder = { id: crypto.randomUUID().toUpperCase(), name, parentID: parent };
      folders = [...folders, folder];
      parent = folder.id;
    }
  }
  const profiles = getState().profiles.map(profile => (profile.id === moveProfileID ? { ...profile, folderID: parent } : profile));
  await saveOrganization(profiles, folders);
  if (parent) setExpanded(`folder:${parent}`, true);
  return parent;
}

export async function renameFolder(folder: Folder): Promise<void> {
  const name = (await prompt({ title: t('Rename Folder'), label: t('Name'), value: folder.name, confirmLabel: t('Rename') }))?.trim();
  if (!name || name === folder.name) return;
  const { folders, profiles } = getState();
  if (folders.some(item => item.id !== folder.id && item.parentID === folder.parentID && sameName(item.name, name))) {
    notify(t('A folder named “{name}” already exists here.', { name }), 'error');
    return;
  }
  await saveOrganization(profiles, folders.map(item => (item.id === folder.id ? { ...item, name } : item)));
}

export async function moveFolder(folder: Folder, parentID: string | null): Promise<void> {
  const { folders, profiles } = getState();
  if (parentID && isWithin(folders, parentID, folder.id)) {
    notify(t('A folder cannot move into itself.'), 'error');
    return;
  }
  if (folders.some(item => item.id !== folder.id && item.parentID === parentID && sameName(item.name, folder.name))) {
    notify(t('A folder named “{name}” already exists here.', { name: folder.name }), 'error');
    return;
  }
  await saveOrganization(profiles, folders.map(item => (item.id === folder.id ? { ...item, parentID } : item)));
}

/** Removes a folder; its folders and connections move up to its parent. */
export async function removeFolder(folder: Folder): Promise<void> {
  const ok = await confirm({
    title: t('Remove folder?'),
    message: t('Connections and folders in “{name}” move up one level.', { name: folder.name }),
    confirmLabel: t('Remove'),
    destructive: true,
  });
  if (!ok) return;
  const { folders, profiles } = getState();
  await saveOrganization(
    profiles.map(profile => (profile.folderID === folder.id ? { ...profile, folderID: folder.parentID } : profile)),
    folders.filter(item => item.id !== folder.id).map(item => (item.parentID === folder.id ? { ...item, parentID: folder.parentID } : item)),
  );
}

/** Saves which databases the sidebar shows; null shows all. */
export async function setVisibleDatabases(profile: Profile, visible: string[] | null): Promise<void> {
  try {
    await saveProfile({ ...profile, visibleDatabases: visible }, undefined);
    await connect(profile.id);
  } catch (error) {
    reportFailure(error);
  }
}

// MARK: Tree

/** The database a profile's tree shows a single node for. */
export function defaultDatabase(profile: Profile): string {
  return profile.kind === 'mongodb' ? profile.database || 'admin' : profile.database;
}

/** Loads the first level of a connection: its databases, or its single database. */
export async function connect(profileID: string): Promise<void> {
  const profile = profileByID(profileID);
  if (!profile) return;
  updateTree(profileID, tree => ({ ...tree, status: 'loading', error: undefined }));
  try {
    if (listsDatabases(profile.kind)) {
      const names = rowsOf(await db(profileID, 'listDatabases').result)
        .map(row => (typeof row === 'string' ? row : (field(row, 'name', 'database', 'Database', 'SCHEMA_NAME', 'datname') ?? '')))
        .filter(Boolean);
      const databases = [...new Set(names)].sort();
      updateTree(profileID, tree => ({
        ...tree,
        status: 'ready',
        databases,
        byDatabase: Object.fromEntries(Object.entries(tree.byDatabase).filter(([name]) => databases.includes(name))),
      }));
    } else if (profile.kind === 'redis') {
      const scan = await db<{ keys: unknown[] }>(profileID, 'redisScan', { cursor: '0', pattern: '*', count: 100, includeSize: false }).result;
      updateTree(profileID, tree => ({ ...tree, status: 'ready', keyCount: scan.keys.length }));
    } else if (profile.kind === 'nacos') {
      await db(profileID, 'testConnection').result;
      updateTree(profileID, tree => ({ ...tree, status: 'ready' }));
    } else {
      updateTree(profileID, tree => ({ ...tree, status: 'ready' }));
      await loadDatabase(profileID, defaultDatabase(profile), true);
    }
    setExpanded(`profile:${profileID}`, true);
  } catch (error) {
    updateTree(profileID, tree => ({ ...tree, status: 'failed', error: failure(error) }));
  }
}

export function disconnect(profileID: string): void {
  updateTree(profileID, () => ({ status: 'idle', databases: [], byDatabase: {} }));
  setExpanded(`profile:${profileID}`, false);
}

/** The `database` override of a call, for kinds that list several databases. */
export function databaseOverride(profile: Profile, database: string | undefined): { database?: string } {
  return listsDatabases(profile.kind) && database ? { database } : {};
}

export async function loadDatabase(profileID: string, database: string, force = false): Promise<void> {
  const profile = profileByID(profileID);
  if (!profile) return;
  const current = getState().trees[profileID]?.byDatabase[database];
  if (!force && current && (current.status === 'loading' || current.status === 'ready')) return;
  updateDatabaseTree(profileID, database, tree => ({ ...tree, status: 'loading', error: undefined }));
  const scope = { profileID, ...databaseOverride(profile, database) };
  try {
    const tables = rowsOf(await dbIn(scope, 'listTables', { schema: '' }))
      .map(tableName)
      .filter((name): name is string => !!name);
    const objects = emptyDatabaseTree().objects;
    if (isSQL(profile.kind)) {
      const lists = await Promise.all(
        OBJECT_KINDS.map(kind =>
          dbIn(scope, 'listObjects', { schema: '', objectKind: kind })
            .then(value => rowsOf(value).map(objectName).filter((name): name is string => !!name))
            .catch(() => [] as string[]),
        ),
      );
      OBJECT_KINDS.forEach((kind, index) => (objects[kind as ObjectKind] = lists[index]));
    }
    updateDatabaseTree(profileID, database, tree => ({ ...tree, status: 'ready', tables, objects }));
  } catch (error) {
    updateDatabaseTree(profileID, database, tree => ({ ...tree, status: 'failed', error: failure(error) }));
  }
}

/** Calls an engine method with an optional database override. */
export function dbIn<T = any>(scope: { profileID: string; database?: string }, method: string, params: object = {}): Promise<T> {
  return dbCall<T>(scope, method, params).result;
}

export function dbCall<T = any>(scope: { profileID: string; database?: string }, method: string, params: object = {}) {
  return scope.database === undefined
    ? db<T>(scope.profileID, method, params)
    : invokeOn<T>(scope.profileID, scope.database, method, params);
}

function invokeOn<T>(profileID: string, database: string, method: string, params: object) {
  return invoke<T>('database.call', { profileID, database, method, params });
}

export interface TableStructure {
  columns: ReturnType<typeof columnsOf>;
  indexes: Row[];
  foreignKeys: Row[];
}

export async function loadTableStructure(scope: { profileID: string; database?: string }, table: string): Promise<TableStructure> {
  const profile = profileByID(scope.profileID);
  const params = { schema: '', table };
  const [description, indexes, foreignKeys] = await Promise.all([
    dbIn(scope, 'describeTable', params),
    dbIn(scope, 'listIndexes', params).catch(() => []),
    profile?.kind === 'mongodb' ? Promise.resolve([]) : dbIn(scope, 'listForeignKeys', params).catch(() => []),
  ]);
  return { columns: columnsOf(rowsOf(description)), indexes: rowsOf(indexes), foreignKeys: rowsOf(foreignKeys) };
}

export async function loadTableDetails(profileID: string, database: string, table: string): Promise<void> {
  const profile = profileByID(profileID);
  if (!profile) return;
  const set = (change: object) =>
    updateDatabaseTree(profileID, database, tree => ({
      ...tree,
      tableDetails: { ...tree.tableDetails, [table]: { ...(tree.tableDetails[table] ?? { status: 'idle', columns: 0, indexes: 0, foreignKeys: 0 }), ...change } },
    }));
  set({ status: 'loading' });
  try {
    const structure = await loadTableStructure({ profileID, ...databaseOverride(profile, database) }, table);
    set({
      status: 'ready',
      columns: structure.columns.length,
      indexes: new Set(structure.indexes.map(indexName)).size,
      foreignKeys: new Set(structure.foreignKeys.map(foreignKeyName)).size,
    });
  } catch (error) {
    set({ status: 'failed', error: failure(error) });
  }
}

// MARK: Tabs

let consoleNumber = 0;

export function openConsole(profileID: string, sql = '', database?: string): void {
  const { tabs } = getState();
  // An empty console of the same connection is reused.
  const empty = tabs.find(tab => tab.kind === 'console' && tab.profileID === profileID && !tab.sql.trim() && tab.database === database);
  if (empty) {
    update(current => ({
      tabs: current.tabs.map(tab => (tab.id === empty.id ? { ...tab, sql } as Tab : tab)),
      activeTab: empty.id,
    }));
    return;
  }
  const numbers = tabs.filter(tab => tab.kind === 'console').map(tab => Number((tab as { title: string }).title.match(/\d+$/)?.[0] ?? 0));
  consoleNumber = Math.max(consoleNumber, ...numbers) + 1;
  openTab({ kind: 'console', id: `console:${crypto.randomUUID()}`, profileID, title: t('Query {number}', { number: consoleNumber }), sql, database });
}

export function openTable(profileID: string, database: string | undefined, table: string, section: 'data' | 'structure' = 'data'): void {
  const id = `table:${profileID}:${database ?? ''}:${table}`;
  openTab({ kind: 'table', id, profileID, database, table, section });
  update(current => ({ tabs: current.tabs.map(tab => (tab.id === id && tab.kind === 'table' ? { ...tab, section } : tab)) }));
}

export function openRedis(profileID: string): void {
  openTab({ kind: 'redis', id: `redis:${profileID}`, profileID });
}

export function openNacos(profileID: string, section: 'configs' | 'services'): void {
  const id = `nacos:${profileID}`;
  openTab({ kind: 'nacos', id, profileID, section });
  update(current => ({ tabs: current.tabs.map(tab => (tab.id === id && tab.kind === 'nacos' ? { ...tab, section } : tab)) }));
}

export function openHistory(): void {
  openTab({ kind: 'history', id: 'history' });
}

// MARK: History

export async function recordHistory(entry: Omit<HistoryEntry, 'id'> & { kind: StatementKind }): Promise<void> {
  const saved: HistoryEntry = { ...entry, id: crypto.randomUUID().toUpperCase() };
  update(current => ({ history: [saved, ...current.history.filter(item => item.id !== saved.id)].slice(0, 100) }));
  try {
    await api.appendHistory(saved);
  } catch {
    // History is a convenience; a failed write never fails the query.
  }
}
