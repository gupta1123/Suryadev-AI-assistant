import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { AppShell } from '../components/AppShell';
import { ConnectionsTab } from '../components/settings/ConnectionsTab';
import { CustomersTab } from '../components/settings/CustomersTab';
import { MaterialsTab } from '../components/settings/MaterialsTab';
import { buildIssues, type TabId } from '../components/settings/health';
import { OverviewTab } from '../components/settings/OverviewTab';
import { RemindersTab } from '../components/settings/RemindersTab';
import { Pill } from '../components/settings/ui';
import { apiRequest } from '../lib/api';
import { toMessage } from '../lib/format';
import type {
  AdminUser,
  AppRoute,
  BillingDocumentTemplateReadiness,
  DeliveryConfig,
  HelpRequestAlertSettings,
  MessagingOverview,
  PaymentFollowUpConfig,
  SapPollingStatus,
} from '../types';

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'customers', label: 'Customer messaging' },
  { id: 'materials', label: 'Products' },
  { id: 'reminders', label: 'Reminder timing' },
  { id: 'connections', label: 'Connections & templates' },
];

// Addresses from the previous seven-section layout keep working.
const LEGACY_HASHES: Record<string, TabId> = {
  sending: 'overview',
  sap: 'connections',
  formats: 'connections',
  'sap-masters': 'customers',
  'test-numbers': 'overview',
  team: 'overview',
  account: 'overview',
};

function tabFromHash(): TabId {
  const hash = window.location.hash.slice(1);
  return TABS.find((tab) => tab.id === hash)?.id ?? LEGACY_HASHES[hash] ?? 'overview';
}

