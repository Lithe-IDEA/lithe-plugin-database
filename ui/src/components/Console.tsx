import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, defaultHighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { MariaSQL, MSSQL, MySQL, PostgreSQL, sql, SQLite, StandardSQL, type SQLDialect } from '@codemirror/lang-sql';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, StateEffect, StateField, type Range } from '@codemirror/state';
import { Decoration, drawSelection, EditorView, highlightActiveLine, keymap, lineNumbers, WidgetType, type DecorationSet } from '@codemirror/view';
import { useEffect, useRef, useState } from 'preact/hooks';
import { connect, dbCall, defaultDatabase, failure, loadDatabase, openHistory, recordHistory } from '../actions.ts';
import type { Call } from '../bridge.ts';
import type { QueryResult, Row } from '../api.ts';
import { withConfirmation } from '../guard.ts';
import { t } from '../i18n.ts';
import { listsDatabases, type DatabaseKind, type Profile } from '../model.ts';
import { analyze, classify, formatSQL, maskRows, statementRanges, usesQueryEndpoint, type Warning } from '../sql.ts';
import { confirm, getState, updateTab, useStore, type Tab } from '../store.ts';
import { DataGrid } from './DataGrid.tsx';
import { showMenuBelow } from './Menu.tsx';
import { Splitter } from './Splitter.tsx';

const QUERY_LIMIT = 10_000;

const DIALECTS: Partial<Record<DatabaseKind, SQLDialect>> = {
  mysql: MySQL,
  mariadb: MariaSQL,
  postgresql: PostgreSQL,
  sqlite: SQLite,
  sqlserver: MSSQL,
};

export function warningText(warning: Warning | null): string {
  switch (warning) {
    case 'unqualifiedWrite':
      return t('This UPDATE or DELETE has no WHERE clause and can affect every row.');
    case 'destructive':
      return t('This statement can permanently remove database objects or data.');
    case 'unrecognized':
      return t('This statement type is not recognized locally; the database will validate it.');
    case 'empty':
      return t('Enter a SQL statement.');
    default:
      return '';
  }
}

// MARK: Statement markers

interface Marker {
  from: number;
  to: number;
  ok: boolean;
  label: string;
}

const setMarkers = StateEffect.define<Marker[]>();

class DurationWidget extends WidgetType {
  readonly ok: boolean;
  readonly label: string;
  constructor(ok: boolean, label: string) {
    super();
    this.ok = ok;
    this.label = label;
  }
  eq(other: DurationWidget) {
    return other.ok === this.ok && other.label === this.label;
  }
  toDOM() {
    const span = document.createElement('span');
    span.className = `statement-duration ${this.ok ? 'ok' : 'failed'}`;
    span.textContent = `${this.ok ? '✓' : '✗'} ${this.label}`;
    return span;
  }
}

/** Outlines of the statements of the last run; edits move or drop them. */
const markers = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    let next = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(setMarkers)) {
        const ranges: Range<Decoration>[] = [];
        for (const marker of effect.value) {
          if (marker.to <= marker.from) continue;
          ranges.push(Decoration.mark({ class: `statement-mark ${marker.ok ? 'ok' : 'failed'}` }).range(marker.from, marker.to));
          ranges.push(Decoration.widget({ widget: new DurationWidget(marker.ok, marker.label), side: 1 }).range(marker.to));
        }
        next = Decoration.set(ranges, true);
      }
    }
    return next;
  },
  provide: field => EditorView.decorations.from(field),
});

// MARK: Console

interface ResultEntry {
  title: string;
  sql: string;
  columns: string[];
  rows: Row[];
  truncated: boolean;
  sizeLimited: boolean;
}

interface LogLine {
  time: string;
  text: string;
  tone: 'sql' | 'info' | 'error';
}

const clock = () => new Date().toLocaleTimeString(undefined, { hour12: false });

