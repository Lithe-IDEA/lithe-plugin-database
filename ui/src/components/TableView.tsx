import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { dbCall, dbIn, failure, loadTableDetails, loadTableStructure, type TableStructure } from '../actions.ts';
import type { Filter, Mutation, QueryResult, Row, Sort } from '../api.ts';
import { hasFileDialogs } from '../bridge.ts';
import { withConfirmation } from '../guard.ts';
import { t } from '../i18n.ts';
import { hasSQLBackup, type Profile } from '../model.ts';
import { MASK, maskRows } from '../sql.ts';
import { choose, confirm, notify, prompt, updateTab, useStore, type Tab } from '../store.ts';
import { displayValue, typedValue } from '../values.ts';
import { DataGrid, type CellPosition } from './DataGrid.tsx';
import { Modal } from './Dialogs.tsx';
import { showMenuBelow, type MenuEntry } from './Menu.tsx';
import { backUpTable, exportTable, importIntoTable, restoreDatabase } from './transfer.ts';
import { Structure } from './Structure.tsx';

const PAGE_SIZE = 200;

/** A row the user added; a missing column means the column default. */
type Inserted = Row;

interface Edits {
  /** Changed cells of loaded rows, by row index. */
  updates: Map<number, Row>;
  inserted: Inserted[];
  deleted: Set<number>;
}

const noEdits = (): Edits => ({ updates: new Map(), inserted: [], deleted: new Set() });

interface Condition extends Filter {
  enabled: boolean;
}

export function TableView({ tab }: { tab: Extract<Tab, { kind: 'table' }> }) {
  const profile = useStore(state => state.profiles.find(item => item.id === tab.profileID));
  if (!profile) return <div class="empty-state muted">{t('The connection no longer exists.')}</div>;
  const mongo = profile.kind === 'mongodb';
  return (
    <div class="table-view">
      {!mongo && (
        <div class="segmented section-switch" role="tablist">
          <button role="tab" aria-selected={tab.section === 'data'} class={tab.section === 'data' ? 'selected' : ''} onClick={() => updateTab<'table'>(tab.id, () => ({ section: 'data' }))}>
            {t('Data')}
          </button>
          <button role="tab" aria-selected={tab.section === 'structure'} class={tab.section === 'structure' ? 'selected' : ''} onClick={() => updateTab<'table'>(tab.id, () => ({ section: 'structure' }))}>
            {t('Structure')}
          </button>
        </div>
      )}
      <div class="section-page" hidden={tab.section !== 'data' && !mongo}>
        <TableData tab={tab} profile={profile} />
      </div>
      {!mongo && tab.section === 'structure' && <Structure tab={tab} profile={profile} />}
    </div>
  );
}

