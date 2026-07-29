import { FileText, LayoutDashboard, LogOut, Send } from 'lucide-react';
import type { ReactNode } from 'react';
import type { AdminUser, AppRoute, DeliveryConfig } from '../types';

export function AppShell({
  route,
  config,
  title,
  eyebrow,
  headerLeading,
  actions,
  children,
  contentClassName,
  onNavigate,
  onNewDelivery,
  user,
  onLogout,
  loggingOut,
}: {
  route: AppRoute;
  config: DeliveryConfig | null;
  title: string;
  eyebrow?: string;
  headerLeading?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  contentClassName?: string;
  onNavigate: (path: string) => void;
  onNewDelivery?: () => void;
  user: AdminUser;
  onLogout: () => Promise<void>;
  loggingOut: boolean;
}) {
  const overviewActive = route.page === 'overview';
  const deliveriesActive = route.page === 'deliveries' || route.page === 'delivery';
  const environmentReady = config?.invoiceSource === 'sap'
    ? config.sapPollingReady
    : config?.simulationReady;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand" type="button" onClick={() => onNavigate('/')} aria-label="Go to overview">
          <span className="brand-mark">SD</span>
          <span className="brand-copy"><strong>SuryaDev</strong><small>Invoice Delivery</small></span>
        </button>

        <nav className="primary-nav" aria-label="Primary navigation">
          <button className={`nav-link ${overviewActive ? 'nav-link--active' : ''}`} type="button" onClick={() => onNavigate('/')}>
            <LayoutDashboard size={18} aria-hidden="true" />
            Overview
          </button>
          <button className={`nav-link ${deliveriesActive ? 'nav-link--active' : ''}`} type="button" onClick={() => onNavigate('/deliveries')}>
            <FileText size={18} aria-hidden="true" />
            Deliveries
          </button>
        </nav>

        <div className="sidebar-status">
          <span className={`environment-dot ${environmentReady ? 'environment-dot--ready' : ''}`} />
          <div>
            <strong>{config?.deliveryMode === 'test' ? 'Controlled test mode' : 'Production mode'}</strong>
            <span>{config?.invoiceSource === 'fixture' ? 'SAP simulation source' : 'Live SAP source'}</span>
          </div>
        </div>

        <div className="sidebar-account">
          <span className="account-avatar">AD</span>
          <div><strong>{user.displayName}</strong><small>@{user.username}</small></div>
          <button className="sign-out-link" type="button" disabled={loggingOut} onClick={() => void onLogout()} aria-label="Sign out">
            <LogOut size={16} aria-hidden="true" /> <span>{loggingOut ? 'Signing out…' : 'Sign out'}</span>
          </button>
        </div>
      </aside>

      <main className={`main-content ${contentClassName ?? ''}`.trim()}>
        <header className="page-header">
          <div>
            {headerLeading}
            {eyebrow && <p className="eyebrow">{eyebrow}</p>}
            <h1>{title}</h1>
          </div>
          <div className="page-actions">{actions}</div>
        </header>
        {children}
      </main>

      <nav className={`mobile-nav ${onNewDelivery ? '' : 'mobile-nav--two'}`} aria-label="Mobile navigation">
        <button className={overviewActive ? 'mobile-nav--active' : ''} type="button" onClick={() => onNavigate('/')}>
          <LayoutDashboard size={19} aria-hidden="true" /> Overview
        </button>
        <button className={deliveriesActive ? 'mobile-nav--active' : ''} type="button" onClick={() => onNavigate('/deliveries')}>
          <FileText size={19} aria-hidden="true" /> Deliveries
        </button>
        {onNewDelivery && (
          <button type="button" onClick={onNewDelivery}>
            <Send size={19} aria-hidden="true" /> New test
          </button>
        )}
      </nav>

      <button className="mobile-sign-out" type="button" disabled={loggingOut} onClick={() => void onLogout()} aria-label="Sign out">
        <LogOut size={17} aria-hidden="true" />
      </button>
    </div>
  );
}
