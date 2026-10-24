import { useState } from 'preact/hooks';
import { openConsole } from '../actions.ts';
import { t } from '../i18n.ts';
import { useStore } from '../store.ts';
import { copyToClipboard } from './clipboard.ts';
import { Splitter } from './Splitter.tsx';

/** Every connection's SQL history, newest first; an entry opens in a console. */
export function HistoryView() {
  const history = useStore(state => state.history);
  const profiles = useStore(state => state.profiles);
  const [profileID, setProfileID] = useState('');
  const [query, setQuery] = useState('');
  const [selectedID, setSelectedID] = useState<string | null>(null);
  const name = (id: string) => profiles.find(profile => profile.id === id)?.name;
  const entries = history.filter(entry => (!profileID || entry.profileID === profileID) && (!query || entry.sql.toLowerCase().includes(query.toLowerCase())) && name(entry.profileID));
  const selected = entries.find(entry => entry.id === selectedID) ?? entries[0];
  return (
    <div class="history">
      <div class="toolbar">
        <select value={profileID} onInput={event => setProfileID(event.currentTarget.value)}>
          <option value="">{t('All connections')}</option>
          {profiles.map(profile => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </select>
        <input type="search" placeholder={t('Search SQL')} value={query} onInput={event => setQuery(event.currentTarget.value)} />
      </div>
      {entries.length === 0 ? (
        <div class="empty-state muted">{t('No SQL has been run yet.')}</div>
      ) : (
        <Splitter storageKey="history" initial={360} minimum={200} maximum={900}>
          <ul class="history-list" role="listbox">
            {entries.map(entry => (
              <li
                key={entry.id}
                role="option"
                aria-selected={entry.id === selected?.id}
                class={entry.id === selected?.id ? 'selected' : ''}
                onClick={() => setSelectedID(entry.id)}
                onDblClick={() => openConsole(entry.profileID, entry.sql)}
              >
                <div class="history-sql">{entry.sql.replace(/\s+/g, ' ').slice(0, 200)}</div>
                <div class="muted small">
                  {name(entry.profileID)} · {new Date(entry.executedAt).toLocaleString()} · {entry.durationMilliseconds} ms
                  {entry.rowsReturned != null && ` · ${t('{count} rows', { count: entry.rowsReturned })}`}
                  {entry.rowsAffected != null && ` · ${t('{count} affected', { count: entry.rowsAffected })}`}
                </div>
              </li>
            ))}
          </ul>
          {selected && (
            <div class="history-preview">
              <div class="toolbar">
                <button class="primary" onClick={() => openConsole(selected.profileID, selected.sql)}>
                  {t('Open in Console')}
                </button>
                <button onClick={() => copyToClipboard(selected.sql)}>{t('Copy')}</button>
              </div>
              <pre class="sql-preview">{selected.sql}</pre>
            </div>
          )}
        </Splitter>
      )}
    </div>
  );
}
