import { t } from '../i18n.ts';
import { loadWorkspace } from '../actions.ts';
import { closeTab, update, useStore, type Tab } from '../store.ts';
import { KIND_NAMES } from '../model.ts';
import { Dialogs } from './Dialogs.tsx';
import { Sidebar } from './Sidebar.tsx';
import { Console } from './Console.tsx';
import { TableView } from './TableView.tsx';
import { RedisView } from './RedisView.tsx';
import { NacosView } from './NacosView.tsx';
import { HistoryView } from './HistoryView.tsx';
import { Overview } from './Overview.tsx';
import { Splitter } from './Splitter.tsx';
import { MenuHost } from './Menu.tsx';

export function App() {
  const status = useStore(state => state.status);
  const error = useStore(state => state.error);
  const notices = useStore(state => state.notices);
  if (status === 'failed') {
    return (
      <div class="empty-state">
        <p>{t('The saved connections could not be loaded.')}</p>
        <p class="muted">{error}</p>
        <button onClick={() => void loadWorkspace()}>{t('Retry')}</button>
      </div>
    );
  }
  if (status !== 'ready') return <div class="empty-state muted">{t('Loading…')}</div>;
  return (
    <div class="app">
      <Splitter storageKey="sidebar" initial={280} minimum={180} maximum={560}>
        <Sidebar />
        <Workspace />
      </Splitter>
      <Dialogs />
      <MenuHost />
      <div class="notices" role="status">
        {notices.map(notice => (
          <div key={notice.id} class={`notice ${notice.tone}`}>
            {notice.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function tabTitle(tab: Tab, profileName: (id: string) => string): string {
  switch (tab.kind) {
    case 'overview':
      return t('Overview');
    case 'console':
      return `${tab.title} · ${profileName(tab.profileID)}`;
    case 'table':
      return tab.table;
    case 'redis':
      return `${KIND_NAMES.redis} · ${profileName(tab.profileID)}`;
    case 'nacos':
      return `${KIND_NAMES.nacos} · ${profileName(tab.profileID)}`;
    case 'history':
      return t('SQL History');
  }
}

function Workspace() {
  const tabs = useStore(state => state.tabs);
  const activeTab = useStore(state => state.activeTab);
  const profiles = useStore(state => state.profiles);
  const profileName = (id: string) => profiles.find(profile => profile.id === id)?.name ?? '';
  const active = tabs.find(tab => tab.id === activeTab) ?? tabs[0];
  return (
    <div class="workspace">
      <div class="tabs" role="tablist">
        {tabs.map(tab => (
          <div
            key={tab.id}
            role="tab"
            aria-selected={tab.id === active.id}
            class={`tab ${tab.id === active.id ? 'active' : ''}`}
            title={tabTitle(tab, profileName)}
            onClick={() => update({ activeTab: tab.id })}
            onAuxClick={event => event.button === 1 && closeTab(tab.id)}
          >
            <span class="tab-title">{tabTitle(tab, profileName)}</span>
            {tab.id !== 'overview' && (
              <button
                class="icon tab-close"
                aria-label={t('Close')}
                onClick={event => {
                  event.stopPropagation();
                  closeTab(tab.id);
                }}
              >
                ×
              </button>
            )}
          </div>
        ))}
      </div>
      <div class="tab-body">
        {/* Consoles stay mounted so their editors keep undo history and results. */}
        {tabs.map(tab => (
          <div key={tab.id} class="tab-page" hidden={tab.id !== active.id}>
            <TabContent tab={tab} />
          </div>
        ))}
      </div>
    </div>
  );
}

function TabContent({ tab }: { tab: Tab }) {
  switch (tab.kind) {
    case 'overview':
      return <Overview />;
    case 'console':
      return <Console tab={tab} />;
    case 'table':
      return <TableView tab={tab} />;
    case 'redis':
      return <RedisView tab={tab} />;
    case 'nacos':
      return <NacosView tab={tab} />;
    case 'history':
      return <HistoryView />;
  }
}
