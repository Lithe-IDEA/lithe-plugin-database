// Imports connections from a DBX export. The backend reads the file, so the
// page only holds its path, the export password, and which connections the
// user selected; connections are saved without being tested.
import { useEffect, useRef, useState } from 'preact/hooks';
import { api, type DBXPreview } from '../api.ts';
import { failure, loadWorkspace } from '../actions.ts';
import { chooseFile, errorCode } from '../bridge.ts';
import { t } from '../i18n.ts';
import { KIND_NAMES, type DatabaseKind } from '../model.ts';
import { closeDialog, notify, type Dialog } from '../store.ts';
import { Modal } from './Dialogs.tsx';

type Connection = DBXPreview['connections'][number];

/** The backend's warning keys, in the user's language. */
function warningText(key: string): string {
  switch (key) {
    case 'multipleSSH':
      return t('Only the first SSH tunnel was imported.');
    case 'sshPassword':
      return t('The SSH password could not be imported; select an SSH key or enter it again.');
    case 'httpTunnel':
      return t('DBX HTTP tunnel settings are not supported.');
    case 'proxy':
      return t('DBX proxy settings require manual review.');
    case 'connectionString':
      return t('The DBX connection string requires manual review.');
    case 'clientCertificates':
      return t('Client certificate settings require manual review.');
    case 'urlParameters':
      return t('DBX URL parameters require manual review.');
    case 'redisSentinelOrCluster':
      return t('Redis Sentinel or Cluster settings require manual review.');
    default:
      return key;
  }
}

function errorText(error: unknown): string {
  switch (errorCode(error)) {
    case 'database.dbxInvalidFile':
      return t('The selected file is not a valid DBX connection export.');
    case 'database.dbxPasswordInvalid':
      return t('The DBX export password is incorrect.');
    case 'database.dbxUnsupportedVersion':
      return t('This DBX encrypted export version is not supported.');
    default:
      return failure(error);
  }
}

function endpoint(connection: Connection): string {
  if (connection.kind === 'sqlite' || !connection.port) return connection.host;
  return `${connection.host}:${connection.port}`;
}

