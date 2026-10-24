import { openConsole, openHistory } from '../actions.ts';
import { hasFileDialogs } from '../bridge.ts';
import { t } from '../i18n.ts';
import { isSQL, KIND_NAMES, KINDS, newProfile } from '../model.ts';
import { editProfile, showDBXImport, useStore } from '../store.ts';

export function Overview() {
  const profiles = useStore(state => state.profiles);
  const trees = useStore(state => state.trees);
  const history = useStore(state => state.history);
  const connected = profiles.filter(profile => trees[profile.id]?.status === 'ready').length;
  const name = (id: string) => profiles.find(profile => profile.id === id)?.name;
  const recent = history.filter(entry => name(entry.profileID)).slice(0, 8);
  const firstSQL = profiles.find(profile => isSQL(profile.kind));
  return (
    <div class="overview">
      <section class="stats">
        <div>
          <strong>{profiles.length}</strong>
          <span class="muted">{t('Connections')}</span>
        </div>
        <div>
          <strong>{connected}</strong>
          <span class="muted">{t('Connected')}</span>
        </div>
        <div>
          <strong>{history.length}</strong>
          <span class="muted">{t('Recent statements')}</span>
        </div>
      </section>
      <section>
        <h3>{t('New Connection')}</h3>
        <div class="kind-grid">
          {KINDS.map(kind => (
            <button key={kind} onClick={() => editProfile(newProfile(kind), true)}>
              {KIND_NAMES[kind]}
            </button>
          ))}
        </div>
      </section>
      <section>
        <h3>{t('Common Actions')}</h3>
        <div class="actions">
          <button disabled={!firstSQL} onClick={() => firstSQL && openConsole(firstSQL.id)}>
            {t('New Query Console')}
          </button>
          <button onClick={openHistory}>{t('SQL History')}</button>
          <button disabled={!hasFileDialogs} onClick={showDBXImport}>
            {t('Import Connections from DBX…')}
          </button>
        </div>
      </section>
      {recent.length > 0 && (
        <section>
          <h3>{t('Recent SQL')}</h3>
          <ul class="recent">
            {recent.map(entry => (
              <li key={entry.id}>
                <button class="link" title={entry.sql} onClick={() => openConsole(entry.profileID, entry.sql)}>
                  {entry.sql.replace(/\s+/g, ' ').slice(0, 120)}
                </button>
                <span class="muted small"> · {name(entry.profileID)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
