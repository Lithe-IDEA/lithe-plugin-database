import assert from 'node:assert/strict';
import { test } from 'node:test';
import { columnsKey, columnsOf, displayValue, parseTSV, toTSV, typedValue } from './values.ts';

test('values display as the former grid showed them', () => {
  assert.equal(displayValue(null), 'NULL');
  assert.equal(displayValue(''), '""');
  assert.equal(displayValue({ decimal: '0.00' }), '0.00');
  assert.equal(displayValue({ binary: 'AAEC' }), 'Binary (3 bytes)');
  assert.equal(displayValue({ base64: 'AAEC' }), '{"base64":"AAEC"}');
  assert.equal(displayValue(7), '7');
});

test('edits are typed by column type', () => {
  assert.equal(typedValue('42', 'bigint', 'mysql'), 42);
  assert.deepEqual(typedValue('12345678901234567890', 'bigint', 'mysql'), { decimal: '12345678901234567890' });
  assert.deepEqual(typedValue('1.10', 'decimal(10,2)', 'mysql'), { decimal: '1.10' });
  assert.equal(typedValue('1.5', 'double precision', 'postgresql'), 1.5);
  assert.equal(typedValue('TRUE', 'boolean', 'postgresql'), true);
  assert.deepEqual(typedValue('2024-01-02', 'date', 'postgresql'), { date: '2024-01-02' });
  assert.deepEqual(typedValue('10:00', 'time without time zone', 'postgresql'), { time: '10:00' });
  assert.deepEqual(typedValue('x', 'timestamp with time zone', 'postgresql'), { timestampWithTimeZone: 'x' });
  assert.deepEqual(typedValue('x', 'datetime', 'mysql'), { datetime: 'x' });
  assert.deepEqual(typedValue('{"a":1}', 'jsonb', 'postgresql'), { json: { a: 1 } });
  assert.deepEqual(typedValue('{"$oid":"1"}', 'objectid', 'mongodb'), { $oid: '1' });
  assert.equal(typedValue('abc', 'int', 'mysql'), 'abc');
  assert.equal(typedValue(null, 'int', 'mysql'), null);
});

test('table descriptions of every dialect yield columns', () => {
  const columns = columnsOf([
    { COLUMN_NAME: 'id', DATA_TYPE: 'INT', IS_NULLABLE: 'NO', COLUMN_KEY: 'PRI' },
    { name: 'note', type: 'TEXT', notnull: 0, dflt_value: "'x'", pk: 0 },
    { column_name: 'code', data_type: 'uuid', is_nullable: 'YES', column_default: null },
  ]);
  assert.deepEqual(columns, [
    { name: 'id', type: 'int', nullable: false, defaultValue: undefined, primaryKey: true },
    { name: 'note', type: 'text', nullable: true, defaultValue: "'x'", primaryKey: false },
    { name: 'code', type: 'uuid', nullable: true, defaultValue: undefined, primaryKey: false },
  ]);
});

test('tab-separated text round-trips', () => {
  const tsv = toTSV(['a', 'b'], [{ a: 1, b: 'x\ty' }, { a: null, b: '' }], true);
  assert.equal(tsv, 'a\tb\n1\tx y\n\t');
  assert.deepEqual(parseTSV('1\t2\r\n3\t4\n'), [['1', '2'], ['3', '4']]);
});

test('a rebuilt column array is the same result', () => {
  assert.equal(columnsKey(['id', 'name']), columnsKey(['id', 'name'].map(name => name)));
  assert.notEqual(columnsKey(['id', 'name']), columnsKey(['name', 'id']));
  assert.notEqual(columnsKey(['a,b']), columnsKey(['a', 'b']));
});
