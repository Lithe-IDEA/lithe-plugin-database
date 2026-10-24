import { useRef } from 'preact/hooks';
import {
  connect, createFolder, defaultDatabase, disconnect, duplicateProfile, loadDatabase, loadTableDetails, moveFolder, moveProfile,
  openConsole, openHistory, openNacos, openRedis, openTable, removeFolder, removeProfile, renameFolder, setVisibleDatabases,
} from '../actions.ts';
import { hasFileDialogs } from '../bridge.ts';
import { t } from '../i18n.ts';
import {
  folderPaths, folderTree, hasDataGrid, hasSQLBackup, isSQL, KIND_NAMES, KINDS, listsDatabases, newProfile,
  type DatabaseKind, type Folder, type FolderNode, type Profile,
} from '../model.ts';
import { quoteIdentifier } from '../sql.ts';
import {
  choose, editProfile, getState, OBJECT_KINDS, prompt, setExpanded, showDBXImport, update, useStore, type DatabaseTree,
  type ObjectKind, type ProfileTree,
} from '../store.ts';
import { copyToClipboard } from './clipboard.ts';
import { showMenu, showMenuBelow, type MenuEntry } from './Menu.tsx';
import { backUpDatabase, clearTable, dropTable, exportTable, importIntoTable, restoreDatabase } from './transfer.ts';

const OBJECT_TITLES: Record<ObjectKind, () => string> = {
  views: () => t('Views'),
  routines: () => t('Routines'),
  triggers: () => t('Triggers'),
  sequences: () => t('Sequences'),
};