export function SettingsPage({
  route,
  onNavigate,
  user,
  onLogout,
  loggingOut,
}: {
  route: AppRoute;
  onNavigate: (path: string) => void;
  user: AdminUser;
  onLogout: () => Promise<void>;
  loggingOut: boolean;
}) {
  const [config, setConfig] = useState<DeliveryConfig | null>(null);
  const [paymentConfig, setPaymentConfig] = useState<PaymentFollowUpConfig | null>(null);
  const [helpAlert, setHelpAlert] = useState<HelpRequestAlertSettings | null>(null);
  const [polling, setPolling] = useState<SapPollingStatus>(null);
  const [templates, setTemplates] = useState<BillingDocumentTemplateReadiness | null>(null);
  const [checkingTemplates, setCheckingTemplates] = useState(true);
  const [messaging, setMessaging] = useState<MessagingOverview | null>(null);
  const [messagingError, setMessagingError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [activeTab, setActiveTab] = useState<TabId>(tabFromHash);

  const load = useCallback(async () => {
    const [configResult, paymentResult, pollingResult, helpResult, messagingResult] = await Promise.allSettled([
      apiRequest<DeliveryConfig>('/invoice-delivery/config'),
      apiRequest<PaymentFollowUpConfig>('/payment-follow-up/config'),
      apiRequest<SapPollingStatus>('/invoice-delivery/polling-status'),
      apiRequest<HelpRequestAlertSettings>('/invoice-delivery/help-alert-settings'),
      apiRequest<MessagingOverview>('/messaging/overview'),
    ]);
    if (configResult.status === 'fulfilled') { setConfig(configResult.value); setLoadError(''); }
    else setLoadError(toMessage(configResult.reason));
    if (paymentResult.status === 'fulfilled') setPaymentConfig(paymentResult.value);
    if (pollingResult.status === 'fulfilled') setPolling(pollingResult.value);
    if (helpResult.status === 'fulfilled') setHelpAlert(helpResult.value);
    if (messagingResult.status === 'fulfilled') { setMessaging(messagingResult.value); setMessagingError(''); }
    else setMessagingError(toMessage(messagingResult.reason));
  }, []);

  const checkTemplates = useCallback(async () => {
    setCheckingTemplates(true);
    try {
      setTemplates(await apiRequest<BillingDocumentTemplateReadiness>('/invoice-delivery/template-status'));
    } catch {
      setTemplates(null);
    } finally {
      setCheckingTemplates(false);
    }
  }, []);

  useEffect(() => {
    void load();
    void checkTemplates();
  }, [load, checkTemplates]);

  useEffect(() => {
    const onHashChange = () => setActiveTab(tabFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const openTab = useCallback((id: TabId) => {
    setActiveTab(id);
    window.history.replaceState(window.history.state, '', `#${id}`);
  }, []);

  const issues = useMemo(
    () => buildIssues({ config, polling, templates, messaging, messagingError }),
    [config, polling, templates, messaging, messagingError],
  );
  const badges = useMemo(() => {
    const result: Partial<Record<TabId, { tone: 'warn' | 'bad'; count: number }>> = {};
    for (const issue of issues) {
      if (issue.tone === 'info') continue;
      const current = result[issue.tab];
      result[issue.tab] = {
        tone: issue.tone === 'bad' || current?.tone === 'bad' ? 'bad' : 'warn',
        count: (current?.count ?? 0) + 1,
      };
    }
    return result;
  }, [issues]);

  const testMode = config?.deliveryMode === 'test';

  return (
    <AppShell
      route={route}
      eyebrow="How sending is set up"
      title="Settings"
      onNavigate={onNavigate}
      user={user}
      onLogout={onLogout}
      loggingOut={loggingOut}
      actions={config && <Pill tone={testMode ? 'test' : 'ok'}>{testMode ? 'Test mode' : 'Live'}</Pill>}
    >
      <div className="st">
        {loadError && (
          <div className="alert alert--error st-loaderror" role="alert">
            <span>Settings couldn’t be loaded: {loadError}</span>
            <button className="button button--secondary st-sm" type="button" onClick={() => void load()}>Try again</button>
          </div>
        )}

        <Tabs active={activeTab} badges={badges} onSelect={openTab} />

        <div role="tabpanel" id={`panel-${activeTab}`} aria-labelledby={`tab-${activeTab}`} tabIndex={0} className="st-panelwrap">
          {activeTab === 'overview' && (
            <OverviewTab
              config={config}
              paymentConfig={paymentConfig}
              helpAlert={helpAlert}
              polling={polling}
              templates={templates}
              checkingTemplates={checkingTemplates}
              messaging={messaging}
              issues={issues}
              onGo={openTab}
              user={user}
              onLogout={onLogout}
              loggingOut={loggingOut}
            />
          )}
          {activeTab === 'customers' && (
            <CustomersTab messaging={messaging} messagingError={messagingError} onReload={load} />
          )}
          {activeTab === 'reminders' && <RemindersTab paymentConfig={paymentConfig} onSaved={load} />}
          {activeTab === 'materials' && <MaterialsTab />}
          {activeTab === 'connections' && (
            <ConnectionsTab
              config={config}
              polling={polling}
              templates={templates}
              checkingTemplates={checkingTemplates}
              messaging={messaging}
              onCheckTemplates={checkTemplates}
              onRefresh={load}
            />
          )}
        </div>
      </div>
    </AppShell>
  );
}

function Tabs({
  active,
  badges,
  onSelect,
}: {
  active: TabId;
  badges: Partial<Record<TabId, { tone: 'warn' | 'bad'; count: number }>>;
  onSelect: (id: TabId) => void;
}) {
  const refs = useRef<Partial<Record<TabId, HTMLButtonElement | null>>>({});

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = TABS.findIndex((tab) => tab.id === active);
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % TABS.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = TABS.length - 1;
    else return;
    event.preventDefault();
    const target = TABS[next];
    if (!target) return;
    onSelect(target.id);
    refs.current[target.id]?.focus();
  }

  return (
    <div className="st-tabs" role="tablist" aria-label="Settings sections" onKeyDown={onKeyDown}>
      {TABS.map((tab) => {
        const badge = badges[tab.id];
        const selected = active === tab.id;
        return (
          <button
            key={tab.id}
            ref={(node) => { refs.current[tab.id] = node; }}
            id={`tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={`panel-${tab.id}`}
            tabIndex={selected ? 0 : -1}
            className="st-tab"
            onClick={() => onSelect(tab.id)}
          >
            {tab.label}
            {badge && (
              <span className={`st-tab__badge st-tab__badge--${badge.tone}`} aria-label={`${badge.count} to review`}>{badge.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
