import { useEffect, useMemo, useState } from 'preact/hooks';
import { failure } from '../actions.ts';
import { db, type Row } from '../api.ts';
import { formatBytes } from '../values.ts';
import { errorCode } from '../bridge.ts';
import { withConfirmation } from '../guard.ts';
import { t } from '../i18n.ts';
import type { Profile } from '../model.ts';
import { confirm, useStore, type LoadStatus, type Tab } from '../store.ts';
import { copyToClipboard } from './clipboard.ts';
import { DataGrid } from './DataGrid.tsx';
import { STALE, useLatestCall } from '../latest.ts';
import { Splitter } from './Splitter.tsx';

const SCAN_COUNT = 100;

interface KeySummary {
  key: string;
  type: string;
  /** Seconds; -1 without expiry, -2 when the key is gone. */
  ttl: number;
  /** Memory use in bytes; -1 when not estimated. */
  size: number;
}

interface ScanPage {
  keys: KeySummary[];
  /** "0" when the scan is complete. */
  nextCursor: string;
}

interface HashEntry {
  field: string;
  value: string;
}

interface KeyDetail {
  key: string;
  type: string;
  ttl: number;
  /** Bytes of a string, else the number of elements. */
  size: number;
  stringValue?: string | null;
  hashEntries: HashEntry[];
}

const DURATION_UNITS: [number, (count: number) => string][] = [
  [86_400, count => t('{count} d', { count })],
  [3_600, count => t('{count} h', { count })],
  [60, count => t('{count} min', { count })],
  [1, count => t('{count} s', { count })],
];

/** A duration in its two largest units, such as "2 h 5 min". */
function durationText(seconds: number): string {
  const parts: string[] = [];
  let rest = seconds;
  for (const [size, label] of DURATION_UNITS) {
    if (parts.length === 2) break;
    if (rest >= size || (size === 1 && parts.length === 0)) {
      parts.push(label(Math.floor(rest / size)));
      rest %= size;
    }
  }
  return parts.join(' ');
}

function ttlText(ttl: number): string {
  if (ttl === -1) return t('No expiry');
  if (ttl === -2) return t('Expired');
  return ttl < 0 ? t('Unknown') : durationText(ttl);
}

function detailSizeText(detail: KeyDetail): string {
  return detail.type === 'string' ? formatBytes(detail.size) : t('{count} elements', { count: detail.size.toLocaleString() });
}

/** The text of the TTL field for a loaded key. */
const ttlDraftOf = (detail: KeyDetail) => String(detail.ttl >= 0 ? detail.ttl : -1);

/** A TTL the engine accepts: -1 or whole seconds; null otherwise. */
function parseTTL(text: string): number | null {
  const value = text.trim();
  if (!/^-?\d+$/.test(value)) return null;
  const ttl = Number(value);
  return Number.isSafeInteger(ttl) && ttl >= -1 ? ttl : null;
}

/** The fields of a hash as sorted, indented JSON, the form the editor uses. */
function hashText(entries: HashEntry[]): string {
  const sorted = [...entries].sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0));
  return JSON.stringify(Object.fromEntries(sorted.map(entry => [entry.field, entry.value])), null, 2);
}

/** The fields of the hash editor's text, sorted by field; null unless it is an object of strings. */
function parseHash(text: string): HashEntry[] | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.some(([, item]) => typeof item !== 'string')) return null;
  return entries
    .map(([field, item]) => ({ field, value: item as string }))
    .sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0));
}

/** Keys of a further scan page join the list once; SCAN may repeat keys. */
function mergeKeys(current: KeySummary[], page: KeySummary[]): KeySummary[] {
  const known = new Set(current.map(item => item.key));
  return [...current, ...page.filter(item => !known.has(item.key))];
}

/**
 * The Redis key browser: incremental SCAN pages on the left and the selected
 * key on the right. A value loads only when its key is selected, so a large
 * keyspace stays responsive; strings and hashes can be edited.
 */
export function RedisView({ tab }: { tab: Extract<Tab, { kind: 'redis' }> }) {
  const profile = useStore(state => state.profiles.find(item => item.id === tab.profileID));
  if (!profile) return <div class="empty-state muted">{t('The connection no longer exists.')}</div>;
  return <KeyBrowser profile={profile} />;
}

