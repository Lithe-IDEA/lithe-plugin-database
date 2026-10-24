// Moving data between tables and files the user chooses. The backend reads
// and writes the files; the page passes only the chosen path.
import { connect, dbIn, failure, loadDatabase, loadTableDetails, openConsole } from '../actions.ts';
import { exportFile, importFile } from '../api.ts';
import { chooseFile } from '../bridge.ts';
import { withConfirmation } from '../guard.ts';
import { t } from '../i18n.ts';
import type { Profile } from '../model.ts';
import { quoteIdentifier } from '../sql.ts';
import { confirm, notify } from '../store.ts';

type Scope = { profileID: string; database?: string };

const scopeOf = (profile: Profile, database: string | undefined): Scope => ({ profileID: profile.id, ...(database ? { database } : {}) });

const EXPORT_LIMIT = 100_000;

export async function exportTable(profile: Profile, database: string | undefined, table: string, format: 'csv' | 'json'): Promise<void> {
  const path = await chooseFile('save', { title: t('Export {table}', { table }), suggestedName: `${table}.${format}`, extensions: [format] });
  if (!path) return;
  await exportQuery(profile, database, `SELECT * FROM ${quoteIdentifier(profile.kind, table)}`, format, path);
}

/** Exports the rows of `sql`, up to 100,000, to `path`. */
export async function exportQuery(profile: Profile, database: string | undefined, sql: string, format: 'csv' | 'json', path: string): Promise<void> {
  try {
    const params = { sql, values: [], limit: EXPORT_LIMIT };
    const { bytes } = await exportFile(profile.id, format === 'csv' ? 'exportCsv' : 'exportJson', params, path, database).result;
    notify(t('Exported {size} to {path}.', { size: formatBytes(bytes), path }));
  } catch (error) {
    notify(failure(error), 'error');
  }
}

export async function importIntoTable(profile: Profile, database: string | undefined, table: string): Promise<void> {
  const path = await chooseFile('open', { title: t('Import into {table}', { table }), extensions: ['csv', 'json'] });
  if (!path) return;
  const format = path.toLowerCase().endsWith('.json') ? 'json' : 'csv';
  try {
    await withConfirmation(
      confirmed => importFile(profile.id, format === 'csv' ? 'importCsv' : 'importJson', { schema: '', table, confirmed }, path, database).result,
      { title: t('Import data?'), message: t('Rows from {path} will be inserted into {table}.', { path, table }), confirmLabel: t('Import') },
    );
    notify(t('Imported {path} into {table}.', { path, table }));
  } catch (error) {
    notify(failure(error), 'error');
  }
}

export async function backUpDatabase(profile: Profile, database: string | undefined, name: string): Promise<void> {
  const outputPath = await chooseFile('save', { title: t('Export Database as SQL'), suggestedName: `${name || 'database'}.sql`, extensions: ['sql'] });
  if (!outputPath) return;
  try {
    const result = await dbIn<{ byteCount?: number }>(scopeOf(profile, database), 'exportSqlToFile', {
      schema: '',
      selectedTables: [],
      includeStructure: true,
      includeData: true,
      limit: 0,
      outputPath,
    });
    notify(t('Exported {size} to {path}.', { size: formatBytes(result.byteCount ?? 0), path: outputPath }));
  } catch (error) {
    notify(failure(error), 'error');
  }
}

export async function backUpTable(profile: Profile, database: string | undefined, table: string): Promise<void> {
  const outputPath = await chooseFile('save', { title: t('Back Up {table} as SQL', { table }), suggestedName: `${table}.sql`, extensions: ['sql'] });
  if (!outputPath) return;
  try {
    const result = await dbIn<{ byteCount?: number }>(scopeOf(profile, database), 'exportSqlToFile', {
      schema: '',
      selectedTables: [table],
      includeStructure: true,
      includeData: true,
      limit: 0,
      outputPath,
    });
    notify(t('Exported {size} to {path}.', { size: formatBytes(result.byteCount ?? 0), path: outputPath }));
  } catch (error) {
    notify(failure(error), 'error');
  }
}

export async function restoreDatabase(profile: Profile, database: string | undefined): Promise<void> {
  const outputPath = await chooseFile('open', { title: t('Import SQL Backup'), extensions: ['sql'] });
  if (!outputPath) return;
  const ok = await confirm({
    title: t('Import SQL backup?'),
    message: t('The statements in {path} will run on “{name}” and may replace existing data.', { path: outputPath, name: profile.name }),
    confirmLabel: t('Import'),
    destructive: true,
  });
  if (!ok) return;
  try {
    await dbIn(scopeOf(profile, database), 'restoreSqlFile', { schema: '', outputPath, confirmed: true });
    notify(t('Imported {path}.', { path: outputPath }));
    if (database) void loadDatabase(profile.id, database, true);
    else void connect(profile.id);
  } catch (error) {
    notify(failure(error), 'error');
  }
}

async function runDestructive(profile: Profile, database: string | undefined, sql: string, title: string, message: string, label: string): Promise<boolean> {
  const ok = await confirm({ title, message, confirmLabel: label, destructive: true });
  if (!ok) return false;
  try {
    await dbIn(scopeOf(profile, database), 'execute', { sql, values: [], limit: 200, confirmed: true });
    return true;
  } catch (error) {
    notify(failure(error), 'error');
    // The statement is left in a console so the user can see and adjust it.
    openConsole(profile.id, sql, database);
    return false;
  }
}

export async function clearTable(profile: Profile, database: string | undefined, table: string): Promise<void> {
  const quoted = quoteIdentifier(profile.kind, table);
  if (await runDestructive(profile, database, `DELETE FROM ${quoted};`, t('Clear table?'), t('Every row of {table} will be deleted.', { table }), t('Clear'))) {
    notify(t('Cleared {table}.', { table }));
    void loadTableDetails(profile.id, database ?? profile.database, table);
  }
}

export async function dropTable(profile: Profile, database: string | undefined, treeDatabase: string, table: string): Promise<void> {
  const quoted = quoteIdentifier(profile.kind, table);
  if (await runDestructive(profile, database, `DROP TABLE ${quoted};`, t('Delete table?'), t('{table} and all its rows will be permanently deleted.', { table }), t('Delete'))) {
    notify(t('Deleted {table}.', { table }));
    void loadDatabase(profile.id, treeDatabase, true);
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