function TableData({ tab, profile }: { tab: Extract<Tab, { kind: 'table' }>; profile: Profile }) {
  const scope = useMemo(() => ({ profileID: profile.id, ...(tab.database ? { database: tab.database } : {}) }), [profile.id, tab.database]);
  const [structure, setStructure] = useState<TableStructure | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [resultColumns, setResultColumns] = useState<string[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [offset, setOffset] = useState(0);
  const [conditions, setConditions] = useState<Condition[]>([]);
  const [join, setJoin] = useState<'and' | 'or'>('and');
  const [sort, setSort] = useState<Sort[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [edits, setEdits] = useState<Edits>(noEdits);
  const [failedRows, setFailedRows] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState<number[]>([]);
  const [applying, setApplying] = useState(false);
  const [dialog, setDialog] = useState<'filter' | 'sort' | { details: number } | null>(null);
  const request = useRef(0);
  const toolsButton = useRef<HTMLButtonElement>(null);

  const columns = structure?.columns.length ? structure.columns.map(column => column.name) : resultColumns;
  const types = Object.fromEntries((structure?.columns ?? []).map(column => [column.name, column.type]));
  const primaryKey = (structure?.columns ?? []).filter(column => column.primaryKey).map(column => column.name);
  const masked = (column: string) =>
    profile.maskSensitiveFields && profile.sensitiveColumnPatterns.some(pattern => pattern.trim() && column.toLowerCase().includes(pattern.trim().toLowerCase()));
  const hasEdits = edits.updates.size > 0 || edits.inserted.length > 0 || edits.deleted.size > 0;
  const readOnly = profile.readOnly;

  const load = async (nextOffset: number, nextConditions = conditions, nextJoin = join, nextSort = sort) => {
    const id = ++request.current;
    setLoading(true);
    setError(null);
    try {
      const filters: Filter[] = nextConditions
        .filter(condition => condition.enabled && condition.column)
        .map(({ column, operator, value }) => ({ column, operator, value: operator === 'isNull' || operator === 'isNotNull' ? null : value ?? '', join: nextJoin }));
      const [loadedStructure, page] = await Promise.all([
        structure ? Promise.resolve(structure) : loadTableStructure(scope, tab.table),
        dbCall<QueryResult>(scope, 'pageTable', { schema: '', table: tab.table, limit: PAGE_SIZE, offset: nextOffset, filters, sort: nextSort }).result,
      ]);
      if (id !== request.current) return;
      setStructure(loadedStructure);
      setRows(page.rows ?? []);
      setResultColumns(page.columns?.length ? page.columns : Object.keys(page.rows?.[0] ?? {}).sort());
      setTotal(page.totalRows ?? null);
      setOffset(nextOffset);
      setEdits(noEdits());
      setFailedRows(new Set());
      setSelected([]);
      if (page.sizeLimited) notify(t('Rows past 1 MiB were left out of this page.'));
    } catch (loadError) {
      if (id === request.current) setError(failure(loadError));
    } finally {
      if (id === request.current) setLoading(false);
    }
  };

  useEffect(() => {
    void load(0);
  }, [scope, tab.table]);

  /** Runs `change` after the user agreed to drop unsaved edits. */
  const discardingEdits = async (change: () => void) => {
    if (hasEdits) {
      const ok = await confirm({ title: t('Discard changes?'), message: t('Your unsaved changes on this page will be lost.'), confirmLabel: t('Discard'), destructive: true });
      if (!ok) return;
    }
    change();
  };

  // Loaded rows with edits, then inserted rows.
  const shown: Row[] = useMemo(() => {
    const visible = maskRows(rows, profile.maskSensitiveFields, profile.sensitiveColumnPatterns).map((row, index) => {
      const update = edits.updates.get(index);
      return update ? { ...row, ...update } : row;
    });
    return [...visible, ...edits.inserted];
  }, [rows, edits, profile.maskSensitiveFields, profile.sensitiveColumnPatterns]);

  const isInserted = (index: number) => index >= rows.length;

  const setCell = (index: number, column: string, value: unknown) => {
    setEdits(current => {
      if (isInserted(index)) {
        const inserted = [...current.inserted];
        inserted[index - rows.length] = { ...inserted[index - rows.length], [column]: value };
        return { ...current, inserted };
      }
      const updates = new Map(current.updates);
      const row = { ...updates.get(index) };
      // Setting a cell back to its loaded value drops the change.
      if (Object.is(rows[index]?.[column], value)) delete row[column];
      else row[column] = value;
      if (Object.keys(row).length) updates.set(index, row);
      else updates.delete(index);
      return { ...current, updates };
    });
  };

  const useDefault = (index: number, column: string) => {
    if (!isInserted(index)) return;
    setEdits(current => {
      const inserted = [...current.inserted];
      const { [column]: _removed, ...rest } = inserted[index - rows.length];
      inserted[index - rows.length] = rest;
      return { ...current, inserted };
    });
  };

  const canEdit = (column: string) => !readOnly && !masked(column);

  const onEdit = (index: number, column: string, text: string) => {
    if (!canEdit(column)) {
      notify(masked(column) ? t('Masked columns cannot be edited here.') : t('This connection is read-only.'), 'error');
      return;
    }
    setCell(index, column, text);
  };

  const addRow = () => setEdits(current => ({ ...current, inserted: [...current.inserted, {}] }));

  const deleteRows = (indexes: number[]) =>
    setEdits(current => {
      const deleted = new Set(current.deleted);
      const insertedIndexes = new Set(indexes.filter(isInserted).map(index => index - rows.length));
      for (const index of indexes) if (!isInserted(index)) deleted.has(index) ? deleted.delete(index) : deleted.add(index);
      return { ...current, deleted, inserted: current.inserted.filter((_, index) => !insertedIndexes.has(index)) };
    });

  const onPaste = (position: CellPosition, cells: string[][]) => {
    if (readOnly) return;
    const start = columns.indexOf(position.column);
    const extra = position.row + cells.length - shown.length;
    if (extra > 0) setEdits(current => ({ ...current, inserted: [...current.inserted, ...Array.from({ length: extra }, () => ({}))] }));
    cells.forEach((line, rowOffset) =>
      line.forEach((text, columnOffset) => {
        const column = columns[start + columnOffset];
        if (column && canEdit(column)) setCell(position.row + rowOffset, column, text);
      }),
    );
  };

  const typed = (row: Row) => Object.fromEntries(Object.entries(row).map(([column, value]) => [column, typedValue(value, types[column] ?? '', profile.kind)]));

  const keyOf = (index: number): Row | null => {
    if (primaryKey.length === 0) return null;
    const source = rows[index];
    return Object.fromEntries(primaryKey.map(column => [column, source[column]]));
  };

  const apply = async () => {
    const mutations: Mutation[] = [];
    for (const row of edits.inserted) mutations.push({ action: 'insert', table: tab.table, values: typed(row), key: {} });
    const needsKey = [...edits.updates.keys()].some(index => !edits.deleted.has(index)) || edits.deleted.size > 0;
    if (needsKey && primaryKey.length === 0 && profile.kind !== 'mongodb') {
      notify(t('Editing or deleting rows needs a primary key on {table}.', { table: tab.table }), 'error');
      return;
    }
    for (const [index, update] of edits.updates) {
      if (edits.deleted.has(index)) continue;
      mutations.push({ action: 'update', table: tab.table, values: typed(update), key: keyOf(index) ?? mongoKey(rows[index]) });
    }
    for (const index of edits.deleted) mutations.push({ action: 'delete', table: tab.table, values: {}, key: keyOf(index) ?? mongoKey(rows[index]) });
    if (mutations.length === 0) return;
    setApplying(true);
    try {
      const applied = await withConfirmation(
        confirmed => dbIn(scope, 'applyChanges', { schema: '', mutations, confirmed }),
        { title: t('Apply changes?'), message: t('{count} changes will be written to {table}.', { count: mutations.length, table: tab.table }), confirmLabel: t('Apply') },
      );
      if (applied === undefined) return;
      notify(t('Applied {count} changes.', { count: mutations.length }));
      await load(offset);
      void loadTableDetails(profile.id, tab.database ?? profile.database, tab.table);
    } catch (applyError) {
      notify(failure(applyError), 'error');
      setFailedRows(new Set([...edits.updates.keys(), ...edits.deleted]));
    } finally {
      setApplying(false);
    }
  };

  const batchEdit = async () => {
    const targets = selected.length ? selected : [];
    if (targets.length === 0) return notify(t('Select rows first.'), 'error');
    const column = await choose({ title: t('Batch Edit: Column'), options: columns.filter(canEdit).map(name => ({ id: name, label: name })) });
    if (!column) return;
    const value = await prompt({ title: t('Batch Edit: Value'), label: t('New value for {count} rows; enter NULL for null', { count: targets.length }), confirmLabel: t('Set') });
    if (value === null) return;
    for (const index of targets) setCell(index, column, value === 'NULL' ? null : value);
  };

  const replaceInPage = async () => {
    const find = await prompt({ title: t('Replace in Current Page'), label: t('Find'), confirmLabel: t('Next') });
    if (!find) return;
    const replacement = await prompt({ title: t('Replace in Current Page'), label: t('Replace “{text}” with', { text: find }), confirmLabel: t('Replace') });
    if (replacement === null) return;
    let count = 0;
    shown.forEach((row, index) => {
      for (const column of columns) {
        const value = row[column];
        if (typeof value === 'string' && value !== MASK && canEdit(column) && value.includes(find)) {
          setCell(index, column, value.replaceAll(find, replacement));
          count++;
        }
      }
    });
    notify(t('Replaced in {count} cells.', { count }));
  };

  const tools = (): MenuEntry[] => {
    const mongo = profile.kind === 'mongodb';
    return [
      { label: t('Row Details'), disabled: selected.length !== 1, action: () => setDialog({ details: selected[0] }) },
      'separator',
      { label: t('Batch Edit…'), disabled: readOnly || selected.length === 0, action: () => void batchEdit() },
      { label: t('Replace in Current Page…'), disabled: readOnly, action: () => void replaceInPage() },
      { label: t('Delete Selected'), disabled: readOnly || selected.length === 0, destructive: true, action: () => deleteRows(selected) },
      ...(mongo
        ? []
        : [
            'separator' as const,
            { label: t('Export CSV…'), disabled: !hasFileDialogs, action: () => void exportTable(profile, tab.database, tab.table, 'csv') },
            { label: t('Export JSON…'), disabled: !hasFileDialogs, action: () => void exportTable(profile, tab.database, tab.table, 'json') },
            { label: t('Import CSV or JSON…'), disabled: !hasFileDialogs || readOnly, action: () => void importIntoTable(profile, tab.database, tab.table).then(() => load(0)) },
            ...(hasSQLBackup(profile.kind)
              ? [
                  { label: t('Back Up as SQL…'), disabled: !hasFileDialogs, action: () => void backUpTable(profile, tab.database, tab.table) },
                  { label: t('Restore SQL Backup…'), disabled: !hasFileDialogs || readOnly, action: () => void restoreDatabase(profile, tab.database).then(() => load(0)) },
                ]
              : []),
          ]),
    ];
  };

  const cellMenu = (position: CellPosition, selection: number[]): MenuEntry[] => [
    { label: t('Set NULL'), disabled: !canEdit(position.column), action: () => selection.forEach(index => setCell(index, position.column, null)) },
    { label: t('Set Empty String'), disabled: !canEdit(position.column), action: () => selection.forEach(index => setCell(index, position.column, '')) },
    ...(isInserted(position.row) ? [{ label: t('Use Column Default'), action: () => useDefault(position.row, position.column) }] : []),
    'separator',
    { label: t('Row Details'), action: () => setDialog({ details: position.row }) },
    { label: edits.deleted.has(position.row) ? t('Restore Row') : t('Delete Row'), disabled: readOnly, destructive: !edits.deleted.has(position.row), action: () => deleteRows(selection) },
  ];

  const sortBy = (column: string, descending: boolean | null) => {
    const next = descending === null ? [] : [{ column, descending }];
    void discardingEdits(() => {
      setSort(next);
      void load(0, conditions, join, next);
    });
  };

  const cellClass = (index: number, column: string) => {
    if (edits.deleted.has(index)) return 'deleted';
    if (isInserted(index)) return column in (edits.inserted[index - rows.length] ?? {}) ? 'inserted' : 'inserted default';
    if (failedRows.has(index) && edits.updates.get(index)?.[column] !== undefined) return 'failed';
    return edits.updates.get(index) && column in edits.updates.get(index)! ? 'modified' : undefined;
  };

  const first = rows.length ? offset + 1 : 0;
  const last = offset + rows.length;
  const activeFilters = conditions.filter(condition => condition.enabled && condition.column).length;

  return (
    <div class="table-data">
      <div class="toolbar">
        <button class="icon" title={t('Previous page')} aria-label={t('Previous page')} disabled={loading || offset === 0} onClick={() => void discardingEdits(() => void load(Math.max(0, offset - PAGE_SIZE)))}>
          ‹
        </button>
        <span class="page-label">{total !== null ? `${first}-${last} / ${total}` : `${first}-${last}`}</span>
        <button
          class="icon"
          title={t('Next page')}
          aria-label={t('Next page')}
          disabled={loading || (total !== null ? last >= total : rows.length < PAGE_SIZE)}
          onClick={() => void discardingEdits(() => void load(offset + PAGE_SIZE))}
        >
          ›
        </button>
        <button class="icon" title={t('Reload')} aria-label={t('Reload')} disabled={loading} onClick={() => void discardingEdits(() => void load(offset))}>
          ↻
        </button>
        <button class={activeFilters ? 'active' : ''} onClick={() => setDialog('filter')}>
          {activeFilters ? t('WHERE ({count})', { count: activeFilters }) : 'WHERE'}
        </button>
        <button class={sort.length ? 'active' : ''} onClick={() => setDialog('sort')}>
          {sort.length ? t('ORDER BY ({count})', { count: sort.length }) : 'ORDER BY'}
        </button>
        <span class="separator" />
        <button disabled={readOnly} onClick={addRow}>
          ＋ {t('Add Row')}
        </button>
        <button ref={toolsButton} onClick={() => toolsButton.current && showMenuBelow(toolsButton.current, tools())}>
          {t('Data Tools')} ▾
        </button>
        <span class="spacer" />
        {readOnly && <span class="badge">{t('Read-only')}</span>}
        {hasEdits && (
          <>
            <button onClick={() => setEdits(noEdits())}>{t('Discard')}</button>
            <button class="primary" disabled={applying} onClick={() => void apply()}>
              {t('Apply')}
            </button>
          </>
        )}
      </div>
      {error ? (
        <div class="empty-state">
          <p class="error-text">{error}</p>
          <button onClick={() => void load(offset)}>{t('Retry')}</button>
        </div>
      ) : (
        <DataGrid
          columns={columns}
          rows={shown}
          columnDetails={types}
          cellClass={cellClass}
          onEdit={readOnly ? undefined : onEdit}
          cellMenu={cellMenu}
          onPaste={onPaste}
          selectedRows={selected}
          onSelectRows={setSelected}
          headerSuffix={column => {
            const item = sort.find(entry => entry.column === column);
            return item ? (item.descending ? '↓' : '↑') : '';
          }}
          headerMenu={column => [
            { label: t('Sort Ascending'), action: () => sortBy(column, false) },
            { label: t('Sort Descending'), action: () => sortBy(column, true) },
            { label: t('Clear Sort'), disabled: sort.length === 0, action: () => sortBy(column, null) },
          ]}
          emptyText={loading ? t('Loading…') : t('No rows.')}
        />
      )}
      {dialog === 'filter' && (
        <FilterDialog
          columns={columns}
          conditions={conditions}
          join={join}
          onCancel={() => setDialog(null)}
          onApply={(next, nextJoin) => {
            setDialog(null);
            void discardingEdits(() => {
              setConditions(next);
              setJoin(nextJoin);
              void load(0, next, nextJoin);
            });
          }}
        />
      )}
      {dialog === 'sort' && (
        <SortDialog
          columns={columns}
          sort={sort}
          onCancel={() => setDialog(null)}
          onApply={next => {
            setDialog(null);
            void discardingEdits(() => {
              setSort(next);
              void load(0, conditions, join, next);
            });
          }}
        />
      )}
      {dialog && typeof dialog === 'object' && shown[dialog.details] && (
        <RowDetails columns={columns} row={shown[dialog.details]} types={types} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}

/** MongoDB documents are keyed by `_id`. */
function mongoKey(row: Row | undefined): Row {
  return row && '_id' in row ? { _id: row._id } : {};
}

const OPERATORS: { id: Filter['operator']; label: () => string }[] = [
  { id: 'equals', label: () => '=' },
  { id: 'notEquals', label: () => '≠' },
  { id: 'greaterThan', label: () => '>' },
  { id: 'lessThan', label: () => '<' },
  { id: 'contains', label: () => t('contains') },
  { id: 'startsWith', label: () => t('starts with') },
  { id: 'isNull', label: () => 'IS NULL' },
  { id: 'isNotNull', label: () => 'IS NOT NULL' },
];

function FilterDialog(props: { columns: string[]; conditions: Condition[]; join: 'and' | 'or'; onCancel: () => void; onApply: (conditions: Condition[], join: 'and' | 'or') => void }) {
  const blank = (): Condition => ({ enabled: true, column: props.columns[0] ?? '', operator: 'equals', value: '', join: props.join });
  const [conditions, setConditions] = useState<Condition[]>(props.conditions.length ? props.conditions : [blank()]);
  const [join, setJoin] = useState(props.join);
  const change = (index: number, patch: Partial<Condition>) => setConditions(current => current.map((item, position) => (position === index ? { ...item, ...patch } : item)));
  return (
    <Modal
      wide
      title="WHERE"
      onCancel={props.onCancel}
      footer={
        <>
          <button onClick={() => props.onApply([], join)}>{t('Clear All')}</button>
          <span class="spacer" />
          <button onClick={props.onCancel}>{t('Cancel')}</button>
          <button class="primary" onClick={() => props.onApply(conditions, join)}>
            {t('Apply')}
          </button>
        </>
      }
    >
      <div class="condition-join">
        <label class="check">
          <input type="radio" checked={join === 'and'} onInput={() => setJoin('and')} /> {t('Match all (AND)')}
        </label>
        <label class="check">
          <input type="radio" checked={join === 'or'} onInput={() => setJoin('or')} /> {t('Match any (OR)')}
        </label>
      </div>
      {conditions.map((condition, index) => (
        <div key={index} class="condition">
          <input type="checkbox" checked={condition.enabled} aria-label={t('Enabled')} onInput={event => change(index, { enabled: event.currentTarget.checked })} />
          <select value={condition.column} onInput={event => change(index, { column: event.currentTarget.value })}>
            {props.columns.map(column => (
              <option key={column} value={column}>
                {column}
              </option>
            ))}
          </select>
          <select value={condition.operator} onInput={event => change(index, { operator: event.currentTarget.value as Filter['operator'] })}>
            {OPERATORS.map(operator => (
              <option key={operator.id} value={operator.id}>
                {operator.label()}
              </option>
            ))}
          </select>
          <input
            value={condition.value ?? ''}
            disabled={condition.operator === 'isNull' || condition.operator === 'isNotNull'}
            onInput={event => change(index, { value: event.currentTarget.value })}
          />
          <button class="icon" aria-label={t('Remove')} onClick={() => setConditions(current => current.filter((_, position) => position !== index))}>
            −
          </button>
        </div>
      ))}
      <button onClick={() => setConditions(current => [...current, blank()])}>＋ {t('Add Condition')}</button>
    </Modal>
  );
}

function SortDialog(props: { columns: string[]; sort: Sort[]; onCancel: () => void; onApply: (sort: Sort[]) => void }) {
  const [sort, setSort] = useState<Sort[]>(props.sort);
  const unused = props.columns.filter(column => !sort.some(item => item.column === column));
  const move = (index: number, by: number) =>
    setSort(current => {
      const next = [...current];
      const [item] = next.splice(index, 1);
      next.splice(Math.max(0, Math.min(next.length, index + by)), 0, item);
      return next;
    });
  return (
    <Modal
      title="ORDER BY"
      onCancel={props.onCancel}
      footer={
        <>
          <button onClick={() => props.onApply([])}>{t('Clear All')}</button>
          <span class="spacer" />
          <button onClick={props.onCancel}>{t('Cancel')}</button>
          <button class="primary" onClick={() => props.onApply(sort)}>
            {t('Apply')}
          </button>
        </>
      }
    >
      {sort.map((item, index) => (
        <div key={item.column} class="condition">
          <span class="grow">{item.column}</span>
          <select value={item.descending ? 'desc' : 'asc'} onInput={event => setSort(current => current.map((entry, position) => (position === index ? { ...entry, descending: event.currentTarget.value === 'desc' } : entry)))}>
            <option value="asc">{t('Ascending')}</option>
            <option value="desc">{t('Descending')}</option>
          </select>
          <button class="icon" aria-label={t('Move Up')} disabled={index === 0} onClick={() => move(index, -1)}>
            ↑
          </button>
          <button class="icon" aria-label={t('Move Down')} disabled={index === sort.length - 1} onClick={() => move(index, 1)}>
            ↓
          </button>
          <button class="icon" aria-label={t('Remove')} onClick={() => setSort(current => current.filter((_, position) => position !== index))}>
            −
          </button>
        </div>
      ))}
      {unused.length > 0 && (
        <select value="" onInput={event => event.currentTarget.value && setSort(current => [...current, { column: event.currentTarget.value, descending: false }])}>
          <option value="">{t('Add column…')}</option>
          {unused.map(column => (
            <option key={column} value={column}>
              {column}
            </option>
          ))}
        </select>
      )}
    </Modal>
  );
}

function RowDetails(props: { columns: string[]; row: Row; types: Record<string, string>; onClose: () => void }) {
  return (
    <Modal wide title={t('Row Details')} onCancel={props.onClose} footer={<button class="primary" onClick={props.onClose}>{t('Done')}</button>}>
      <dl class="row-details">
        {props.columns.map(column => (
          <div key={column}>
            <dt>
              {column} <span class="muted">{props.types[column]}</span>
            </dt>
            <dd class={props.row[column] === null || props.row[column] === undefined ? 'null' : ''}>{displayValue(props.row[column])}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  );
}

