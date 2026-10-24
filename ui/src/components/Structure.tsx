import { useEffect, useMemo, useState } from 'preact/hooks';
import { dbIn, failure, loadTableDetails, loadTableStructure, type TableStructure } from '../actions.ts';
import { withConfirmation } from '../guard.ts';
import { t } from '../i18n.ts';
import type { Profile } from '../model.ts';
import { confirm, notify, prompt, type Tab } from '../store.ts';
import { DataGrid } from './DataGrid.tsx';
import { Modal } from './Dialogs.tsx';

type Change =
  | { operation: 'addColumn'; name: string; dataType: string; nullable: boolean; defaultValue: string }
  | { operation: 'renameColumn'; name: string; oldName: string }
  | { operation: 'dropColumn'; name: string }
  | { operation: 'createIndex'; indexName: string; indexColumns: string[] }
  | { operation: 'addForeignKey'; constraintName: string; indexColumns: string[]; referencedTable: string; referencedColumns: string[] };

/** Columns, indexes, and foreign keys of a table, and the schema changes the former module offered. */
export function Structure({ tab, profile }: { tab: Extract<Tab, { kind: 'table' }>; profile: Profile }) {
  const scope = useMemo(() => ({ profileID: profile.id, ...(tab.database ? { database: tab.database } : {}) }), [profile.id, tab.database]);
  const [structure, setStructure] = useState<TableStructure | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<'column' | 'index' | 'foreignKey' | null>(null);
  const readOnly = profile.readOnly;

  const load = async () => {
    setError(null);
    try {
      setStructure(await loadTableStructure(scope, tab.table));
    } catch (loadError) {
      setError(failure(loadError));
    }
  };

  useEffect(() => {
    void load();
  }, [scope, tab.table]);

  const change = async (body: Change, describe: string) => {
    try {
      const done = await withConfirmation(
        confirmed => dbIn(scope, 'schemaChange', { schema: '', table: tab.table, nullable: true, ...body, confirmed }),
        { title: t('Change the table?'), message: describe, confirmLabel: t('Change') },
        body.operation === 'dropColumn',
      );
      if (done === undefined) return false;
      notify(t('{table} was changed.', { table: tab.table }));
      await load();
      void loadTableDetails(profile.id, tab.database ?? profile.database, tab.table);
      return true;
    } catch (changeError) {
      notify(failure(changeError), 'error');
      return false;
    }
  };

  const rename = async (column: string) => {
    const name = (await prompt({ title: t('Rename Column'), label: t('New name of {column}', { column }), value: column, confirmLabel: t('Rename') }))?.trim();
    if (name && name !== column) await change({ operation: 'renameColumn', name, oldName: column }, t('Rename {old} to {new}.', { old: column, new: name }));
  };

  const drop = async (column: string) => {
    const ok = await confirm({ title: t('Drop column?'), message: t('{column} and its data will be permanently removed from {table}.', { column, table: tab.table }), confirmLabel: t('Drop'), destructive: true });
    if (ok) await change({ operation: 'dropColumn', name: column }, t('Drop {column}.', { column }));
  };

  if (error) {
    return (
      <div class="empty-state">
        <p class="error-text">{error}</p>
        <button onClick={() => void load()}>{t('Retry')}</button>
      </div>
    );
  }
  if (!structure) return <div class="empty-state muted">{t('Loading…')}</div>;

  const columnRows = structure.columns.map(column => ({
    [t('Name')]: column.name,
    [t('Type')]: column.type,
    [t('Nullable')]: column.nullable ? t('Yes') : t('No'),
    [t('Default')]: column.defaultValue ?? null,
    [t('Primary key')]: column.primaryKey ? '✓' : '',
  }));
  const columnHeaders = [t('Name'), t('Type'), t('Nullable'), t('Default'), t('Primary key')];
  const rawColumns = (rows: object[]) => [...new Set(rows.flatMap(row => Object.keys(row)))];

  return (
    <div class="structure">
      <div class="toolbar">
        <button disabled={readOnly} onClick={() => setForm('column')}>
          ＋ {t('Add Column')}
        </button>
        <button disabled={readOnly} onClick={() => setForm('index')}>
          ＋ {t('Add Index')}
        </button>
        <button disabled={readOnly} onClick={() => setForm('foreignKey')}>
          ＋ {t('Add Foreign Key')}
        </button>
        <span class="spacer" />
        <button class="icon" aria-label={t('Reload')} title={t('Reload')} onClick={() => void load()}>
          ↻
        </button>
      </div>
      <h3>{t('Columns')}</h3>
      <div class="structure-grid">
        <DataGrid
          columns={columnHeaders}
          rows={columnRows}
          cellMenu={position => {
            const column = structure.columns[position.row]?.name;
            return column
              ? [
                  { label: t('Rename Column…'), disabled: readOnly, action: () => void rename(column) },
                  { label: t('Drop Column…'), disabled: readOnly, destructive: true, action: () => void drop(column) },
                ]
              : [];
          }}
        />
      </div>
      <h3>{t('Indexes')}</h3>
      <div class="structure-grid small">
        <DataGrid columns={rawColumns(structure.indexes)} rows={structure.indexes} emptyText={t('No indexes.')} />
      </div>
      {profile.kind !== 'mongodb' && (
        <>
          <h3>{t('Foreign Keys')}</h3>
          <div class="structure-grid small">
            <DataGrid columns={rawColumns(structure.foreignKeys)} rows={structure.foreignKeys} emptyText={t('No foreign keys.')} />
          </div>
        </>
      )}
      {form === 'column' && <AddColumn onCancel={() => setForm(null)} onSubmit={body => change(body, t('Add column {name} {type}.', { name: body.name, type: body.dataType })).then(ok => ok && setForm(null))} />}
      {form === 'index' && (
        <AddIndex columns={structure.columns.map(column => column.name)} table={tab.table} onCancel={() => setForm(null)} onSubmit={body => change(body, t('Create index {name}.', { name: body.indexName })).then(ok => ok && setForm(null))} />
      )}
      {form === 'foreignKey' && (
        <AddForeignKey
          columns={structure.columns.map(column => column.name)}
          table={tab.table}
          onCancel={() => setForm(null)}
          onSubmit={body => change(body, t('Add foreign key {name}.', { name: body.constraintName })).then(ok => ok && setForm(null))}
        />
      )}
    </div>
  );
}

