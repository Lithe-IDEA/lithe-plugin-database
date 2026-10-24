import { useEffect, useMemo, useState } from 'preact/hooks';
import { failure } from '../actions.ts';
import { db, type Row } from '../api.ts';
import { withConfirmation } from '../guard.ts';
import { t } from '../i18n.ts';
import type { Profile } from '../model.ts';
import { confirm, updateTab, useStore, type LoadStatus, type Tab } from '../store.ts';
import { DataGrid } from './DataGrid.tsx';
import { STALE, useLatestCall } from '../latest.ts';
import { Splitter } from './Splitter.tsx';

const PAGE_SIZE = 100;
const DEFAULT_GROUP = 'DEFAULT_GROUP';
const CONFIG_TYPES = ['text', 'json', 'xml', 'yaml', 'html', 'properties'];

type Section = Extract<Tab, { kind: 'nacos' }>['section'];

interface ConfigSummary {
  dataId: string;
  group: string;
  namespace: string;
  type?: string | null;
  md5?: string | null;
}

interface ConfigDetail extends ConfigSummary {
  content: string;
}

interface ServiceSummary {
  name: string;
  group: string;
  clusterCount: number;
}

interface Instance {
  ip: string;
  port: number;
  healthy: boolean;
  enabled: boolean;
  ephemeral: boolean;
  clusterName?: string | null;
}

interface Paged<T> {
  items: T[];
  totalCount: number;
}

/** A configuration is identified by its data ID and group within the profile's namespace. */
interface ConfigID {
  dataId: string;
  group: string;
}

interface Draft extends ConfigID {
  type: string;
  content: string;
}

const emptyDraft = (): Draft => ({ dataId: '', group: DEFAULT_GROUP, type: '', content: '' });

const countText = (shown: number, total: number, all: (count: number) => string) =>
  shown < total ? t('{shown} of {total}', { shown, total }) : all(total);

/** Nacos configurations and services of the profile's namespace, one section at a time. */
export function NacosView({ tab }: { tab: Extract<Tab, { kind: 'nacos' }> }) {
  const profile = useStore(state => state.profiles.find(item => item.id === tab.profileID));
  if (!profile) return <div class="empty-state muted">{t('The connection no longer exists.')}</div>;
  return (
    <div class="specialized-view">
      <div class="toolbar">
        <div class="segmented" role="tablist">
          {(['configs', 'services'] as Section[]).map(section => (
            <button
              key={section}
              role="tab"
              aria-selected={tab.section === section}
              class={tab.section === section ? 'selected' : ''}
              onClick={() => updateTab<'nacos'>(tab.id, () => ({ section }))}
            >
              {section === 'configs' ? t('Configurations') : t('Services')}
            </button>
          ))}
        </div>
        <span class="spacer" />
        <span class="badge">{t('Namespace {name}', { name: profile.database || 'public' })}</span>
        {profile.readOnly && <span class="badge">{t('Read-only')}</span>}
        {profile.productionProtection && <span class="badge warning">{t('Production')}</span>}
      </div>
      {/* Both sections stay mounted so switching keeps searches and drafts. */}
      <div class="section-page" hidden={tab.section !== 'configs'}>
        <Configurations profile={profile} />
      </div>
      <div class="section-page" hidden={tab.section !== 'services'}>
        <Services profile={profile} />
      </div>
    </div>
  );
}

// MARK: Configurations