export function Sidebar() {
  const profiles = useStore(state => state.profiles);
  const folders = useStore(state => state.folders);
  const search = useStore(state => state.search);
  const kindFilter = useStore(state => state.kindFilter);
  const sort = useStore(state => state.sort);
  const newButton = useRef<HTMLButtonElement>(null);
  const filterButton = useRef<HTMLButtonElement>(null);

  const query = search.trim().toLowerCase();
  const visible = profiles
    .filter(profile => kindFilter === 'all' || profile.kind === kindFilter)
    .filter(profile => !query || [profile.name, profile.kind, profile.host, profile.database, profile.path].some(value => value.toLowerCase().includes(query)))
    .sort((a, b) => {
      const key = (profile: Profile) => (sort === 'kind' ? KIND_NAMES[profile.kind] : sort === 'host' ? profile.host : profile.name);
      return key(a).localeCompare(key(b)) || a.name.localeCompare(b.name);
    });
  const filtering = query !== '' || kindFilter !== 'all';
  const tree = folderTree(folders, visible);

  const newMenu = (): MenuEntry[] => [
    { label: t('Query Console'), disabled: profiles.length === 0, submenu: profiles.filter(profile => isSQL(profile.kind)).map(profile => ({ label: profile.name, action: () => openConsole(profile.id) })) },
    { label: t('Data Source'), submenu: KINDS.map(kind => ({ label: KIND_NAMES[kind], action: () => editProfile(newProfile(kind), true) })) },
    { label: t('Folder…'), action: () => void promptFolder(null) },
    'separator',
    { label: t('Import Connections from DBX…'), disabled: !hasFileDialogs, action: showDBXImport },
  ];

  return (
    <div class="sidebar">
      <div class="toolbar">
        <button ref={newButton} class="icon" title={t('New')} aria-label={t('New')} onClick={() => newButton.current && showMenuBelow(newButton.current, newMenu())}>
          ＋
        </button>
        <button class="icon" title={t('New Folder')} aria-label={t('New Folder')} onClick={() => void promptFolder(null)}>
          ▤
        </button>
        <button class="icon" title={t('Collapse All')} aria-label={t('Collapse All')} onClick={() => update({ expanded: [] })}>
          ⊟
        </button>
        <button class="icon" title={t('SQL History')} aria-label={t('SQL History')} onClick={openHistory}>
          ⏱
        </button>
        <span class="spacer" />
        <button
          ref={filterButton}
          class={`icon ${kindFilter !== 'all' ? 'active' : ''}`}
          title={t('Filter and Sort')}
          aria-label={t('Filter and Sort')}
          onClick={() =>
            filterButton.current &&
            showMenuBelow(filterButton.current, [
              { label: `${kindFilter === 'all' ? '✓ ' : ''}${t('All Types')}`, action: () => update({ kindFilter: 'all' }) },
              ...KINDS.map(kind => ({ label: `${kindFilter === kind ? '✓ ' : ''}${KIND_NAMES[kind]}`, action: () => update({ kindFilter: kind as DatabaseKind }) })),
              'separator',
              ...(['name', 'kind', 'host'] as const).map(item => ({
                label: `${sort === item ? '✓ ' : ''}${item === 'name' ? t('Sort by Name') : item === 'kind' ? t('Sort by Type') : t('Sort by Host')}`,
                action: () => update({ sort: item }),
              })),
            ])
          }
        >
          ⚲
        </button>
      </div>
      <input class="search" type="search" placeholder={t('Search connections')} value={search} onInput={event => update({ search: event.currentTarget.value })} />
      <div
        class="tree"
        role="tree"
        onDragOver={event => event.preventDefault()}
        onDrop={event => {
          event.preventDefault();
          dropOn(event, null);
        }}
      >
        {profiles.length === 0 ? (
          <div class="empty-tree">
            <p class="muted">{t('No connections yet.')}</p>
            <button onClick={event => showMenu(event, KINDS.map(kind => ({ label: KIND_NAMES[kind], action: () => editProfile(newProfile(kind), true) })))}>
              {t('New Connection…')}
            </button>
          </div>
        ) : (
          <>
            {tree.folders.map(node => (
              <FolderRow key={node.folder.id} node={node} depth={0} forceOpen={filtering} />
            ))}
            {tree.profiles.map(profile => (
              <ProfileRow key={profile.id} profile={profile} depth={0} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

async function promptFolder(parentID: string | null, moveProfileID?: string): Promise<void> {
  const name = await prompt({ title: t('New Folder'), label: t('Name, or a path like a/b/c'), confirmLabel: t('Create') });
  if (name) await createFolder(name, parentID, moveProfileID);
}

const DRAG_TYPE = 'application/x-lithe-database-item';

function dropOn(event: DragEvent, folderID: string | null): void {
  const data = event.dataTransfer?.getData(DRAG_TYPE);
  if (!data) return;
  event.stopPropagation();
  const [kind, id] = data.split(':');
  if (kind === 'profile') void moveProfile(id, folderID);
  if (kind === 'folder') {
    const folder = getState().folders.find(item => item.id === id);
    if (folder && folder.id !== folderID && folder.parentID !== folderID) void moveFolder(folder, folderID);
  }
}

function Row(props: {
  depth: number;
  nodeKey: string;
  label: string;
  detail?: string;
  icon: string;
  color?: string;
  expandable?: boolean;
  expanded?: boolean;
  onToggle?: (expanded: boolean) => void;
  onOpen?: () => void;
  onMenu?: () => MenuEntry[];
  drag?: string;
  dropFolder?: string | null;
  status?: 'loading' | 'failed';
}) {
  const selected = useStore(state => state.selectedNode === props.nodeKey);
  const toggle = () => props.onToggle?.(!props.expanded);
  return (
    <div
      class={`tree-row ${selected ? 'selected' : ''}`}
      role="treeitem"
      aria-expanded={props.expandable ? props.expanded : undefined}
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      style={{ paddingLeft: `${6 + props.depth * 14}px` }}
      draggable={!!props.drag}
      onDragStart={event => props.drag && event.dataTransfer?.setData(DRAG_TYPE, props.drag)}
      onDragOver={event => props.dropFolder !== undefined && event.preventDefault()}
      onDrop={event => {
        if (props.dropFolder === undefined) return;
        event.preventDefault();
        dropOn(event, props.dropFolder);
      }}
      onClick={() => {
        update({ selectedNode: props.nodeKey });
        if (props.expandable) toggle();
      }}
      onDblClick={() => props.onOpen?.()}
      onKeyDown={event => {
        if (event.key === 'Enter') props.onOpen?.();
        if (event.key === 'ArrowRight' && props.expandable && !props.expanded) toggle();
        if (event.key === 'ArrowLeft' && props.expandable && props.expanded) toggle();
      }}
      onContextMenu={event => {
        update({ selectedNode: props.nodeKey });
        if (props.onMenu) showMenu(event, props.onMenu());
      }}
    >
      <span class="disclosure">{props.expandable ? (props.expanded ? '▾' : '▸') : ''}</span>
      <span class="node-icon" style={props.color ? { color: props.color } : undefined}>
        {props.icon}
      </span>
      <span class="node-label">{props.label}</span>
      {props.detail && <span class="node-detail">{props.detail}</span>}
      {props.status === 'loading' && <span class="node-detail">{t('Loading…')}</span>}
    </div>
  );
}

function useExpanded(key: string): [boolean, (expanded: boolean) => void] {
  const expanded = useStore(state => state.expanded.includes(key));
  return [expanded, value => setExpanded(key, value)];
}

function FolderRow({ node, depth, forceOpen }: { node: FolderNode; depth: number; forceOpen: boolean }) {
  const key = `folder:${node.folder.id}`;
  const [expanded, setOpen] = useExpanded(key);
  const open = expanded || forceOpen;
  const folder = node.folder;
  const menu = (): MenuEntry[] => [
    { label: t('New Connection'), submenu: KINDS.map(kind => ({ label: KIND_NAMES[kind], action: () => editProfile(newProfile(kind, folder.id), true) })) },
    { label: t('New Folder…'), action: () => void promptFolder(folder.id) },
    'separator',
    { label: t('Rename…'), action: () => void renameFolder(folder) },
    { label: t('Move'), submenu: moveFolderMenu(folder) },
    'separator',
    { label: t('Remove Folder…'), destructive: true, action: () => void removeFolder(folder) },
  ];
  return (
    <>
      <Row
        depth={depth}
        nodeKey={key}
        label={folder.name}
        detail={String(countProfiles(node))}
        icon="▤"
        expandable
        expanded={open}
        onToggle={setOpen}
        onMenu={menu}
        drag={`folder:${folder.id}`}
        dropFolder={folder.id}
      />
      {open && (
        <>
          {node.folders.map(child => (
            <FolderRow key={child.folder.id} node={child} depth={depth + 1} forceOpen={forceOpen} />
          ))}
          {node.profiles.map(profile => (
            <ProfileRow key={profile.id} profile={profile} depth={depth + 1} />
          ))}
        </>
      )}
    </>
  );
}

const countProfiles = (node: FolderNode): number => node.profiles.length + node.folders.reduce((sum, child) => sum + countProfiles(child), 0);

function moveFolderMenu(folder: Folder): MenuEntry[] {
  return [
    { label: t('To Folder…'), action: () => void pickFolder(folder.id).then(id => { if (id !== undefined) void moveFolder(folder, id); }) },
    { label: t('To Top Level'), disabled: folder.parentID === null, action: () => void moveFolder(folder, null) },
  ];
}

/** Asks for a folder; undefined when cancelled, null for the top level. */
async function pickFolder(excluding?: string): Promise<string | null | undefined> {
  const options = [{ id: '', label: t('Top level') }, ...folderPaths(getState().folders).filter(folder => folder.id !== excluding).map(folder => ({ id: folder.id, label: folder.path }))];
  const chosen = await choose({ title: t('Move To'), options });
  return chosen === null ? undefined : chosen || null;
}

function profileMenu(profile: Profile, tree: ProfileTree | undefined): MenuEntry[] {
  const connected = tree?.status === 'ready';
  return [
    connected ? { label: t('Disconnect'), action: () => disconnect(profile.id) } : { label: t('Connect'), action: () => void connect(profile.id) },
    ...(isSQL(profile.kind) ? [{ label: t('New Query'), action: () => openConsole(profile.id) }] : []),
    ...(profile.kind === 'redis' ? [{ label: t('Open Key Browser'), action: () => openRedis(profile.id) }] : []),
    { label: t('Refresh'), action: () => void connect(profile.id) },
    ...(listsDatabases(profile.kind) && connected
      ? [{ label: t('Databases Shown…'), action: () => void chooseVisibleDatabases(profile, tree!) }]
      : []),
    'separator',
    { label: t('Copy Name'), action: () => copyToClipboard(profile.name) },
    { label: t('Edit…'), action: () => editProfile(profile, false) },
    {
      label: t('Move'),
      submenu: [
        { label: t('To Folder…'), action: () => void pickFolder().then(id => { if (id !== undefined) void moveProfile(profile.id, id); }) },
        { label: t('To Top Level'), disabled: !profile.folderID, action: () => void moveProfile(profile.id, null) },
        { label: t('New Folder…'), action: () => void promptFolder(profile.folderID, profile.id) },
      ],
    },
    { label: t('Duplicate'), action: () => void duplicateProfile(profile) },
    'separator',
    { label: t('Remove…'), destructive: true, action: () => void removeProfile(profile) },
  ];
}

async function chooseVisibleDatabases(profile: Profile, tree: ProfileTree): Promise<void> {
  const options = [
    { id: '*', label: t('Show all databases') },
    ...tree.databases.map(name => ({ id: name, label: `${profile.visibleDatabases?.includes(name) ? '✓ ' : ''}${name}` })),
  ];
  const chosen = await choose({ title: t('Databases Shown'), options });
  if (chosen === null) return;
  if (chosen === '*') return setVisibleDatabases(profile, null);
  const current = profile.visibleDatabases ?? [];
  const next = current.includes(chosen) ? current.filter(name => name !== chosen) : [...current, chosen];
  return setVisibleDatabases(profile, next.length === 0 ? null : next);
}

function ProfileRow({ profile, depth }: { profile: Profile; depth: number }) {
  const key = `profile:${profile.id}`;
  const tree = useStore(state => state.trees[profile.id]);
  const [expanded, setOpen] = useExpanded(key);
  const status = tree?.status;
  const toggle = (open: boolean) => {
    setOpen(open);
    if (open && status !== 'ready' && status !== 'loading') void connect(profile.id);
  };
  const open = () => {
    if (profile.kind === 'redis') openRedis(profile.id);
    else if (profile.kind === 'nacos') openNacos(profile.id, 'configs');
    else if (isSQL(profile.kind)) openConsole(profile.id);
  };
  const visibleDatabases = (tree?.databases ?? []).filter(name => profile.visibleDatabases === null || profile.visibleDatabases.includes(name));
  return (
    <>
      <Row
        depth={depth}
        nodeKey={key}
        label={profile.name}
        detail={
          listsDatabases(profile.kind) && status === 'ready' && profile.visibleDatabases !== null
            ? t('{shown} of {total}', { shown: visibleDatabases.length, total: tree!.databases.length })
            : KIND_NAMES[profile.kind]
        }
        icon={status === 'ready' ? '●' : status === 'failed' ? '⚠' : '○'}
        color={profile.colorHex || undefined}
        expandable
        expanded={expanded}
        onToggle={toggle}
        onOpen={open}
        onMenu={() => profileMenu(profile, tree)}
        drag={`profile:${profile.id}`}
        status={status === 'loading' ? 'loading' : undefined}
      />
      {expanded && tree?.status === 'failed' && <ErrorRow depth={depth + 1} message={tree.error} onRetry={() => void connect(profile.id)} />}
      {expanded && status === 'ready' && (
        <>
          {listsDatabases(profile.kind) &&
            visibleDatabases.map(name => <DatabaseRow key={name} profile={profile} database={name} depth={depth + 1} />)}
          {(isSQL(profile.kind) || profile.kind === 'mongodb') && !listsDatabases(profile.kind) && (
            <DatabaseRow profile={profile} database={defaultDatabase(profile)} depth={depth + 1} single />
          )}
          {profile.kind === 'redis' && (
            <Row
              depth={depth + 1}
              nodeKey={`redis:${profile.id}`}
              label={t('Redis database {index}', { index: profile.database || '0' })}
              detail={tree.keyCount !== undefined ? t('{count} keys', { count: tree.keyCount >= 100 ? '100+' : tree.keyCount }) : undefined}
              icon="⚿"
              onOpen={() => openRedis(profile.id)}
              onMenu={() => [
                { label: t('Open Key Browser'), action: () => openRedis(profile.id) },
                { label: t('Refresh Keys'), action: () => void connect(profile.id) },
                { label: t('Set Database Alias…'), action: () => editProfile(profile, false) },
              ]}
            />
          )}
          {profile.kind === 'nacos' && (
            <>
              <Row depth={depth + 1} nodeKey={`nacos:${profile.id}:configs`} label={t('Configurations')} icon="☰" onOpen={() => openNacos(profile.id, 'configs')} onMenu={() => nacosMenu(profile, 'configs')} />
              <Row depth={depth + 1} nodeKey={`nacos:${profile.id}:services`} label={t('Services')} icon="⛭" onOpen={() => openNacos(profile.id, 'services')} onMenu={() => nacosMenu(profile, 'services')} />
            </>
          )}
        </>
      )}
    </>
  );
}

function nacosMenu(profile: Profile, section: 'configs' | 'services'): MenuEntry[] {
  return [
    { label: t('Open'), action: () => openNacos(profile.id, section) },
    { label: t('Refresh'), action: () => void connect(profile.id) },
    { label: t('Copy Name'), action: () => copyToClipboard(section === 'configs' ? t('Configurations') : t('Services')) },
    { label: t('Edit Namespace…'), action: () => editProfile(profile, false) },
  ];
}

function ErrorRow({ depth, message, onRetry }: { depth: number; message?: string; onRetry: () => void }) {
  return (
    <div class="tree-row error-row" style={{ paddingLeft: `${20 + depth * 14}px` }} title={message}>
      <span class="node-label">{message || t('Failed')}</span>
      <button class="link" onClick={onRetry}>
        {t('Retry')}
      </button>
    </div>
  );
}

function DatabaseRow({ profile, database, depth, single }: { profile: Profile; database: string; depth: number; single?: boolean }) {
  const key = `db:${profile.id}:${database}`;
  const tree = useStore(state => state.trees[profile.id]?.byDatabase[database]);
  const [expanded, setOpen] = useExpanded(key);
  const scopeDatabase = listsDatabases(profile.kind) ? database : undefined;
  const toggle = (open: boolean) => {
    setOpen(open);
    if (open) void loadDatabase(profile.id, database);
  };
  const mongo = profile.kind === 'mongodb';
  const menu = (): MenuEntry[] => [
    ...(mongo
      ? [{ label: t('Refresh Collections'), action: () => void loadDatabase(profile.id, database, true) }]
      : [
          { label: t('New Query'), action: () => openConsole(profile.id, '', scopeDatabase) },
          {
            label: t('New Table'),
            disabled: profile.readOnly,
            action: () => openConsole(profile.id, 'CREATE TABLE new_table (id INTEGER PRIMARY KEY);', scopeDatabase),
          },
          ...(hasSQLBackup(profile.kind)
            ? [
                'separator' as const,
                { label: t('Import SQL Backup…'), disabled: !hasFileDialogs || profile.readOnly, action: () => void restoreDatabase(profile, scopeDatabase) },
                { label: t('Export Database as SQL…'), disabled: !hasFileDialogs, action: () => void backUpDatabase(profile, scopeDatabase, database || profile.name) },
              ]
            : []),
          'separator' as const,
          { label: t('Refresh'), action: () => void loadDatabase(profile.id, database, true) },
        ]),
    { label: t('Copy Name'), action: () => copyToClipboard(database || profile.name) },
  ];
  const label = single ? (mongo ? database : database || t('Default database')) : database;
  // A connection with one database shows its contents directly expanded.
  return (
    <>
      <Row
        depth={depth}
        nodeKey={key}
        label={label}
        icon="⛁"
        expandable
        expanded={expanded || !!single}
        onToggle={single ? undefined : toggle}
        onMenu={menu}
        status={tree?.status === 'loading' ? 'loading' : undefined}
      />
      {(expanded || single) && tree?.status === 'failed' && <ErrorRow depth={depth + 1} message={tree.error} onRetry={() => void loadDatabase(profile.id, database, true)} />}
      {(expanded || single) && tree?.status === 'ready' && <DatabaseContents profile={profile} database={database} scopeDatabase={scopeDatabase} tree={tree} depth={depth + 1} />}
    </>
  );
}

function DatabaseContents(props: { profile: Profile; database: string; scopeDatabase?: string; tree: DatabaseTree; depth: number }) {
  const { profile, database, tree, depth } = props;
  const mongo = profile.kind === 'mongodb';
  const groupKey = `group:${profile.id}:${database}:tables`;
  const [tablesOpen, setTablesOpen] = useExpanded(groupKey);
  return (
    <>
      <Row
        depth={depth}
        nodeKey={groupKey}
        label={mongo ? t('Collections') : t('Tables')}
        detail={String(tree.tables.length)}
        icon="▦"
        expandable
        expanded={tablesOpen}
        onToggle={setTablesOpen}
        onMenu={() => [
          ...(mongo ? [] : [{ label: t('New Table'), disabled: profile.readOnly, action: () => openConsole(profile.id, 'CREATE TABLE new_table (id INTEGER PRIMARY KEY);', props.scopeDatabase) }]),
          { label: t('Refresh'), action: () => void loadDatabase(profile.id, database, true) },
        ]}
      />
      {tablesOpen && tree.tables.map(table => <TableRow key={table} profile={profile} database={database} scopeDatabase={props.scopeDatabase} table={table} depth={depth + 1} />)}
      {!mongo &&
        OBJECT_KINDS.filter(kind => tree.objects[kind].length > 0).map(kind => (
          <ObjectGroup key={kind} profile={profile} database={database} kind={kind} names={tree.objects[kind]} depth={depth} />
        ))}
    </>
  );
}

function ObjectGroup(props: { profile: Profile; database: string; kind: ObjectKind; names: string[]; depth: number }) {
  const key = `group:${props.profile.id}:${props.database}:${props.kind}`;
  const [open, setOpen] = useExpanded(key);
  return (
    <>
      <Row depth={props.depth} nodeKey={key} label={OBJECT_TITLES[props.kind]()} detail={String(props.names.length)} icon="◇" expandable expanded={open} onToggle={setOpen} />
      {open &&
        props.names.map(name => (
          <Row
            key={name}
            depth={props.depth + 1}
            nodeKey={`${key}:${name}`}
            label={name}
            icon="·"
            onMenu={() => [{ label: t('Copy Name'), action: () => copyToClipboard(name) }]}
          />
        ))}
    </>
  );
}

function TableRow(props: { profile: Profile; database: string; scopeDatabase?: string; table: string; depth: number }) {
  const { profile, database, table, depth } = props;
  const key = `table:${profile.id}:${database}:${table}`;
  const [expanded, setOpen] = useExpanded(key);
  const details = useStore(state => state.trees[profile.id]?.byDatabase[database]?.tableDetails[table]);
  const mongo = profile.kind === 'mongodb';
  const toggle = (open: boolean) => {
    setOpen(open);
    if (open && details?.status !== 'ready') void loadTableDetails(profile.id, database, table);
  };
  const view = () => openTable(profile.id, props.scopeDatabase, table, 'data');
  const quoted = quoteIdentifier(profile.kind, table);
  const menu = (): MenuEntry[] =>
    mongo
      ? [
          { label: t('View Documents'), action: view },
          { label: t('Copy Name'), action: () => copyToClipboard(table) },
          { label: t('Refresh'), action: () => void loadTableDetails(profile.id, database, table) },
        ]
      : [
          { label: t('View Data'), action: view },
          { label: t('New Query'), action: () => openConsole(profile.id, `SELECT * FROM ${quoted};`, props.scopeDatabase) },
          { label: t('View Structure'), action: () => openTable(profile.id, props.scopeDatabase, table, 'structure') },
          { label: t('Copy Name'), action: () => copyToClipboard(table) },
          'separator',
          {
            label: t('Export Data'),
            disabled: !hasFileDialogs,
            submenu: [
              { label: 'CSV…', action: () => void exportTable(profile, props.scopeDatabase, table, 'csv') },
              { label: 'JSON…', action: () => void exportTable(profile, props.scopeDatabase, table, 'json') },
            ],
          },
          { label: t('Import Data…'), disabled: !hasFileDialogs || profile.readOnly, action: () => void importIntoTable(profile, props.scopeDatabase, table) },
          'separator',
          { label: t('Clear Table…'), destructive: true, disabled: profile.readOnly, action: () => void clearTable(profile, props.scopeDatabase, table) },
          { label: t('Delete Table…'), destructive: true, disabled: profile.readOnly, action: () => void dropTable(profile, props.scopeDatabase, database, table) },
          'separator',
          { label: t('Refresh'), action: () => void loadTableDetails(profile.id, database, table) },
        ];
  return (
    <>
      <Row
        depth={depth}
        nodeKey={key}
        label={table}
        icon="▤"
        expandable={hasDataGrid(profile.kind)}
        expanded={expanded}
        onToggle={toggle}
        onOpen={view}
        onMenu={menu}
        status={details?.status === 'loading' ? 'loading' : undefined}
      />
      {expanded && details?.status === 'failed' && <ErrorRow depth={depth + 1} message={details.error} onRetry={() => void loadTableDetails(profile.id, database, table)} />}
      {expanded && details?.status === 'ready' && (
        <>
          <Row depth={depth + 1} nodeKey={`${key}:columns`} label={mongo ? t('Fields') : t('Columns')} detail={String(details.columns)} icon="▥" onOpen={() => openTable(profile.id, props.scopeDatabase, table, 'structure')} />
          <Row depth={depth + 1} nodeKey={`${key}:indexes`} label={t('Indexes')} detail={String(details.indexes)} icon="⌗" onOpen={() => openTable(profile.id, props.scopeDatabase, table, 'structure')} />
          {!mongo && <Row depth={depth + 1} nodeKey={`${key}:keys`} label={t('Foreign Keys')} detail={String(details.foreignKeys)} icon="⇢" onOpen={() => openTable(profile.id, props.scopeDatabase, table, 'structure')} />}
        </>
      )}
    </>
  );
}