const list = (text: string) => text.split(',').map(item => item.trim()).filter(Boolean);

function AddColumn(props: { onCancel: () => void; onSubmit: (body: Extract<Change, { operation: 'addColumn' }>) => void }) {
  const [name, setName] = useState('');
  const [dataType, setDataType] = useState('VARCHAR(255)');
  const [nullable, setNullable] = useState(true);
  const [defaultValue, setDefaultValue] = useState('');
  return (
    <Modal
      title={t('Add Column')}
      onCancel={props.onCancel}
      footer={
        <>
          <button onClick={props.onCancel}>{t('Cancel')}</button>
          <button class="primary" disabled={!name.trim() || !dataType.trim()} onClick={() => props.onSubmit({ operation: 'addColumn', name: name.trim(), dataType: dataType.trim(), nullable, defaultValue })}>
            {t('Add')}
          </button>
        </>
      }
    >
      <div class="form">
        <label class="field">
          <span>{t('Name')}</span>
          <input autofocus value={name} onInput={event => setName(event.currentTarget.value)} />
        </label>
        <label class="field">
          <span>{t('Type')}</span>
          <input value={dataType} onInput={event => setDataType(event.currentTarget.value)} />
        </label>
        <label class="check">
          <input type="checkbox" checked={nullable} onInput={event => setNullable(event.currentTarget.checked)} /> {t('Nullable')}
        </label>
        <label class="field">
          <span>{t('Default value')}</span>
          <input value={defaultValue} placeholder={t('None')} onInput={event => setDefaultValue(event.currentTarget.value)} />
        </label>
      </div>
    </Modal>
  );
}

function AddIndex(props: { columns: string[]; table: string; onCancel: () => void; onSubmit: (body: Extract<Change, { operation: 'createIndex' }>) => void }) {
  const [indexColumns, setIndexColumns] = useState<string[]>([]);
  const [indexName, setIndexName] = useState('');
  const name = indexName.trim() || `idx_${props.table}_${indexColumns.join('_')}`;
  return (
    <Modal
      title={t('Add Index')}
      onCancel={props.onCancel}
      footer={
        <>
          <button onClick={props.onCancel}>{t('Cancel')}</button>
          <button class="primary" disabled={indexColumns.length === 0} onClick={() => props.onSubmit({ operation: 'createIndex', indexName: name, indexColumns })}>
            {t('Add')}
          </button>
        </>
      }
    >
      <div class="form">
        <label class="field">
          <span>{t('Name')}</span>
          <input value={indexName} placeholder={name} onInput={event => setIndexName(event.currentTarget.value)} />
        </label>
        <ColumnChecklist columns={props.columns} selected={indexColumns} onChange={setIndexColumns} />
      </div>
    </Modal>
  );
}

function AddForeignKey(props: { columns: string[]; table: string; onCancel: () => void; onSubmit: (body: Extract<Change, { operation: 'addForeignKey' }>) => void }) {
  const [indexColumns, setIndexColumns] = useState<string[]>([]);
  const [constraintName, setConstraintName] = useState('');
  const [referencedTable, setReferencedTable] = useState('');
  const [referencedColumns, setReferencedColumns] = useState('');
  const name = constraintName.trim() || `fk_${props.table}_${referencedTable.trim() || 'ref'}`;
  const valid = indexColumns.length > 0 && referencedTable.trim() && list(referencedColumns).length === indexColumns.length;
  return (
    <Modal
      title={t('Add Foreign Key')}
      onCancel={props.onCancel}
      footer={
        <>
          <button onClick={props.onCancel}>{t('Cancel')}</button>
          <button
            class="primary"
            disabled={!valid}
            onClick={() => props.onSubmit({ operation: 'addForeignKey', constraintName: name, indexColumns, referencedTable: referencedTable.trim(), referencedColumns: list(referencedColumns) })}
          >
            {t('Add')}
          </button>
        </>
      }
    >
      <div class="form">
        <label class="field">
          <span>{t('Name')}</span>
          <input value={constraintName} placeholder={name} onInput={event => setConstraintName(event.currentTarget.value)} />
        </label>
        <ColumnChecklist columns={props.columns} selected={indexColumns} onChange={setIndexColumns} />
        <label class="field">
          <span>{t('Referenced table')}</span>
          <input value={referencedTable} onInput={event => setReferencedTable(event.currentTarget.value)} />
        </label>
        <label class="field">
          <span>{t('Referenced columns, in the same order, separated by commas')}</span>
          <input value={referencedColumns} onInput={event => setReferencedColumns(event.currentTarget.value)} />
        </label>
      </div>
    </Modal>
  );
}

function ColumnChecklist(props: { columns: string[]; selected: string[]; onChange: (columns: string[]) => void }) {
  return (
    <fieldset class="checklist">
      <legend>{t('Columns')}</legend>
      {props.columns.map(column => (
        <label key={column} class="check">
          <input
            type="checkbox"
            checked={props.selected.includes(column)}
            onInput={event => props.onChange(event.currentTarget.checked ? [...props.selected, column] : props.selected.filter(item => item !== column))}
          />
          {column}
        </label>
      ))}
    </fieldset>
  );
}
