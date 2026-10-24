// Saved connections keep the JSON shape of Lithe's former built-in database
// module, so profiles migrate unchanged.

export type DatabaseKind = 'mysql' | 'mariadb' | 'postgresql' | 'sqlite' | 'sqlserver' | 'mongodb' | 'redis' | 'nacos';

export const KINDS: DatabaseKind[] = ['mysql', 'mariadb', 'postgresql', 'sqlite', 'sqlserver', 'mongodb', 'redis', 'nacos'];

export const KIND_NAMES: Record<DatabaseKind, string> = {
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  postgresql: 'PostgreSQL',
  sqlite: 'SQLite',
  sqlserver: 'SQL Server',
  mongodb: 'MongoDB',
  redis: 'Redis',
  nacos: 'Nacos',
};

export const SQL_KINDS: ReadonlySet<DatabaseKind> = new Set(['mysql', 'mariadb', 'postgresql', 'sqlite', 'sqlserver']);

export const isSQL = (kind: DatabaseKind) => SQL_KINDS.has(kind);
/** Kinds whose tables open in the data grid. */
export const hasDataGrid = (kind: DatabaseKind) => isSQL(kind) || kind === 'mongodb';
/** Kinds whose sidebar lists several databases. */
export const listsDatabases = (kind: DatabaseKind) => kind === 'mysql' || kind === 'mariadb';
/** Kinds that back up to and restore from SQL files. */
export const hasSQLBackup = (kind: DatabaseKind) => isSQL(kind) && kind !== 'sqlserver';

export type PasswordPersistence = 'forever' | 'untilRestart';

export interface Profile {
  id: string;
  name: string;
  kind: DatabaseKind;
  host: string;
  port: number;
  passwordPersistence: PasswordPersistence;
  username: string;
  database: string;
  /** null shows every database; [] hides them all. */
  visibleDatabases: string[] | null;
  path: string;
  ssl: boolean;
  folderID: string | null;
  colorHex: string;
  readOnly: boolean;
  productionProtection: boolean;
  maskSensitiveFields: boolean;
  sensitiveColumnPatterns: string[];
  caCertificatePath: string;
  serverName: string;
  sshHost: string;
  sshPort: number;
  sshUsername: string;
  sshKeyPath: string;
  sshLocalPort: number;
  proxyURL: string;
  [key: string]: unknown;
}

export interface Folder {
  id: string;
  name: string;
  parentID: string | null;
}

export const DEFAULT_SENSITIVE_PATTERNS = ['password', 'secret', 'token', 'api_key'];

export function defaultPort(kind: DatabaseKind): number {
  switch (kind) {
    case 'mysql':
    case 'mariadb':
      return 3306;
    case 'postgresql':
      return 5432;
    case 'sqlserver':
      return 1433;
    case 'mongodb':
      return 27017;
    case 'redis':
      return 6379;
    case 'nacos':
      return 8848;
    case 'sqlite':
      return 0;
  }
}

export function defaultDatabase(kind: DatabaseKind): string {
  switch (kind) {
    case 'sqlserver':
      return 'master';
    case 'mongodb':
      return 'admin';
    case 'redis':
      return '0';
    default:
      return '';
  }
}

export function newProfile(kind: DatabaseKind, folderID: string | null = null): Profile {
  return {
    id: crypto.randomUUID().toUpperCase(),
    name: '',
    kind,
    host: kind === 'sqlite' ? '' : '127.0.0.1',
    port: defaultPort(kind),
    passwordPersistence: 'forever',
    username: '',
    database: defaultDatabase(kind),
    visibleDatabases: null,
    path: kind === 'nacos' ? '/nacos' : '',
    ssl: false,
    folderID,
    colorHex: '',
    readOnly: false,
    productionProtection: false,
    maskSensitiveFields: false,
    sensitiveColumnPatterns: [...DEFAULT_SENSITIVE_PATTERNS],
    caCertificatePath: '',
    serverName: '',
    sshHost: '',
    sshPort: 22,
    sshUsername: '',
    sshKeyPath: '',
    sshLocalPort: 0,
    proxyURL: '',
  };
}

/** Fills fields a migrated or older profile may lack. */
export function normalizeProfile(raw: Partial<Profile> & { id: string; kind: DatabaseKind }): Profile {
  return { ...newProfile(raw.kind), ...raw, id: raw.id } as Profile;
}

/** The name a new profile gets when the user leaves it empty. */
export function automaticName(profile: Profile): string {
  if (profile.kind === 'sqlite') {
    const file = profile.path.split('/').filter(Boolean).pop();
    return file || 'SQLite';
  }
  // A MongoDB URI may carry credentials; they never become a name.
  const host = profile.host.replace(/^[a-z+]+:\/\//i, '').replace(/^[^@/]*@/, '').split(/[/?]/)[0];
  const database = profile.database.trim();
  return database ? `${database}@${host}` : host || KIND_NAMES[profile.kind];
}

export interface FolderNode {
  folder: Folder;
  folders: FolderNode[];
  profiles: Profile[];
}

/** Folders as a tree; profiles of a missing folder land at the top level. */
export function folderTree(folders: Folder[], profiles: Profile[]): { folders: FolderNode[]; profiles: Profile[] } {
  const nodes = new Map(folders.map(folder => [folder.id, { folder, folders: [], profiles: [] } as FolderNode]));
  const roots: FolderNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.folder.parentID ? nodes.get(node.folder.parentID) : undefined;
    (parent ? parent.folders : roots).push(node);
  }
  const loose: Profile[] = [];
  for (const profile of profiles) {
    const folder = profile.folderID ? nodes.get(profile.folderID) : undefined;
    (folder ? folder.profiles : loose).push(profile);
  }
  return { folders: roots, profiles: loose };
}

/** "a / b / c" for every folder, for move pickers. */
export function folderPaths(folders: Folder[]): { id: string; path: string }[] {
  const byID = new Map(folders.map(folder => [folder.id, folder]));
  const path = (folder: Folder, seen = new Set<string>()): string => {
    const parent = folder.parentID ? byID.get(folder.parentID) : undefined;
    if (!parent || seen.has(parent.id)) return folder.name;
    seen.add(folder.id);
    return `${path(parent, seen)} / ${folder.name}`;
  };
  return folders.map(folder => ({ id: folder.id, path: path(folder) })).sort((a, b) => a.path.localeCompare(b.path));
}

/** Whether `folderID` is `ancestorID` or lies inside it. */
export function isWithin(folders: Folder[], folderID: string | null, ancestorID: string): boolean {
  const byID = new Map(folders.map(folder => [folder.id, folder]));
  const seen = new Set<string>();
  for (let current = folderID; current && !seen.has(current); current = byID.get(current)?.parentID ?? null) {
    if (current === ancestorID) return true;
    seen.add(current);
  }
  return false;
}