function KeyBrowser({ profile }: { profile: Profile }) {
  const [pattern, setPattern] = useState('*');
  const [includeSize, setIncludeSize] = useState(true);
  // The pattern of the list shown; further pages and refreshes reuse it.
  const [scanned, setScanned] = useState('*');
  const [keys, setKeys] = useState<KeySummary[]>([]);
  const [nextCursor, setNextCursor] = useState('0');
  const [scanStatus, setScanStatus] = useState<LoadStatus>('idle');
  const [scanError, setScanError] = useState<string>();
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<KeyDetail | null>(null);
  const [detailStatus, setDetailStatus] = useState<LoadStatus>('idle');
  const [detailError, setDetailError] = useState<string>();
  const [renameDraft, setRenameDraft] = useState('');
  const [ttlDraft, setTTLDraft] = useState('');
  const [stringDraft, setStringDraft] = useState('');
  const [hashDraft, setHashDraft] = useState('{}');
  const [busy, setBusy] = useState(false);
  const [editError, setEditError] = useState<string>();
  const scanRequest = useLatestCall();
  const detailRequest = useLatestCall();
  const columns = useMemo(() => [t('Key'), t('Type'), t('TTL'), t('Size')], []);

  useEffect(() => {
    void scan({ pattern: '*' });
  }, [profile.id]);

  const scan = async (options: { more?: boolean; pattern?: string; includeSize?: boolean } = {}) => {
    const searched = options.more ? scanned : (options.pattern ?? scanned).trim() || '*';
    const cursor = options.more ? nextCursor : '0';
    if (options.more && cursor === '0') return;
    setScanned(searched);
    setScanStatus('loading');
    setScanError(undefined);
    try {
      const page = await scanRequest.run(
        db<ScanPage>(profile.id, 'redisScan', { cursor, pattern: searched, count: SCAN_COUNT, includeSize: options.includeSize ?? includeSize }),
      );
      if (page === STALE) return;
      setKeys(current => (options.more ? mergeKeys(current, page.keys) : page.keys));
      setNextCursor(page.nextCursor);
      setScanStatus('ready');
    } catch (error) {
      setScanStatus('failed');
      setScanError(failure(error));
    }
  };

  /** Loads a key into the detail; after a write, a key that is gone clears the selection. */
  const select = async (key: string | null, afterWrite = false) => {
    setSelected(key);
    if (!afterWrite) setEditError(undefined);
    if (key === null) {
      detailRequest.cancel();
      setDetail(null);
      setDetailStatus('idle');
      return;
    }
    setDetailStatus('loading');
    setDetailError(undefined);
    try {
      const loaded = await detailRequest.run(db<KeyDetail>(profile.id, 'redisGetKey', { key }));
      if (loaded === STALE) return;
      setDetail(loaded);
      setRenameDraft(loaded.key);
      setTTLDraft(ttlDraftOf(loaded));
      setStringDraft(loaded.stringValue ?? '');
      setHashDraft(hashText(loaded.hashEntries));
      setDetailStatus('ready');
    } catch (error) {
      if (afterWrite && errorCode(error) === 'not_found') return select(null);
      setDetail(null);
      setDetailStatus('failed');
      setDetailError(failure(error));
    }
  };

  const search = () => {
    void select(null);
    void scan({ pattern });
  };

  /**
   * Runs a write with `confirmed`, asking first on a production connection,
   * then rescans the list and loads `next`, the key to show afterwards.
   */
  const write = async (
    describe: { title: string; message: string; confirmLabel?: string },
    method: string,
    params: object,
    next: string | null,
    alreadyConfirmed = false,
  ) => {
    setBusy(true);
    setEditError(undefined);
    try {
      const done = await withConfirmation(
        confirmed => db(profile.id, method, { ...params, confirmed }).result,
        describe,
        alreadyConfirmed,
      );
      if (done === undefined) return;
      await Promise.all([scan(), select(next, true)]);
    } catch (error) {
      setEditError(failure(error));
    } finally {
      setBusy(false);
    }
  };

  const rename = async (current: KeyDetail) => {
    const newKey = renameDraft;
    if (!newKey.trim() || newKey === current.key) return;
    // RENAME silently replaces a key that has the new name.
    if (keys.some(item => item.key === newKey)) {
      const ok = await confirm({
        title: t('Replace existing key?'),
        message: t('A key named “{name}” exists and will be replaced.', { name: newKey }),
        confirmLabel: t('Replace'),
        destructive: true,
      });
      if (!ok) return;
    }
    await write(
      { title: t('Rename Redis key?'), message: t('“{key}” will be renamed to “{newKey}”.', { key: current.key, newKey }), confirmLabel: t('Rename') },
      'redisRenameKey',
      { key: current.key, newKey },
      newKey,
    );
  };

  const setTTL = async (current: KeyDetail) => {
    const ttl = parseTTL(ttlDraft);
    if (ttl === null) {
      setEditError(t('TTL must be -1 or a whole number of seconds.'));
      return;
    }
    await write(
      { title: t('Change TTL?'), message: t('The TTL of “{key}” will change to {ttl}.', { key: current.key, ttl: ttlText(ttl) }), confirmLabel: t('Set TTL') },
      'redisSetTTL',
      { key: current.key, ttl },
      current.key,
    );
  };

  const saveString = async (current: KeyDetail) => {
    // An untouched TTL field leaves the TTL to the engine, which keeps it to the millisecond.
    const text = ttlDraft.trim();
    const changed = text !== '' && text !== ttlDraftOf(current);
    const ttl = changed ? parseTTL(text) : undefined;
    if (ttl === null) {
      setEditError(t('TTL must be -1 or a whole number of seconds.'));
      return;
    }
    await write(
      { title: t('Save value?'), message: t('The value of “{key}” will be replaced.', { key: current.key }), confirmLabel: t('Save') },
      'redisSetString',
      { key: current.key, value: stringDraft, ...(ttl === undefined ? {} : { ttl }) },
      current.key,
    );
  };

  const saveHash = async (current: KeyDetail) => {
    const entries = parseHash(hashDraft);
    if (!entries) {
      setEditError(t('Hash fields must be a JSON object whose values are strings.'));
      return;
    }
    await write(
      { title: t('Save hash?'), message: t('The fields of “{key}” will be replaced.', { key: current.key }), confirmLabel: t('Save') },
      'redisReplaceHash',
      { key: current.key, entries },
      current.key,
    );
  };

  const remove = async (current: KeyDetail) => {
    const message = t('“{key}” will be deleted. This cannot be undone.', { key: current.key });
    const ok = await confirm({
      title: t('Delete Redis key?'),
      message: profile.productionProtection ? `${message}\n\n${t('This connection is marked as production.')}` : message,
      confirmLabel: t('Delete'),
      destructive: true,
    });
    if (!ok) return;
    // The dialog above is the confirmation the engine asks for.
    await write({ title: t('Delete Redis key?'), message, confirmLabel: t('Delete') }, 'redisDeleteKey', { key: current.key }, null, true);
  };

  const rows: Row[] = keys.map(item => ({
    [columns[0]]: item.key,
    [columns[1]]: item.type.toUpperCase(),
    [columns[2]]: ttlText(item.ttl),
    [columns[3]]: item.size < 0 ? '—' : formatBytes(item.size),
  }));
  const selectedIndex = selected === null ? -1 : keys.findIndex(item => item.key === selected);
  const scanning = scanStatus === 'loading';
  const more = nextCursor !== '0';
  const locked = profile.readOnly || busy;

  return (
    <div class="specialized-view">
      <form
        class="toolbar"
        onSubmit={event => {
          event.preventDefault();
          search();
        }}
      >
        <input class="search" type="search" placeholder={t('Key pattern, e.g. user:*')} value={pattern} onInput={event => setPattern(event.currentTarget.value)} />
        <button type="submit" disabled={scanning}>
          {t('Search')}
        </button>
        <label class="check" title={t('Estimate the memory each key uses while scanning')}>
          <input
            type="checkbox"
            checked={includeSize}
            onInput={event => {
              const checked = event.currentTarget.checked;
              setIncludeSize(checked);
              void scan({ includeSize: checked });
            }}
          />
          {t('Estimate size')}
        </label>
        <span class="spacer" />
        <span class="badge">{t('Database {index}', { index: profile.database || '0' })}</span>
        {profile.readOnly && <span class="badge">{t('Read-only')}</span>}
        {profile.productionProtection && <span class="badge warning">{t('Production')}</span>}
      </form>
      <Splitter storageKey="redis" initial={340} minimum={220} maximum={900}>
        <div class="pane">
          {scanError && keys.length > 0 && (
            <div class="inline-error" role="alert">
              {scanError}
            </div>
          )}
          {scanError && keys.length === 0 ? (
            <div class="empty-state">
              <p class="error-text">{scanError}</p>
              <button onClick={() => void scan()}>{t('Retry')}</button>
            </div>
          ) : (
            <DataGrid
              columns={columns}
              rows={rows}
              selectedRows={selectedIndex >= 0 ? [selectedIndex] : []}
              onSelectRows={indexes => {
                const key = indexes.length === 1 ? keys[indexes[0]]?.key : undefined;
                if (key !== undefined && (key !== selected || detailStatus === 'failed')) void select(key);
              }}
              emptyText={scanning ? t('Scanning keys…') : more ? t('No matching keys in this part of the scan yet.') : t('No keys match this pattern.')}
            />
          )}
          <div class="toolbar pane-footer">
            <span class="muted">{scanning ? t('Scanning keys…') : more ? t('{count} keys so far', { count: keys.length }) : t('{count} keys', { count: keys.length })}</span>
            <span class="spacer" />
            {more && (
              <button class="link" disabled={scanning} onClick={() => void scan({ more: true })}>
                {t('Load next scan page')}
              </button>
            )}
          </div>
        </div>
        <div class="pane">
          {detail ? (
            <>
              <div class="toolbar detail-header">
                <span class="badge">{detail.type.toUpperCase()}</span>
                <span class="detail-title" title={detail.key}>
                  {detail.key}
                </span>
                <span class="muted">
                  {detailSizeText(detail)} · {ttlText(detail.ttl)}
                </span>
                {detailStatus === 'loading' && <span class="muted">{t('Loading…')}</span>}
                <span class="spacer" />
                <button class="icon" title={t('Copy Name')} aria-label={t('Copy Name')} onClick={() => copyToClipboard(detail.key)}>
                  ⧉
                </button>
                <button class="destructive" disabled={locked} onClick={() => void remove(detail)}>
                  {t('Delete')}
                </button>
              </div>
              {editError && (
                <div class="inline-error" role="alert">
                  {editError}
                </div>
              )}
              <div class="pane-body">
                <div class="form">
                  <h3 class="section-title">{t('Key settings')}</h3>
                  <div class="field-row">
                    <label class="field grow">
                      <span>{t('Name')}</span>
                      <input value={renameDraft} readOnly={profile.readOnly} onInput={event => setRenameDraft(event.currentTarget.value)} />
                    </label>
                    <button disabled={locked || !renameDraft.trim() || renameDraft === detail.key} onClick={() => void rename(detail)}>
                      {t('Rename')}
                    </button>
                  </div>
                  <div class="field-row">
                    <label class="field grow">
                      <span>{t('TTL in seconds (-1 for no expiry)')}</span>
                      <input inputMode="numeric" value={ttlDraft} readOnly={profile.readOnly} onInput={event => setTTLDraft(event.currentTarget.value)} />
                    </label>
                    <button disabled={locked || !ttlDraft.trim()} onClick={() => void setTTL(detail)}>
                      {t('Set TTL')}
                    </button>
                  </div>
                </div>
                {detail.type === 'string' ? (
                  <div class="form grow">
                    <h3 class="section-title">{t('String value')}</h3>
                    <textarea
                      class="code-editor"
                      spellcheck={false}
                      value={stringDraft}
                      readOnly={profile.readOnly}
                      onInput={event => setStringDraft(event.currentTarget.value)}
                    />
                    <div class="toolbar">
                      <span class="muted">{t('Saving keeps the current TTL unless you change it above.')}</span>
                      <span class="spacer" />
                      <button class="primary" disabled={locked} onClick={() => void saveString(detail)}>
                        {t('Save')}
                      </button>
                    </div>
                  </div>
                ) : detail.type === 'hash' ? (
                  <div class="form grow">
                    <h3 class="section-title">{t('Hash fields')}</h3>
                    <p class="muted">{t('Edit the fields as a JSON object of strings. Saving replaces the whole hash and keeps its TTL.')}</p>
                    <textarea
                      class="code-editor"
                      spellcheck={false}
                      value={hashDraft}
                      readOnly={profile.readOnly}
                      onInput={event => setHashDraft(event.currentTarget.value)}
                    />
                    <div class="toolbar">
                      <span class="spacer" />
                      <button class="primary" disabled={locked} onClick={() => void saveHash(detail)}>
                        {t('Save')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div class="empty-state">
                    <p>{t('Read-only key type')}</p>
                    <p class="muted">{t('This key is a {type}. Strings and hashes can be edited here; other types can be renamed, given a TTL, or deleted.', { type: detail.type })}</p>
                  </div>
                )}
              </div>
            </>
          ) : detailStatus === 'loading' ? (
            <div class="empty-state muted">{t('Loading…')}</div>
          ) : detailStatus === 'failed' ? (
            <div class="empty-state">
              <p class="error-text">{detailError}</p>
              {selected !== null && <button onClick={() => void select(selected)}>{t('Retry')}</button>}
            </div>
          ) : (
            <div class="empty-state">
              <p>{t('Select a Redis key')}</p>
              <p class="muted">{t('A value loads only when you select its key, which keeps large databases responsive.')}</p>
            </div>
          )}
        </div>
      </Splitter>
    </div>
  );
}
