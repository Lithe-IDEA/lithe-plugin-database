// Cell values as the engine sends them, and the typed values edits send
// back. Decimals and binary data arrive as `{ decimal }` and `{ binary }`.
import type { Row } from './api.ts';

export function displayValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'string') return value === '' ? '""' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object);
    if (keys.length === 1 && typeof object.decimal === 'string') return object.decimal;
    if (keys.length === 1 && typeof object.binary === 'string') return `Binary (${base64Length(object.binary)} bytes)`;
  }
  return JSON.stringify(value);
}

/** The text a cell editor starts with: like the display, without placeholders. */
export function editableText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  const shown = displayValue(value);
  return shown;
}

/** Plain text of a cell for copying, as tab-separated values expect. */
export function copyText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  return displayValue(value);
}

function base64Length(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

/**
 * The value an edited cell sends for a column of `type` (lowercased, as the
 * table description reports it). Text that does not parse as the type is
 * sent as text, and the database decides.
 */
export function typedValue(text: unknown, type: string, kind: string): unknown {
  if (typeof text !== 'string') return text;
  if (type.includes('int') && /^-?\d+$/.test(text)) {
    const number = Number(text);
    if (Number.isSafeInteger(number)) return number;
    return { decimal: text };
  }
  if (type.includes('numeric') || type.includes('decimal')) return { decimal: text };
  if ((type.includes('double') || type.includes('float') || type.includes('real')) && text.trim() !== '' && Number.isFinite(Number(text))) {
    return Number(text);
  }
  if (type === 'boolean' || type === 'bool') {
    const lowered = text.toLowerCase();
    if (lowered === 'true' || lowered === '1') return true;
    if (lowered === 'false' || lowered === '0') return false;
  }
  if (type === 'date') return { date: text };
  if (type.startsWith('time') && !type.includes('stamp')) return { time: text };
  if (type.includes('timestamp with time zone') || type === 'timestamptz') return { timestampWithTimeZone: text };
  if (type.includes('timestamp') || type.includes('datetime')) return { datetime: text };
  if (type === 'uuid') return { uuid: text };
  if (kind === 'mongodb' && ['document', 'array', 'objectid', 'date', 'value'].includes(type)) {
    const parsed = parseJSON(text);
    if (parsed !== undefined) return parsed;
  }
  if (type === 'json' || type === 'jsonb') {
    const parsed = parseJSON(text);
    if (parsed !== undefined) return { json: parsed };
  }
  return text;
}

function parseJSON(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined;

/** The first of `keys` a row has as text; dialects name the same field differently. */
export function field(row: Row, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = text(row[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

export interface ColumnInfo {
  name: string;
  /** Lowercased. */
  type: string;
  nullable: boolean;
  defaultValue: string | undefined;
  primaryKey: boolean;
}

/** Columns of a `describeTable` answer, whatever the dialect's field names. */
export function columnsOf(rows: Row[]): ColumnInfo[] {
  const columns: ColumnInfo[] = [];
  for (const row of rows) {
    const name = field(row, 'column_name', 'COLUMN_NAME', 'name');
    if (name === undefined) continue;
    const nullableText = field(row, 'is_nullable', 'IS_NULLABLE');
    const notNull = typeof row.notnull === 'number' ? row.notnull : undefined;
    columns.push({
      name,
      type: (field(row, 'data_type', 'DATA_TYPE', 'type') ?? '').toLowerCase(),
      nullable: nullableText !== undefined ? nullableText.toUpperCase() !== 'NO' : notNull !== undefined ? notNull === 0 : true,
      defaultValue: field(row, 'column_default', 'COLUMN_DEFAULT', 'dflt_value'),
      primaryKey: row.column_key === 'PRI' || row.COLUMN_KEY === 'PRI' || (typeof row.pk === 'number' && row.pk > 0),
    });
  }
  return columns;
}

export const tableName = (row: Row) => field(row, 'table_name', 'TABLE_NAME', 'name');

export const objectName = (row: Row) =>
  field(row, 'table_name', 'routine_name', 'trigger_name', 'sequence_name', 'name', 'TABLE_NAME', 'ROUTINE_NAME', 'TRIGGER_NAME', 'SEQUENCE_NAME');

export const indexName = (row: Row) => field(row, 'index_name', 'INDEX_NAME', 'name');

export const foreignKeyName = (row: Row) => field(row, 'constraint_name', 'CONSTRAINT_NAME', 'id');

/**
 * The identity of a result's shape. Views rebuild their column arrays on
 * every render, so a grid compares names, not arrays, to tell a new result.
 */
export function columnsKey(columns: string[]): string {
  return JSON.stringify(columns);
}

/** Tab-separated rows, as spreadsheets paste them. */
export function toTSV(columns: string[], rows: Row[], header = false): string {
  const clean = (value: string) => value.replace(/[\t\r\n]+/g, ' ');
  const lines = rows.map(row => columns.map(column => clean(copyText(row[column]))).join('\t'));
  if (header) lines.unshift(columns.map(clean).join('\t'));
  return lines.join('\n');
}

/** Cells of pasted tab-separated text; a trailing newline adds no row. */
export function parseTSV(input: string): string[][] {
  const lines = input.replace(/\r\n?/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.map(line => line.split('\t'));
}

/** Bytes in binary units: 512 B, 1.5 KiB, 12 MiB. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
