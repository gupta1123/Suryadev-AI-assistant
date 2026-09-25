import { BadgeIndianRupee, BellRing, FileText, Home, LogOut, Settings, Users, type LucideIcon } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import logoImg from '../assets/suryadev-logo.jpg';
import { loadInbox, subscribeInboxCount } from '../lib/inbox';
import type { AdminUser, AppRoute } from '../types';

type NavItem = { path: string; label: string; short: string; icon: LucideIcon; pages: AppRoute['page'][] };

const MAIN_NAV: NavItem[] = [
  { path: '/', label: 'Home', short: 'Home', icon: Home, pages: ['overview'] },
  { path: '/attention', label: 'Needs attention', short: 'Attention', icon: BellRing, pages: ['inbox'] },
  { path: '/documents', label: 'Documents', short: 'Documents', icon: FileText, pages: ['deliveries', 'delivery'] },
  { path: '/customers', label: 'Customers', short: 'Customers', icon: Users, pages: ['customers', 'customer'] },
  { path: '/payments', label: 'Payments', short: 'Payments', icon: BadgeIndianRupee, pages: ['paymentFollowUps', 'paymentFollowUp'] },
];
const SETTINGS_NAV: NavItem = { path: '/settings', label: 'Settings', short: 'Settings', icon: Settings, pages: ['settings'] };

function useInboxCount(): number | null {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    const unsubscribe = subscribeInboxCount(setCount);
    void loadInbox().catch(() => undefined);
    const timer = window.setInterval(() => { void loadInbox(true).catch(() => undefined); }, 60_000);
    return () => { unsubscribe(); window.clearInterval(timer); };
  }, []);
  return count;
}

export function AppShell({
  route,
  title,
  eyebrow,
  headerLeading,
  actions,
  children,
  contentClassName,
  onNavigate,
  user,
  onLogout,
  loggingOut,
}: {
  route: AppRoute;
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
  const inboxCount = useInboxCount();

  function renderNav(item: NavItem) {
    const Icon = item.icon;
    const active = item.pages.includes(route.page);
    return (
      <button
        key={item.path}
        className={`nav-link ${active ? 'nav-link--active' : ''}`}
        type="button"
        aria-current={active ? 'page' : undefined}
        onClick={() => onNavigate(item.path)}
      >
        <Icon size={17} aria-hidden="true" />
        <span>{item.label}</span>
        {item.path === '/attention' && inboxCount ? <span className="nav-badge" aria-label={`${inboxCount} items`}>{inboxCount > 99 ? '99+' : inboxCount}</span> : null}
      </button>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand" type="button" onClick={() => onNavigate('/')} aria-label="Go to home">
          <img className="brand-logo" src={logoImg} alt="SuryaDev TMT Rebar" />
        </button>

        <nav className="primary-nav" aria-label="Primary navigation">
          <div className="nav-section">
            {MAIN_NAV.map(renderNav)}
          </div>
          <div className="nav-section nav-section--bottom">
            {renderNav(SETTINGS_NAV)}
          </div>
        </nav>

        <div className="sidebar-account">
          <span className="account-avatar">AD</span>
          <div><strong>{user.displayName}</strong><small>@{user.username}</small></div>
          <button className="sign-out-link" type="button" disabled={loggingOut} onClick={() => void onLogout()} aria-label="Sign out">
            <LogOut size={16} aria-hidden="true" />
            <span className="sr-only">{loggingOut ? 'Signing out…' : 'Sign out'}</span>
          </button>
        </div>
      </aside>

      <div className="main-column">
        <header className="topbar">
          <div className="topbar__inner">
            <div className="topbar__heading">
              {headerLeading && <span className="topbar__crumb">{headerLeading}</span>}
              <h1>{title}</h1>
              {eyebrow && <span className="topbar__subtitle">{eyebrow}</span>}
            </div>
            {actions && <div className="page-actions">{actions}</div>}
          </div>
        </header>
        <main className={`main-content ${contentClassName ?? ''}`.trim()}>
          {children}
        </main>
      </div>

      <nav className="mobile-nav mobile-nav--five" aria-label="Mobile navigation">
        {MAIN_NAV.map((item) => {
          const Icon = item.icon;
          const active = item.pages.includes(route.page);
          return (
            <button key={item.path} className={active ? 'mobile-nav--active' : ''} type="button" onClick={() => onNavigate(item.path)}>
              <span className="mobile-nav__icon">
                <Icon size={19} aria-hidden="true" />
                {item.path === '/attention' && inboxCount ? <i className="mobile-nav__dot" /> : null}
              </span>
              {item.short}
            </button>
          );
        })}
      </nav>

      <button className="mobile-sign-out" type="button" onClick={() => onNavigate('/settings')} aria-label="Settings">
        <Settings size={17} aria-hidden="true" />
      </button>
    </div>
  );
}