export function Console({ tab }: { tab: Extract<Tab, { kind: 'console' }> }) {
  const profile = useStore(state => state.profiles.find(item => item.id === tab.profileID));
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const language = useRef(new Compartment());
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<LogLine[]>([]);
  const [results, setResults] = useState<ResultEntry[]>([]);
  const [resultTab, setResultTab] = useState<number>(-1);
  const currentCall = useRef<Call<unknown> | null>(null);
  const stopped = useRef(false);
  const runButton = useRef<HTMLButtonElement>(null);
  const database = tab.database ?? (profile ? defaultDatabase(profile) : '');
  const tables = useStore(state => state.trees[tab.profileID]?.byDatabase[database]?.tables);
  const databases = useStore(state => state.trees[tab.profileID]?.databases);
  const runRef = useRef<(scope: 'auto' | 'all' | 'selection') => void>(() => {});

  useEffect(() => {
    if (!host.current) return;
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: tab.sql,
        extensions: [
          lineNumbers(),
          history(),
          drawSelection(),
          highlightActiveLine(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          autocompletion(),
          highlightSelectionMatches(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          language.current.of(sql({ dialect: StandardSQL })),
          markers,
          keymap.of([
            { key: 'Mod-Enter', run: () => (runRef.current('auto'), true) },
            { key: 'Shift-Mod-Enter', run: () => (runRef.current('all'), true) },
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...completionKeymap,
            indentWithTab,
          ]),
          EditorView.updateListener.of(update => {
            if (!update.docChanged) return;
            clearTimeout(saveTimer);
            saveTimer = setTimeout(() => updateTab<'console'>(tab.id, () => ({ sql: update.state.doc.toString() })), 300);
          }),
          EditorView.theme({}, { dark: document.documentElement.dataset.theme === 'dark' }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      clearTimeout(saveTimer);
      updateTab<'console'>(tab.id, () => ({ sql: editor.state.doc.toString() }));
      editor.destroy();
    };
  }, []);

  // The dialect and the table names of the console's database feed completion.
  useEffect(() => {
    const editor = view.current;
    if (!editor || !profile) return;
    const schema = Object.fromEntries((tables ?? []).map(name => [name, [] as string[]]));
    editor.dispatch({ effects: language.current.reconfigure(sql({ dialect: DIALECTS[profile.kind] ?? StandardSQL, schema, upperCaseKeywords: true })) });
  }, [profile?.kind, tables]);

  // Tables of the console's database are loaded for completion.
  useEffect(() => {
    if (!profile) return;
    const tree = getState().trees[profile.id];
    if (listsDatabases(profile.kind)) {
      if (!tree || tree.status === 'idle') void connect(profile.id);
      else if (database) void loadDatabase(profile.id, database);
    } else if (!tree || tree.status === 'idle') {
      void connect(profile.id);
    }
  }, [profile?.id, database]);

  // An outside change of the text, such as opening a history entry, replaces the editor's text.
  useEffect(() => {
    const editor = view.current;
    if (editor && tab.sql !== editor.state.doc.toString() && !editor.hasFocus) {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: tab.sql } });
    }
  }, [tab.sql]);

  if (!profile) return <div class="empty-state muted">{t('The connection no longer exists.')}</div>;

  const append = (lines: LogLine[]) => setLog(current => [...current, ...lines].slice(-500));

  const run = async (scope: 'auto' | 'all' | 'selection') => {
    const editor = view.current;
    if (!editor || running) return;
    const selection = editor.state.selection.main;
    const useSelection = scope === 'selection' || (scope === 'auto' && !selection.empty);
    if (scope === 'selection' && selection.empty) return;
    const text = useSelection ? editor.state.sliceDoc(selection.from, selection.to) : editor.state.doc.toString();
    const base = useSelection ? selection.from : 0;
    const analysis = analyze(text);
    if (analysis.statementCount === 0) {
      append([{ time: clock(), text: warningText('empty'), tone: 'error' }]);
      return;
    }
    if (analysis.requiresConfirmation) {
      const ok = await confirm({
        title: analysis.statementCount > 1 ? t('Run batch?') : t('Run statement?'),
        message: warningText(analysis.warning),
        confirmLabel: t('Run'),
        destructive: true,
      });
      if (!ok) return;
    }
    await execute(editor, text, base, analysis.kind, analysis.requiresConfirmation);
  };
  runRef.current = scope => void run(scope);

  const execute = async (editor: EditorView, text: string, base: number, batchKind: string, confirmedRisk: boolean) => {
    const scopeDatabase = listsDatabases(profile.kind) && tab.database ? { database: tab.database } : {};
    const target = { profileID: profile.id, ...scopeDatabase };
    const ranges = statementRanges(text);
    const batchStarted = performance.now();
    const newResults: ResultEntry[] = [];
    const marks: Marker[] = [];
    let confirmed = confirmedRisk;
    let mutated = false;
    let rowsReturned: number | undefined;
    let rowsAffected = 0;
    stopped.current = false;
    setRunning(true);
    editor.dispatch({ effects: setMarkers.of([]) });
    try {
      for (const [index, range] of ranges.entries()) {
        if (stopped.current) break;
        const kind = classify(range.text);
        append([{ time: clock(), text: range.text, tone: 'sql' }]);
        const started = performance.now();
        try {
          // The engine guards both methods itself: a statement that reads
          // but hides a dangerous write (WITH d AS (DELETE ...)) still asks.
          const reads = usesQueryEndpoint(kind);
          const value = await withConfirmation(
            async isConfirmed => {
              const call = reads
                ? dbCall<QueryResult>(target, 'query', { sql: range.text, values: [], limit: QUERY_LIMIT, confirmed: isConfirmed })
                : dbCall(target, 'execute', { sql: range.text, values: [], limit: 200, confirmed: isConfirmed });
              currentCall.current = call;
              const result = await call.result;
              if (isConfirmed) confirmed = true;
              return result;
            },
            { title: t('Run statement?'), message: range.text.slice(0, 600) },
            confirmed,
          );
          if (value === undefined) {
            append([{ time: clock(), text: t('Cancelled.'), tone: 'info' }]);
            break;
          }
          if (!reads) mutated = true;
          const duration = Math.round(performance.now() - started);
          const result = value as QueryResult & { rowsAffected?: number };
          if (Array.isArray(result?.rows)) {
            const rows = maskRows(result.rows, profile.maskSensitiveFields, profile.sensitiveColumnPatterns);
            const columns = result.columns?.length ? result.columns : Object.keys(result.rows[0] ?? {});
            rowsReturned = rows.length;
            newResults.push({ title: t('Result {number}', { number: newResults.length + 1 }), sql: range.text, columns, rows, truncated: !!result.truncated, sizeLimited: !!result.sizeLimited });
            append([{ time: clock(), text: t('{count} rows retrieved in {duration} ms', { count: rows.length, duration }), tone: 'info' }]);
          } else {
            rowsAffected += result?.rowsAffected ?? 0;
            append([{ time: clock(), text: t('{count} rows affected in {duration} ms', { count: result?.rowsAffected ?? 0, duration }), tone: 'info' }]);
          }
          marks.push({ from: base + range.from, to: base + range.to, ok: true, label: `${duration} ms` });
        } catch (error) {
          const duration = Math.round(performance.now() - started);
          marks.push({ from: base + range.from, to: base + range.to, ok: false, label: `${duration} ms` });
          const prefix = ranges.length > 1 ? t('Statement {number} failed; earlier statements may have been applied.', { number: index + 1 }) + ' ' : '';
          append([{ time: clock(), text: prefix + failure(error), tone: 'error' }]);
          break;
        }
      }
    } finally {
      currentCall.current = null;
      setRunning(false);
      if (editor.state.doc.length >= Math.max(0, ...marks.map(mark => mark.to))) editor.dispatch({ effects: setMarkers.of(marks) });
      setResults(newResults);
      setResultTab(newResults.length > 0 ? 0 : -1);
      void recordHistory({
        profileID: profile.id,
        sql: text.trim(),
        kind: batchKind as never,
        executedAt: Date.now(),
        durationMilliseconds: Math.round(performance.now() - batchStarted),
        rowsReturned: rowsReturned ?? null,
        rowsAffected: mutated ? rowsAffected : null,
      });
      if (mutated) void loadDatabase(profile.id, tab.database ?? defaultDatabase(profile), true);
    }
  };

  const cancel = () => {
    stopped.current = true;
    currentCall.current?.cancel();
  };

  const format = () => {
    const editor = view.current;
    if (!editor) return;
    const selection = editor.state.selection.main;
    const from = selection.empty ? 0 : selection.from;
    const to = selection.empty ? editor.state.doc.length : selection.to;
    const formatted = formatSQL(editor.state.sliceDoc(from, to));
    editor.dispatch({ changes: { from, to, insert: formatted } });
    editor.focus();
  };

  const active = results[resultTab];

  return (
    <div class="console">
      <div class="toolbar">
        <button class="primary" disabled={running} onClick={() => void run('auto')} title={t('Run (⌘↩)')}>
          ▶ {t('Run')}
        </button>
        <button
          ref={runButton}
          class="icon"
          disabled={running}
          aria-label={t('Run Options')}
          onClick={() =>
            runButton.current &&
            showMenuBelow(runButton.current, [
              { label: t('Run All'), action: () => void run('all') },
              { label: t('Run Selection'), action: () => void run('selection') },
            ])
          }
        >
          ▾
        </button>
        <button disabled={!running} onClick={cancel}>
          ■ {t('Cancel')}
        </button>
        <button onClick={format}>{t('Format')}</button>
        <button onClick={openHistory}>{t('History')}</button>
        <span class="spacer" />
        {listsDatabases(profile.kind) && (
          <DatabasePicker profile={profile} database={tab.database ?? profile.database} databases={databases ?? []} onChange={value => updateTab<'console'>(tab.id, () => ({ database: value }))} />
        )}
        {profile.readOnly && <span class="badge">{t('Read-only')}</span>}
        {profile.productionProtection && <span class="badge warning">{t('Production')}</span>}
      </div>
      <Splitter storageKey="console" initial={220} minimum={80} maximum={2000} vertical>
        <div class="editor" ref={host} />
        <div class="results">
          <div class="result-tabs" role="tablist">
            <button role="tab" aria-selected={resultTab === -1} class={resultTab === -1 ? 'selected' : ''} onClick={() => setResultTab(-1)}>
              {t('Output')}
            </button>
            {results.map((result, index) => (
              <button key={index} role="tab" aria-selected={resultTab === index} class={resultTab === index ? 'selected' : ''} title={result.sql} onClick={() => setResultTab(index)}>
                {result.title}
              </button>
            ))}
            <span class="spacer" />
            {active && (active.truncated || active.sizeLimited) && (
              <span class="badge warning">
                {active.sizeLimited ? t('Showing the first {count} rows that fit in 1 MiB', { count: active.rows.length }) : t('Limited to {count} rows', { count: QUERY_LIMIT.toLocaleString() })}
              </span>
            )}
            {resultTab === -1 && log.length > 0 && (
              <button class="link" onClick={() => setLog([])}>
                {t('Clear')}
              </button>
            )}
          </div>
          {resultTab === -1 || !active ? (
            <div class="output" role="log">
              {log.length === 0 && <p class="muted">{t('Run a statement to see its output here.')}</p>}
              {log.map((line, index) => (
                <div key={index} class={`output-line ${line.tone}`}>
                  <span class="output-time">[{line.time}]</span> <span>{line.text}</span>
                </div>
              ))}
              {running && <div class="output-line info muted">{t('Running…')}</div>}
            </div>
          ) : (
            <DataGrid columns={active.columns} rows={active.rows} />
          )}
        </div>
      </Splitter>
    </div>
  );
}

function DatabasePicker(props: { profile: Profile; database: string; databases: string[]; onChange: (database: string) => void }) {
  const options = props.databases.includes(props.database) || !props.database ? props.databases : [props.database, ...props.databases];
  return (
    <label class="inline-field">
      <span>{t('Database')}</span>
      <select value={props.database} onInput={event => props.onChange(event.currentTarget.value)}>
        {!props.database && <option value="">{t('Default')}</option>}
        {options.map(name => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      <button class="icon" aria-label={t('Refresh')} title={t('Refresh')} onClick={() => void connect(props.profile.id)}>
        ↻
      </button>
    </label>
  );
}
