import { useState } from 'preact/hooks';
import { api } from '../api.ts';
import { chooseFile, hasFileDialogs } from '../bridge.ts';
import { connect, failure, saveProfile } from '../actions.ts';
import { t } from '../i18n.ts';
import {
  automaticName, defaultDatabase, defaultPort, folderPaths, hasDataGrid, KIND_NAMES, KINDS, type DatabaseKind, type Profile,
} from '../model.ts';
import { closeDialog, useStore, type Dialog } from '../store.ts';
import { copyToClipboard } from './clipboard.ts';
import { Modal } from './Dialogs.tsx';

type Section = 'general' | 'network' | 'safety';

interface TestResult {
  ok: boolean;
  text: string;
}

export function ProfileEditor({ dialog }: { dialog: Extract<Dialog, { kind: 'profile' }> }) {
  const folders = useStore(state => state.folders);
  const [profile, setProfile] = useState<Profile>(dialog.profile);
  // Editing keeps the saved password while the field stays empty.
  const [password, setPassword] = useState('');
  const [section, setSection] = useState<Section>('general');
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [useSSH, setUseSSH] = useState(!!(dialog.profile.sshHost || dialog.profile.proxyURL));
  const [useTLS, setUseTLS] = useState(dialog.profile.ssl);

  const set = <K extends keyof Profile>(key: K, value: Profile[K]) => setProfile(current => ({ ...current, [key]: value }));
  const kind = profile.kind;
  const passwordParam = dialog.isNew || password ? password : undefined;

  const setKind = (next: DatabaseKind) =>
    setProfile(current => ({
      ...current,
      kind: next,
      port: current.port === defaultPort(current.kind) || current.port === 0 ? defaultPort(next) : current.port,
      database: current.database === defaultDatabase(current.kind) ? defaultDatabase(next) : current.database,
      path: next === 'nacos' && !current.path ? '/nacos' : current.kind === 'nacos' && current.path === '/nacos' ? '' : current.path,
      host: next === 'sqlite' ? '' : current.host || '127.0.0.1',
    }));

  /** The profile as it is saved: switched-off options are cleared. */
  const prepared = (): Profile => ({
    ...profile,
    ssl: kind !== 'sqlite' && useTLS,
    caCertificatePath: useTLS ? profile.caCertificatePath : '',
    serverName: useTLS ? profile.serverName : '',
    sshHost: useSSH ? profile.sshHost : '',
    sshPort: useSSH ? profile.sshPort : 22,
    sshUsername: useSSH ? profile.sshUsername : '',
    sshKeyPath: useSSH ? profile.sshKeyPath : '',
    sshLocalPort: useSSH ? profile.sshLocalPort : 0,
    proxyURL: useSSH ? profile.proxyURL : '',
  });

  const runTest = async (): Promise<boolean> => {
    setBusy(true);
    setTest(null);
    const started = performance.now();
    try {
      await api.testConnection(prepared(), passwordParam).result;
      const duration = Math.round(performance.now() - started);
      setTest({ ok: true, text: t('Connected. DBMS: {kind}, {duration} ms', { kind: KIND_NAMES[kind], duration }) });
      return true;
    } catch (error) {
      setTest({ ok: false, text: failure(error) });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const save = async (skipTest = false) => {
    if (!skipTest && !(await runTest())) {
      setSaveFailed(true);
      return;
    }
    setBusy(true);
    try {
      const saved = await saveProfile(prepared(), passwordParam);
      closeDialog(dialog);
      void connect(saved.id);
    } catch (error) {
      setTest({ ok: false, text: failure(error) });
    } finally {
      setBusy(false);
    }
  };

  const browse = async (key: 'path' | 'caCertificatePath' | 'sshKeyPath') => {
    const path = await chooseFile('open', { title: t('Choose a File') });
    if (path) set(key, path);
  };

  const pathField = (key: 'path' | 'caCertificatePath' | 'sshKeyPath', label: string, placeholder = '') => (
    <label class="field">
      <span>{label}</span>
      <div class="input-row">
        <input value={profile[key]} placeholder={placeholder} onInput={event => set(key, event.currentTarget.value)} />
        {hasFileDialogs && (
          <button type="button" onClick={() => void browse(key)}>
            {t('Choose…')}
          </button>
        )}
      </div>
    </label>
  );

  return (
    <Modal
      wide
      title={dialog.isNew ? t('New Connection') : t('Edit Connection')}
      onCancel={() => closeDialog(dialog)}
      footer={
        <>
          <button disabled={busy} onClick={() => void runTest()}>
            {t('Test Connection')}
          </button>
          <span class="spacer" />
          <button onClick={() => closeDialog(dialog)}>{t('Cancel')}</button>
          {saveFailed && test && !test.ok && (
            <button disabled={busy} onClick={() => void save(true)}>
              {t('Save Without Connecting')}
            </button>
          )}
          <button class="primary" disabled={busy} onClick={() => void save()}>
            {t('Connect and Save')}
          </button>
        </>
      }
    >
      <div class="segmented" role="tablist">
        {(['general', 'network', 'safety'] as Section[]).map(item => (
          <button key={item} role="tab" aria-selected={section === item} class={section === item ? 'selected' : ''} onClick={() => setSection(item)}>
            {item === 'general' ? t('General') : item === 'network' ? t('SSH / TLS') : t('Safety and Labels')}
          </button>
        ))}
      </div>

      {section === 'general' && (
        <div class="form">
          <label class="field">
            <span>{t('Name')}</span>
            <input value={profile.name} placeholder={automaticName(profile)} onInput={event => set('name', event.currentTarget.value)} />
          </label>
          <label class="field">
            <span>{t('Database type')}</span>
            <select value={kind} onInput={event => setKind(event.currentTarget.value as DatabaseKind)} disabled={!dialog.isNew}>
              {KINDS.map(item => (
                <option key={item} value={item}>
                  {KIND_NAMES[item]}
                </option>
              ))}
            </select>
          </label>
          {kind === 'sqlite' ? (
            pathField('path', t('Database file path'), '/path/to/database.sqlite')
          ) : (
            <>
              <div class="field-row">
                <label class="field grow">
                  <span>{kind === 'mongodb' ? t('Host or MongoDB URI') : t('Host')}</span>
                  <input value={profile.host} onInput={event => set('host', event.currentTarget.value)} />
                </label>
                <label class="field port">
                  <span>{t('Port')}</span>
                  <input
                    inputMode="numeric"
                    value={profile.port || ''}
                    onInput={event => set('port', Math.min(65535, Number(event.currentTarget.value.replace(/\D/g, '')) || 0))}
                  />
                </label>
              </div>
              <label class="field">
                <span>
                  {kind === 'redis' ? t('ACL user') : t('Username')}
                  {(kind === 'nacos' || kind === 'mongodb' || kind === 'redis') && <em class="muted"> {t('(optional)')}</em>}
                </span>
                <input value={profile.username} autocomplete="off" onInput={event => set('username', event.currentTarget.value)} />
              </label>
              <div class="field-row">
                <label class="field grow">
                  <span>{t('Password')}</span>
                  <input
                    type="password"
                    value={password}
                    autocomplete="new-password"
                    placeholder={dialog.isNew ? '' : t('Unchanged')}
                    onInput={event => setPassword(event.currentTarget.value)}
                  />
                </label>
                <label class="field">
                  <span>{t('Save')}</span>
                  <select value={profile.passwordPersistence} onInput={event => set('passwordPersistence', event.currentTarget.value as Profile['passwordPersistence'])}>
                    <option value="forever">{t('Forever')}</option>
                    <option value="untilRestart">{t('Until restart')}</option>
                  </select>
                </label>
              </div>
              {kind === 'redis' ? (
                <label class="field">
                  <span>{t('Database index')}</span>
                  <input
                    inputMode="numeric"
                    value={profile.database}
                    onInput={event => set('database', event.currentTarget.value.replace(/\D/g, '').slice(0, 10))}
                  />
                </label>
              ) : kind === 'nacos' ? (
                <>
                  <label class="field">
                    <span>{t('Namespace ID')}</span>
                    <input value={profile.database} onInput={event => set('database', event.currentTarget.value)} />
                  </label>
                  <label class="field">
                    <span>{t('API context path')}</span>
                    <input value={profile.path} placeholder="/nacos" onInput={event => set('path', event.currentTarget.value)} />
                  </label>
                </>
              ) : (
                <label class="field">
                  <span>{t('Database')}</span>
                  <input value={profile.database} onInput={event => set('database', event.currentTarget.value)} />
                </label>
              )}
            </>
          )}
        </div>
      )}

      {section === 'network' && (
        <div class="form">
          {kind !== 'sqlite' && (
            <>
              <label class="check">
                <input type="checkbox" checked={useTLS} onInput={event => setUseTLS(event.currentTarget.checked)} />
                {t('Use TLS')}
              </label>
              {useTLS && (
                <>
                  {pathField('caCertificatePath', t('CA certificate'))}
                  <label class="field">
                    <span>{t('Server name')}</span>
                    <input value={profile.serverName} onInput={event => set('serverName', event.currentTarget.value)} />
                  </label>
                </>
              )}
            </>
          )}
          <label class="check">
            <input type="checkbox" checked={useSSH} onInput={event => setUseSSH(event.currentTarget.checked)} />
            {t('Connect through an SSH tunnel')}
          </label>
          {useSSH && (
            <>
              <div class="field-row">
                <label class="field grow">
                  <span>{t('SSH host')}</span>
                  <input value={profile.sshHost} onInput={event => set('sshHost', event.currentTarget.value)} />
                </label>
                <label class="field port">
                  <span>{t('Port')}</span>
                  <input inputMode="numeric" value={profile.sshPort || ''} onInput={event => set('sshPort', Number(event.currentTarget.value.replace(/\D/g, '')) || 0)} />
                </label>
              </div>
              <label class="field">
                <span>{t('SSH user')}</span>
                <input value={profile.sshUsername} onInput={event => set('sshUsername', event.currentTarget.value)} />
              </label>
              {pathField('sshKeyPath', t('Private key'), '~/.ssh/id_ed25519')}
              <label class="field">
                <span>{t('Local port')}</span>
                <input
                  inputMode="numeric"
                  value={profile.sshLocalPort || ''}
                  placeholder={t('Automatic')}
                  onInput={event => set('sshLocalPort', Number(event.currentTarget.value.replace(/\D/g, '')) || 0)}
                />
              </label>
              <label class="field">
                <span>{t('Proxy command')}</span>
                <input value={profile.proxyURL} placeholder="ssh -W %h:%p bastion" onInput={event => set('proxyURL', event.currentTarget.value)} />
              </label>
              <p class="muted small">{t('Lithe uses your SSH configuration and agent; SSH passwords are not supported.')}</p>
            </>
          )}
        </div>
      )}

      {section === 'safety' && (
        <div class="form">
          <label class="field">
            <span>{t('Folder')}</span>
            <select value={profile.folderID ?? ''} onInput={event => set('folderID', event.currentTarget.value || null)}>
              <option value="">{t('Top level')}</option>
              {folderPaths(folders).map(folder => (
                <option key={folder.id} value={folder.id}>
                  {folder.path}
                </option>
              ))}
            </select>
          </label>
          <label class="field">
            <span>{t('Color')}</span>
            <div class="input-row">
              <input type="color" value={/^#[0-9a-f]{6}$/i.test(profile.colorHex) ? profile.colorHex : '#4c8bf5'} onInput={event => set('colorHex', event.currentTarget.value)} />
              <button type="button" onClick={() => set('colorHex', '')}>
                {t('None')}
              </button>
            </div>
          </label>
          <label class="check">
            <input type="checkbox" checked={profile.readOnly} onInput={event => set('readOnly', event.currentTarget.checked)} />
            {t('Read-only: refuse every statement that writes')}
          </label>
          <label class="check">
            <input type="checkbox" checked={profile.productionProtection} onInput={event => set('productionProtection', event.currentTarget.checked)} />
            {t('Production: confirm every write')}
          </label>
          {hasDataGrid(kind) && (
            <>
              <label class="check">
                <input type="checkbox" checked={profile.maskSensitiveFields} onInput={event => set('maskSensitiveFields', event.currentTarget.checked)} />
                {t('Mask sensitive columns')}
              </label>
              {profile.maskSensitiveFields && (
                <label class="field">
                  <span>{t('Column name patterns, separated by commas')}</span>
                  <input
                    value={profile.sensitiveColumnPatterns.join(', ')}
                    onInput={event => set('sensitiveColumnPatterns', event.currentTarget.value.split(',').map(item => item.trim()).filter(Boolean))}
                  />
                </label>
              )}
            </>
          )}
        </div>
      )}

      {test && (
        <div class={`test-result ${test.ok ? 'ok' : 'error'}`}>
          <span>{test.text}</span>
          <button class="link" onClick={() => copyToClipboard(test.text)}>
            {t('Copy')}
          </button>
        </div>
      )}
    </Modal>
  );
}