function Configurations({ profile }: { profile: Profile }) {
  const [dataIdSearch, setDataIdSearch] = useState('');
  const [groupSearch, setGroupSearch] = useState('');
  // The filters of the list shown; refreshes after a write reuse them.
  const [searched, setSearched] = useState<ConfigID>({ dataId: '', group: '' });
  const [items, setItems] = useState<ConfigSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [listStatus, setListStatus] = useState<LoadStatus>('idle');
  const [listError, setListError] = useState<string>();
  // The configuration the editor shows; null while creating one.
  const [loaded, setLoaded] = useState<ConfigID | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [detailStatus, setDetailStatus] = useState<LoadStatus>('idle');
  const [busy, setBusy] = useState(false);
  const [editError, setEditError] = useState<string>();
  const listRequest = useLatestCall();
  const detailRequest = useLatestCall();
  const columns = useMemo(() => [t('Data ID'), t('Group'), t('Type')], []);

  useEffect(() => {
    void list({ dataId: '', group: '' });
  }, [profile.id]);

  const list = async (filters: ConfigID = searched) => {
    setSearched(filters);
    setListStatus('loading');
    setListError(undefined);
    try {
      const page = await listRequest.run(
        db<Paged<ConfigSummary>>(profile.id, 'nacosListConfigs', { dataId: filters.dataId, group: filters.group, page: 1, pageSize: PAGE_SIZE }),
      );
      if (page === STALE) return;
      setItems(page.items);
      setTotal(page.totalCount);
      setListStatus('ready');
    } catch (error) {
      setListStatus('failed');
      setListError(failure(error));
    }
  };

  const open = async (config: ConfigID) => {
    setLoaded(config);
    setDetailStatus('loading');
    setEditError(undefined);
    try {
      const detail = await detailRequest.run(db<ConfigDetail>(profile.id, 'nacosGetConfig', { dataId: config.dataId, group: config.group }));
      if (detail === STALE) return;
      setLoaded({ dataId: detail.dataId, group: detail.group });
      setDraft({ dataId: detail.dataId, group: detail.group, type: detail.type ?? '', content: detail.content });
      setDetailStatus('ready');
    } catch (error) {
      // The editor never shows one configuration's content under another's name.
      setLoaded(null);
      setDraft(emptyDraft());
      setDetailStatus('failed');
      setEditError(failure(error));
    }
  };

  const startNew = () => {
    detailRequest.cancel();
    setLoaded(null);
    setDraft(emptyDraft());
    setDetailStatus('idle');
    setEditError(undefined);
  };

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft(current => ({ ...current, [key]: value }));

  const publish = async () => {
    const target = { dataId: draft.dataId.trim(), group: draft.group.trim() };
    if (!target.dataId || !target.group) return;
    setBusy(true);
    setEditError(undefined);
    try {
      const done = await withConfirmation(
        confirmed => db(profile.id, 'nacosPublishConfig', { ...target, content: draft.content, type: draft.type, confirmed }).result,
        {
          title: t('Publish configuration?'),
          message: t('“{dataId}” in group “{group}” will be published to Nacos.', target),
          confirmLabel: t('Publish'),
        },
      );
      if (done === undefined) return;
      await Promise.all([list(), open(target)]);
    } catch (error) {
      setEditError(failure(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (target: ConfigID) => {
    const message = t('“{dataId}” in group “{group}” will be deleted from Nacos. This cannot be undone.', { dataId: target.dataId, group: target.group });
    const ok = await confirm({
      title: t('Delete configuration?'),
      message: profile.productionProtection ? `${message}\n\n${t('This connection is marked as production.')}` : message,
      confirmLabel: t('Delete'),
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    setEditError(undefined);
    try {
      // The dialog above is the confirmation the engine asks for.
      const done = await withConfirmation(
        confirmed => db(profile.id, 'nacosDeleteConfig', { dataId: target.dataId, group: target.group, confirmed }).result,
        { title: t('Delete configuration?'), message, confirmLabel: t('Delete') },
        true,
      );
      if (done === undefined) return;
      startNew();
      await list();
    } catch (error) {
      setEditError(failure(error));
    } finally {
      setBusy(false);
    }
  };

  const rows: Row[] = items.map(item => ({ [columns[0]]: item.dataId, [columns[1]]: item.group, [columns[2]]: item.type ?? '' }));
  const selectedIndex = loaded ? items.findIndex(item => item.dataId === loaded.dataId && item.group === loaded.group) : -1;
  const types = draft.type && !CONFIG_TYPES.includes(draft.type) ? [...CONFIG_TYPES, draft.type] : CONFIG_TYPES;
  const locked = profile.readOnly || busy;

  return (
    <Splitter storageKey="nacos-configs" initial={360} minimum={240} maximum={900}>
      <div class="pane">
        <form
          class="toolbar"
          onSubmit={event => {
            event.preventDefault();
            void list({ dataId: dataIdSearch.trim(), group: groupSearch.trim() });
          }}
        >
          <input class="search" type="search" placeholder={t('Data ID')} value={dataIdSearch} onInput={event => setDataIdSearch(event.currentTarget.value)} />
          <input class="search" type="search" placeholder={t('Group')} value={groupSearch} onInput={event => setGroupSearch(event.currentTarget.value)} />
          <button type="submit" disabled={listStatus === 'loading'}>
            {t('Search')}
          </button>
        </form>
        {listError && items.length > 0 && (
          <div class="inline-error" role="alert">
            {listError}
          </div>
        )}
        {listError && items.length === 0 ? (
          <div class="empty-state">
            <p class="error-text">{listError}</p>
            <button onClick={() => void list()}>{t('Retry')}</button>
          </div>
        ) : (
          <DataGrid
            columns={columns}
            rows={rows}
            selectedRows={selectedIndex >= 0 ? [selectedIndex] : []}
            onSelectRows={indexes => {
              const item = indexes.length === 1 ? items[indexes[0]] : undefined;
              if (item && (indexes[0] !== selectedIndex || detailStatus === 'failed')) void open(item);
            }}
            emptyText={listStatus === 'loading' ? t('Loading…') : t('No configurations found.')}
          />
        )}
        <div class="toolbar pane-footer">
          <span class="muted">{countText(items.length, total, count => t('{count} configurations', { count }))}</span>
          <span class="spacer" />
          <button disabled={profile.readOnly} onClick={startNew}>
            {t('New')}
          </button>
        </div>
      </div>
      <div class="pane">
        <div class="toolbar detail-header">
          <span class="detail-title">{loaded ? t('Edit configuration') : t('New configuration')}</span>
          {detailStatus === 'loading' && <span class="muted">{t('Loading…')}</span>}
          <span class="spacer" />
          {loaded && (
            <button class="destructive" disabled={locked} onClick={() => void remove(loaded)}>
              {t('Delete')}
            </button>
          )}
        </div>
        {editError && (
          <div class="inline-error" role="alert">
            {editError}
          </div>
        )}
        <div class="pane-body">
          <div class="form grow">
            <div class="field-row">
              <label class="field grow">
                <span>{t('Data ID')}</span>
                <input value={draft.dataId} readOnly={profile.readOnly} onInput={event => set('dataId', event.currentTarget.value)} />
              </label>
              <label class="field">
                <span>{t('Group')}</span>
                <input value={draft.group} placeholder={DEFAULT_GROUP} readOnly={profile.readOnly} onInput={event => set('group', event.currentTarget.value)} />
              </label>
              <label class="field">
                <span>{t('Type')}</span>
                <select value={draft.type} disabled={profile.readOnly} onInput={event => set('type', event.currentTarget.value)}>
                  <option value="">{t('None')}</option>
                  {types.map(type => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label class="field grow">
              <span>{t('Content')}</span>
              <textarea
                class="code-editor"
                spellcheck={false}
                value={draft.content}
                readOnly={profile.readOnly}
                onInput={event => set('content', event.currentTarget.value)}
              />
            </label>
          </div>
        </div>
        <div class="toolbar pane-footer">
          <span class="muted">{loaded ? t('Publishing replaces the configuration in Nacos.') : t('Publishing creates the configuration in Nacos.')}</span>
          <span class="spacer" />
          <button class="primary" disabled={locked || !draft.dataId.trim() || !draft.group.trim()} onClick={() => void publish()}>
            {t('Publish')}
          </button>
        </div>
      </div>
    </Splitter>
  );
}

// MARK: Services

function Services({ profile }: { profile: Profile }) {
  const [nameSearch, setNameSearch] = useState('');
  const [groupSearch, setGroupSearch] = useState('');
  const [items, setItems] = useState<ServiceSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [listStatus, setListStatus] = useState<LoadStatus>('idle');
  const [listError, setListError] = useState<string>();
  const [selected, setSelected] = useState<ServiceSummary | null>(null);
  const [instances, setInstances] = useState<Instance[]>([]);
  const [instanceStatus, setInstanceStatus] = useState<LoadStatus>('idle');
  const [instanceError, setInstanceError] = useState<string>();
  const listRequest = useLatestCall();
  const instanceRequest = useLatestCall();
  const serviceColumns = useMemo(() => [t('Service'), t('Group'), t('Clusters')], []);
  const instanceColumns = useMemo(() => [t('Address'), t('Health'), t('Status'), t('Instance type'), t('Cluster')], []);

  useEffect(() => {
    void list();
  }, [profile.id]);

  const list = async () => {
    setListStatus('loading');
    setListError(undefined);
    try {
      const page = await listRequest.run(
        db<Paged<ServiceSummary>>(profile.id, 'nacosListServices', { serviceName: nameSearch.trim(), group: groupSearch.trim(), page: 1, pageSize: PAGE_SIZE }),
      );
      if (page === STALE) return;
      setItems(page.items);
      setTotal(page.totalCount);
      setListStatus('ready');
      // The selected service reloads its instances while the list still has it.
      const kept = selected && page.items.find(item => item.name === selected.name && item.group === selected.group);
      if (kept) void openService(kept);
      else if (selected) closeService();
    } catch (error) {
      setListStatus('failed');
      setListError(failure(error));
    }
  };

  const openService = async (service: ServiceSummary) => {
    setSelected(service);
    setInstanceStatus('loading');
    setInstanceError(undefined);
    try {
      const value = await instanceRequest.run(db<Instance[]>(profile.id, 'nacosListInstances', { serviceName: service.name, group: service.group }));
      if (value === STALE) return;
      setInstances(value);
      setInstanceStatus('ready');
    } catch (error) {
      setInstances([]);
      setInstanceStatus('failed');
      setInstanceError(failure(error));
    }
  };

  const closeService = () => {
    instanceRequest.cancel();
    setSelected(null);
    setInstances([]);
    setInstanceStatus('idle');
  };

  const serviceRows: Row[] = items.map(item => ({ [serviceColumns[0]]: item.name, [serviceColumns[1]]: item.group, [serviceColumns[2]]: item.clusterCount }));
  const selectedIndex = selected ? items.findIndex(item => item.name === selected.name && item.group === selected.group) : -1;
  const instanceRows: Row[] = instances.map(item => ({
    [instanceColumns[0]]: `${item.ip}:${item.port}`,
    [instanceColumns[1]]: item.healthy ? t('Healthy') : t('Unhealthy'),
    [instanceColumns[2]]: item.enabled ? t('Enabled') : t('Disabled'),
    [instanceColumns[3]]: item.ephemeral ? t('Ephemeral') : t('Persistent'),
    [instanceColumns[4]]: item.clusterName || 'DEFAULT',
  }));

  return (
    <Splitter storageKey="nacos-services" initial={360} minimum={240} maximum={900}>
      <div class="pane">
        <form
          class="toolbar"
          onSubmit={event => {
            event.preventDefault();
            void list();
          }}
        >
          <input class="search" type="search" placeholder={t('Service')} value={nameSearch} onInput={event => setNameSearch(event.currentTarget.value)} />
          <input class="search" type="search" placeholder={t('Group')} value={groupSearch} onInput={event => setGroupSearch(event.currentTarget.value)} />
          <button type="submit" disabled={listStatus === 'loading'}>
            {t('Search')}
          </button>
        </form>
        {listError && items.length > 0 && (
          <div class="inline-error" role="alert">
            {listError}
          </div>
        )}
        {listError && items.length === 0 ? (
          <div class="empty-state">
            <p class="error-text">{listError}</p>
            <button onClick={() => void list()}>{t('Retry')}</button>
          </div>
        ) : (
          <DataGrid
            columns={serviceColumns}
            rows={serviceRows}
            selectedRows={selectedIndex >= 0 ? [selectedIndex] : []}
            onSelectRows={indexes => {
              const item = indexes.length === 1 ? items[indexes[0]] : undefined;
              if (item) void openService(item);
            }}
            emptyText={listStatus === 'loading' ? t('Loading…') : t('No services found.')}
          />
        )}
        <div class="toolbar pane-footer">
          <span class="muted">{countText(items.length, total, count => t('{count} services', { count }))}</span>
        </div>
      </div>
      <div class="pane">
        {selected ? (
          <>
            <div class="toolbar detail-header">
              <span class="detail-title" title={selected.name}>
                {selected.name}
              </span>
              <span class="muted">{selected.group}</span>
              <span class="spacer" />
              <span class="muted">{instanceStatus === 'loading' ? t('Loading…') : t('{count} instances', { count: instances.length })}</span>
              <button class="icon" title={t('Refresh')} aria-label={t('Refresh')} disabled={instanceStatus === 'loading'} onClick={() => void openService(selected)}>
                ↻
              </button>
            </div>
            {instanceError && (
              <div class="inline-error" role="alert">
                {instanceError}
              </div>
            )}
            <DataGrid
              columns={instanceColumns}
              rows={instanceRows}
              cellClass={(row, column) => (column === instanceColumns[1] ? (instances[row]?.healthy ? 'health-ok' : 'health-bad') : undefined)}
              emptyText={instanceStatus === 'loading' ? t('Loading…') : t('This service has no registered instances.')}
            />
          </>
        ) : (
          <div class="empty-state">
            <p>{t('Select a service')}</p>
            <p class="muted">{t('Choose a service to see its registered instances and their health.')}</p>
          </div>
        )}
      </div>
    </Splitter>
  );
}