export function DBXImport({ dialog }: { dialog: Extract<Dialog, { kind: 'dbx' }> }) {
  const [path, setPath] = useState<string | null>(null);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [password, setPassword] = useState('');
  // The password that opened the file; importing reads the file again.
  const [unlockedWith, setUnlockedWith] = useState<string | undefined>(undefined);
  const [preview, setPreview] = useState<DBXPreview | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const passwordField = useRef<HTMLInputElement>(null);

  const close = () => closeDialog(dialog);

  const read = async (file: string, filePassword?: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.previewDBX(file, filePassword);
      setPreview(result);
      setUnlockedWith(filePassword);
      setNeedsPassword(false);
      setPassword('');
      setSelected(new Set(result.connections.filter(connection => !connection.duplicate).map(connection => connection.id)));
    } catch (failed) {
      const code = errorCode(failed);
      if (code === 'database.dbxPasswordRequired' || code === 'database.dbxPasswordInvalid') {
        setNeedsPassword(true);
        if (code === 'database.dbxPasswordInvalid') setError(errorText(failed));
      } else {
        setError(errorText(failed));
      }
    } finally {
      setBusy(false);
    }
  };

  const choose = async () => {
    let file: string | null;
    try {
      file = await chooseFile('open', { title: t('Choose a DBX Export'), extensions: ['json', 'dbx'] });
    } catch (failed) {
      setError(failure(failed));
      return;
    }
    if (!file) {
      // Cancelling the first file dialog cancels the import.
      if (!path) close();
      return;
    }
    setPath(file);
    setPreview(null);
    setNeedsPassword(false);
    setPassword('');
    setUnlockedWith(undefined);
    await read(file);
  };

  useEffect(() => {
    void choose();
  }, []);

  useEffect(() => {
    if (needsPassword) passwordField.current?.focus();
  }, [needsPassword]);

  const unlock = () => {
    if (path && password && !busy) void read(path, password);
  };

  const runImport = async () => {
    if (!path || !preview || selected.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      const { imported } = await api.importDBX(path, unlockedWith, [...selected]);
      if (imported === 0) {
        setError(t('Nothing was imported: the selected connections are already saved.'));
        return;
      }
      close();
      notify(t('Imported {count} connections.', { count: imported }));
      await loadWorkspace();
    } catch (failed) {
      setError(errorText(failed));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (connection: Connection, checked: boolean) =>
    setSelected(current => {
      const next = new Set(current);
      if (checked) next.add(connection.id);
      else next.delete(connection.id);
      return next;
    });

  const importable = preview?.connections.filter(connection => !connection.duplicate) ?? [];
  const duplicates = (preview?.connections.length ?? 0) - importable.length;
  const allSelected = importable.length > 0 && importable.every(connection => selected.has(connection.id));

  return (
    <Modal
      wide
      title={t('Import Connections from DBX')}
      onCancel={close}
      footer={
        <>
          <button disabled={busy} onClick={() => void choose()}>
            {path ? t('Choose Another File…') : t('Choose File…')}
          </button>
          <span class="spacer" />
          {preview && <span class="muted small">{t('{count} selected', { count: selected.size })}</span>}
          <button onClick={close}>{t('Cancel')}</button>
          {needsPassword && !preview ? (
            <button class="primary" disabled={busy || !password} onClick={unlock}>
              {t('Read DBX Export')}
            </button>
          ) : (
            <button class="primary" disabled={busy || !preview || selected.size === 0} onClick={() => void runImport()}>
              {t('Import Selected')}
            </button>
          )}
        </>
      }
    >
      <p class="muted small">{t('Connections are saved without testing them. Passwords are stored in the system credential store.')}</p>
      {path && <p class="small preformatted">{path}</p>}

      {!path && !error && <p class="muted">{t('Choose a DBX connection export file.')}</p>}
      {path && busy && !preview && <p class="muted">{t('Reading connection configuration…')}</p>}

      {needsPassword && !preview && (
        <form
          class="form"
          onSubmit={event => {
            event.preventDefault();
            unlock();
          }}
        >
          <p>{t('Enter the password used when this connection file was exported from DBX.')}</p>
          <label class="field">
            <span>{t('DBX export password')}</span>
            <input ref={passwordField} type="password" autocomplete="off" value={password} onInput={event => setPassword(event.currentTarget.value)} />
          </label>
        </form>
      )}

      {preview && (
        <>
          <section class="stats">
            <div>
              <strong>{importable.length}</strong>
              <span class="muted small">{t('Ready')}</span>
            </div>
            <div>
              <strong>{duplicates}</strong>
              <span class="muted small">{t('Duplicates')}</span>
            </div>
            <div>
              <strong>{preview.unsupported}</strong>
              <span class="muted small">{t('Unsupported')}</span>
            </div>
            <div>
              <strong>{preview.folders}</strong>
              <span class="muted small">{t('Folders')}</span>
            </div>
          </section>
          {preview.encrypted && <p class="muted small">{t('Passwords decrypted')}</p>}
          {preview.unsupported > 0 && <p class="muted small">{t('Connections of database types Lithe does not support are skipped.')}</p>}

          {preview.connections.length === 0 ? (
            <p class="muted">{t('The file has no connections Lithe can import.')}</p>
          ) : (
            <>
              <label class="check">
                <input
                  type="checkbox"
                  checked={allSelected}
                  disabled={importable.length === 0}
                  onInput={event => {
                    const checked = event.currentTarget.checked;
                    setSelected(checked ? new Set(importable.map(connection => connection.id)) : new Set());
                  }}
                />
                {t('Select All')}
              </label>
              <div class="checklist dbx-list">
                {preview.connections.map(connection => (
                  <label key={connection.id} class={`check dbx-row ${connection.duplicate ? 'muted' : ''}`}>
                    <input
                      type="checkbox"
                      checked={!connection.duplicate && selected.has(connection.id)}
                      disabled={connection.duplicate}
                      onInput={event => toggle(connection, event.currentTarget.checked)}
                    />
                    <span class="grow">
                      <span>{connection.name}</span>{' '}
                      <span class="muted small">{KIND_NAMES[connection.kind as DatabaseKind] ?? connection.kind}</span>{' '}
                      {connection.duplicate && <span class="badge">{t('Already saved')}</span>}
                      {!connection.duplicate && connection.warnings.length > 0 && <span class="badge warning">{t('Review')}</span>}
                      <span class="dbx-detail muted small">{endpoint(connection)}</span>
                      {connection.warnings.map(warning => (
                        <span key={warning} class="dbx-warning small">
                          {warningText(warning)}
                        </span>
                      ))}
                    </span>
                  </label>
                ))}
              </div>
            </>
          )}
        </>
      )}

      {error && (
        <div class="test-result error">
          <span>{error}</span>
        </div>
      )}
    </Modal>
  );
}
