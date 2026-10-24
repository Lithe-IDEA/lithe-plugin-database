// Cases from the tests of Lithe's former DatabaseSQLSupport.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyze, formatSQL, maskRows, quoteIdentifier, statementRanges } from './sql.ts';

test('the analyzer guards unqualified and destructive statements', () => {
  const unsafeUpdate = analyze('UPDATE users SET active = 0');
  assert.equal(unsafeUpdate.kind, 'mutation');
  assert.ok(unsafeUpdate.requiresConfirmation);
  assert.equal(unsafeUpdate.warning, 'unqualifiedWrite');

  const safeDelete = analyze('delete from users where id = 1');
  assert.equal(safeDelete.kind, 'mutation');
  assert.ok(!safeDelete.requiresConfirmation);

  const drop = analyze('-- review first\nDROP TABLE `temporary users`');
  assert.equal(drop.kind, 'definition');
  assert.ok(drop.requiresConfirmation);

  const query = analyze("SELECT 'UPDATE users SET x = 1' AS example");
  assert.equal(query.kind, 'query');
  assert.ok(!query.requiresConfirmation);

  const invalid = analyze('SELEC 1');
  assert.equal(invalid.kind, 'unknown');
  assert.ok(!invalid.requiresConfirmation);
  assert.equal(invalid.warning, 'unrecognized');

  assert.equal(analyze('WITH x AS (SELECT 1) DELETE FROM t WHERE id IN (SELECT * FROM x)').kind, 'mutation');
  assert.equal(analyze('WITH x AS (SELECT 1) SELECT * FROM x').kind, 'query');
});

test('batches split without breaking quoted semicolons', () => {
  const analysis = analyze("SELECT ';' AS marker; -- keep this comment\nSELECT 2;");
  assert.equal(analysis.statementCount, 2);
  assert.equal(analysis.kind, 'batch');
  assert.ok(analysis.statements[0].includes("';'"));
  assert.ok(analysis.statements[1].includes('SELECT 2'));

  assert.equal(analyze("SELECT 'a\\';b'; SELECT 2").statementCount, 2);

  const commentsOnly = analyze('-- review later\n/* no statement */');
  assert.equal(commentsOnly.statementCount, 0);
  assert.equal(commentsOnly.warning, 'empty');
});

test('statement ranges point at the text in the script', () => {
  const sql = "  SELECT '😀;' AS a;\n\nUPDATE t SET x = 1 WHERE id = 2 ;  ";
  const ranges = statementRanges(sql);
  assert.equal(ranges.length, 2);
  for (const range of ranges) assert.equal(sql.slice(range.from, range.to), range.text);
  assert.equal(ranges[0].text, "SELECT '😀;' AS a");
  assert.equal(ranges[1].text, 'UPDATE t SET x = 1 WHERE id = 2');
});

test('the formatter preserves quoted text and word case', () => {
  assert.ok(formatSQL("select  name, 'a  b' from users where id=1;").includes("select\n    name, 'a  b' from users\nwhere id=1;"));
  const withComment = formatSQL('select -- keep this text\nfrom users');
  assert.ok(withComment.includes('-- keep this text'));
  assert.ok(withComment.includes('\nfrom users'));
});

test('the formatter leaves session-dependent escapes verbatim', () => {
  for (const sql of ["SELECT 'C:\\', 'a,b';", "SELECT E'it\\'s FROM here', 'a,b';", "UPDATE settings SET path='C:\\', note='a,b';"]) {
    assert.equal(formatSQL(sql), sql);
  }
});

test('scanners keep combining marks inside literals', () => {
  for (const literal of ['\u0301a,b', "\u0301a''b, c", '\uFE0Fa,b; DROP TABLE t; --']) {
    const sql = `SELECT '${literal}' AS value;`;
    const formatted = formatSQL(sql);
    assert.ok(formatted.includes(`'${literal}'`), formatted);
    assert.equal(formatSQL(formatted), formatted);
    const analysis = analyze(formatted);
    assert.equal(analysis.kind, 'query');
    assert.equal(analysis.statementCount, 1);
    assert.ok(analysis.statements[0].includes(`'${literal}'`));
  }
});

test('the formatter keeps literal and operator tokens', () => {
  const tokens = ['>=', '<>', '!=', '1.25', 't.column::text', 't.order', 't.from', 't.select', "E'it\\'s from here'", "X'AB'", '[a]]b]', '`from`', "'where; 😀'", "'a'\n'b'", '/* outer /* nested */ comment */', '# keep FROM here'];
  for (const sql of [
    'select a>=1, b<>2, c!=3, 1.25, t.column::text from t;',
    "select E'it\\'s from here', X'AB', [a]]b], `from`, 'where; 😀' from t;",
    "select 'a'\n'b' from t;",
    'select t.order, t.from, t.select from t;',
    'select /* outer /* nested */ comment */ a from t;',
    'select a # keep FROM here\nfrom t;',
    'select $$begin SELECT x FROM t; end$$;',
  ]) {
    const formatted = formatSQL(sql);
    assert.equal(formatSQL(formatted), formatted, sql);
    if (sql.includes('$$')) {
      assert.equal(formatted, sql);
      continue;
    }
    for (const token of tokens) if (sql.includes(token)) assert.ok(formatted.includes(token), `${token} in ${formatted}`);
  }
});

test('masking hides configured columns but keeps nulls', () => {
  const rows = [{ id: 7, email: 'user@example.com', api_token: 'secret-value', password: null }];
  const masked = maskRows(rows, true, ['token', 'password']);
  assert.deepEqual(masked, [{ id: 7, email: 'user@example.com', api_token: '******', password: null }]);
  assert.equal(maskRows(rows, false, ['token']), rows);
});

test('identifiers are quoted per dialect', () => {
  assert.equal(quoteIdentifier('mysql', 'a`b'), '`a``b`');
  assert.equal(quoteIdentifier('sqlserver', 'a]b'), '[a]]b]');
  assert.equal(quoteIdentifier('postgresql', 'a"b'), '"a""b"');
});
