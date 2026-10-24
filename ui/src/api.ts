// Typed calls to the plugin backend. Engine methods and their params keep
// the names of Lithe's former database sidecar.
import { invoke, type Call } from './bridge.ts';
import type { Folder, Profile } from './model.ts';

export type Row = Record<string, unknown>;

export interface QueryResult {
  rows: Row[];
  columns?: string[];
  truncated?: boolean;
  /** Rows were dropped to keep the result within the function limit. */
  sizeLimited?: boolean;
  totalRows?: number;
}

export interface Workspace {
  profiles: Profile[];
  folders: Folder[];
}

export interface HistoryEntry {
  id: string;
  profileID: string;
  sql: string;
  kind: string;
  /** Milliseconds since 1970. */
  executedAt: number;
  durationMilliseconds: number;
  rowsReturned?: number | null;
  rowsAffected?: number | null;
}

export interface Filter {
  column: string;
  operator: 'equals' | 'notEquals' | 'greaterThan' | 'lessThan' | 'contains' | 'startsWith' | 'isNull' | 'isNotNull';
  value: string | null;
  join: 'and' | 'or';
}

export interface Sort {
  column: string;
  descending: boolean;
}

export interface Mutation {
  action: 'insert' | 'update' | 'delete';
  table: string;
  values: Row;
  key: Row;
}

export const api = {
  load: () => invoke<Workspace>('workspace.load').result,
  saveProfile: (profile: Profile, password?: string) =>
    invoke<Profile>('profile.save', password === undefined ? { profile } : { profile, password }).result,
  duplicateProfile: (id: string, name: string) => invoke<Profile>('profile.duplicate', { id, name }).result,
  deleteProfile: (id: string) => invoke<{ deleted: boolean }>('profile.delete', { id }).result,
  saveOrganization: (profiles: Profile[], folders: Folder[]) =>
    invoke<null>('organization.save', { profiles, folders }).result,
  testConnection: (profile: Profile, password?: string) =>
    invoke<{ connected: boolean; serverVersion?: string }>(
      'connection.test',
      password === undefined ? { profile } : { profile, password },
    ),
  history: () => invoke<HistoryEntry[]>('history.list').result,
  appendHistory: (entry: HistoryEntry) => invoke<null>('history.append', { entry }).result,
  importDBX: (path: string, password?: string) =>
    invoke<DBXPreview>('connections.previewDBX', password === undefined ? { path } : { path, password }).result,
  applyDBX: (path: string, password: string | undefined, selected: string[]) =>
    invoke<{ imported: number }>('connections.importDBX', { path, password, selected }).result,
};

export interface DBXPreview {
  connections: { id: string; name: string; kind: string; host: string; port: number; duplicate: boolean; warnings: string[] }[];
  unsupported: number;
  folders: number;
}

/** Runs one engine method on a saved profile. */
export function db<T = any>(profileID: string, method: string, params: object = {}): Call<T> {
  return invoke<T>('database.call', { profileID, method, params });
}

export function exportFile(profileID: string, method: 'exportCsv' | 'exportJson', params: object, path: string, database?: string) {
  return invoke<{ bytes: number }>('file.export', { profileID, method, params, path, ...(database ? { database } : {}) });
}

export function importFile(profileID: string, method: 'importCsv' | 'importJson', params: object, path: string, database?: string) {
  return invoke<unknown>('file.import', { profileID, method, params, path, ...(database ? { database } : {}) });
}

/** Rows of an engine answer that is either a list or `{ rows }`. */
export function rowsOf(value: unknown): Row[] {
  if (Array.isArray(value)) return value as Row[];
  if (value && typeof value === 'object' && Array.isArray((value as QueryResult).rows)) return (value as QueryResult).rows;
  return [];
}
