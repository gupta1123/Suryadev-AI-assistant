import { BadgeIndianRupee, FileText, Home, LogOut, Settings, Users, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import logoImg from '../assets/suryadev-logo.jpg';
import type { AdminUser, AppRoute } from '../types';

type NavItem = { path: string; label: string; short: string; icon: LucideIcon; pages: AppRoute['page'][] };

const HOME_NAV: NavItem = { path: '/', label: 'Home', short: 'Home', icon: Home, pages: ['overview'] };
const DAILY_WORK_NAV: NavItem[] = [
  { path: '/documents', label: 'Documents', short: 'Documents', icon: FileText, pages: ['deliveries', 'delivery'] },
  { path: '/payments', label: 'Payment followup', short: 'Followup', icon: BadgeIndianRupee, pages: ['paymentFollowUps', 'paymentFollowUp'] },
];
const MANAGEMENT_NAV: NavItem[] = [
  { path: '/customers', label: 'Customers', short: 'Customers', icon: Users, pages: ['customers', 'customer'] },
];
// Mobile keeps one compact row, in the same order as the desktop groups.
const MAIN_NAV: NavItem[] = [HOME_NAV, ...DAILY_WORK_NAV, ...MANAGEMENT_NAV];
const SETTINGS_NAV: NavItem = { path: '/settings', label: 'Settings', short: 'Settings', icon: Settings, pages: ['settings'] };

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
            {renderNav(HOME_NAV)}
          </div>
          <div className="nav-section" role="group" aria-labelledby="nav-daily-work-label">
            <p id="nav-daily-work-label" className="nav-section-label">Daily work</p>
            {DAILY_WORK_NAV.map(renderNav)}
          </div>
          <div className="nav-section" role="group" aria-labelledby="nav-management-label">
            <p id="nav-management-label" className="nav-section-label">Management</p>
            {MANAGEMENT_NAV.map(renderNav)}
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
