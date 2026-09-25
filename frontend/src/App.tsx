import {
  AlertCircle,
  ArrowRight,
  CheckCheck,
  Eye,
  EyeOff,
  LockKeyhole,
} from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import logoImg from './assets/suryadev-logo.jpg';
import { apiRequest, ApiError, AUTH_UNAUTHORIZED_EVENT } from './lib/api';
import { DeliveriesPage } from './pages/DeliveriesPage';
import { DeliveryDetailPage } from './pages/DeliveryDetailPage';
import { OverviewPage } from './pages/OverviewPage';
import { InboxPage } from './pages/InboxPage';
import { CustomersPage } from './pages/CustomersPage';
import { CustomerDetailPage } from './pages/CustomerDetailPage';
import { SettingsPage } from './pages/SettingsPage';
import { PaymentFollowUpsPage } from './pages/PaymentFollowUpsPage';
import { PaymentFollowUpDetailPage } from './pages/PaymentFollowUpDetailPage';
import type { AdminUser, AppRoute } from './types';

type AuthResponse = { user: AdminUser; expiresAt: string };
const SESSION_EXPIRY_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export default function App() {
  const [user, setUser] = useState<AdminUser | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authIssue, setAuthIssue] = useState('');
  const [loggingOut, setLoggingOut] = useState(false);
  const [sessionExpiresAt, setSessionExpiresAt] = useState<number | null>(null);

  const expireSession = useCallback(() => {
    setUser(null);
    setSessionExpiresAt(null);
    setLoggingOut(false);
    setAuthIssue('Your session expired. Please sign in again.');
  }, []);

  useEffect(() => {
    window.addEventListener(AUTH_UNAUTHORIZED_EVENT, expireSession);
    return () => window.removeEventListener(AUTH_UNAUTHORIZED_EVENT, expireSession);
  }, [expireSession]);

  useEffect(() => {
    if (sessionExpiresAt === null) return;
    let timeout: number | undefined;
    const scheduleExpiryCheck = () => {
      const remainingMs = sessionExpiresAt - Date.now();
      if (remainingMs <= 0) {
        expireSession();
        return;
      }
      timeout = window.setTimeout(
        scheduleExpiryCheck,
        Math.min(remainingMs, SESSION_EXPIRY_CHECK_INTERVAL_MS),
      );
    };
    scheduleExpiryCheck();
    return () => {
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [expireSession, sessionExpiresAt]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const data = await apiRequest<AuthResponse>('/auth/session');
        if (active) {
          setUser(data.user);
          setSessionExpiresAt(Date.parse(data.expiresAt));
        }
      } catch (error) {
        if (active && !(error instanceof ApiError && error.status === 401)) {
          setAuthIssue(error instanceof Error ? error.message : 'Authentication check failed');
        }
      } finally {
        if (active) setAuthReady(true);
      }
    })();
    return () => { active = false; };
  }, []);

  async function handleLogin(username: string, password: string) {
    const data = await apiRequest<AuthResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    setUser(data.user);
    setSessionExpiresAt(Date.parse(data.expiresAt));
    setAuthIssue('');
  }

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await apiRequest('/auth/logout', { method: 'POST' });
    } finally {
      setUser(null);
      setSessionExpiresAt(null);
      setLoggingOut(false);
    }
  }

  if (!authReady) return <LoadingScreen />;
  if (!user) return <LoginScreen onLogin={handleLogin} initialError={authIssue} />;

  return (
    <Router
      user={user}
      onLogout={handleLogout}
      loggingOut={loggingOut}
    />
  );
}

function Router({
  user,
  onLogout,
  loggingOut,
}: {
  user: AdminUser;
  onLogout: () => Promise<void>;
  loggingOut: boolean;
}) {
  const [path, setPath] = useState(window.location.pathname);

  useEffect(() => {
    const handlePopState = () => setPath(window.location.pathname);
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const navigate = useCallback((nextPath: string) => {
    if (window.location.pathname !== nextPath) {
      // Remember where we came from so detail pages can offer a precise "back".
      window.history.pushState({ from: window.location.pathname }, '', nextPath);
    }
    setPath(nextPath);
  }, []);

  const route = parseRoute(path);
  const shared = { route, onNavigate: navigate, user, onLogout, loggingOut };

  // Keep old links working by rewriting them to the new addresses.
  useEffect(() => {
    const canonical = canonicalPath(path);
    if (canonical !== path) {
      window.history.replaceState(window.history.state, '', canonical);
      setPath(canonical);
    }
  }, [path]);

  switch (route.page) {
    case 'inbox':
      return <InboxPage {...shared} />;
    case 'deliveries':
      return <DeliveriesPage {...shared} />;
    case 'delivery':
      return <DeliveryDetailPage {...shared} jobId={route.jobId} />;
    case 'customers':
      return <CustomersPage {...shared} />;
    case 'customer':
      return <CustomerDetailPage {...shared} customerId={route.customerId} />;
    case 'paymentFollowUps':
      return <PaymentFollowUpsPage {...shared} />;
    case 'paymentFollowUp':
      return <PaymentFollowUpDetailPage {...shared} caseId={route.caseId} />;
    case 'settings':
      return <SettingsPage {...shared} />;
    default:
      return <OverviewPage {...shared} />;
  }
}

const LEGACY_PATHS: Array<[RegExp, string]> = [
  [/^\/deliveries(?=\/|$)/, '/documents'],
  [/^\/payment-follow-ups(?=\/|$)/, '/payments'],
  [/^\/help-requests\/?$/, '/attention'],
  [/^\/inbox\/?$/, '/attention'],
];

function canonicalPath(pathname: string): string {
  for (const [pattern, replacement] of LEGACY_PATHS) {
    if (pattern.test(pathname)) return pathname.replace(pattern, replacement);
  }
  return pathname;
}

function parseRoute(rawPath: string): AppRoute {
  const pathname = canonicalPath(rawPath);
  const match = (pattern: RegExp) => pathname.match(pattern);
  const documentMatch = match(/^\/documents\/(\d+)\/?$/);
  if (documentMatch) return { page: 'delivery', jobId: Number(documentMatch[1]) };
  const customerMatch = match(/^\/customers\/(\d+)\/?$/);
  if (customerMatch) return { page: 'customer', customerId: Number(customerMatch[1]) };
  const paymentMatch = match(/^\/payments\/(\d+)\/?$/);
  if (paymentMatch) return { page: 'paymentFollowUp', caseId: Number(paymentMatch[1]) };
  if (/^\/attention\/?$/.test(pathname)) return { page: 'inbox' };
  if (/^\/documents\/?$/.test(pathname)) return { page: 'deliveries' };
  if (/^\/customers\/?$/.test(pathname)) return { page: 'customers' };
  if (/^\/payments\/?$/.test(pathname)) return { page: 'paymentFollowUps' };
  if (/^\/settings\/?$/.test(pathname)) return { page: 'settings' };
  return { page: 'overview' };
}

function LoginScreen({
  onLogin,
  initialError,
}: {
  onLogin: (username: string, password: string) => Promise<void>;
  initialError: string;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onLogin(username, password);
    } catch (signInError) {
      setError(signInError instanceof Error ? signInError.message : 'Unable to sign in');
    } finally {
      setBusy(false);
    }
  }

  const today = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date());

  return (
    <main className="doc-login">
      <div className="doc-login__stack">
        <span className="doc-login__sheet doc-login__sheet--back" aria-hidden="true" />
        <span className="doc-login__sheet doc-login__sheet--mid" aria-hidden="true" />

        <section className="doc-login__card" aria-labelledby="signin-title">
          <header className="doc-login__band">
            <img src={logoImg} alt="SuryaDev TMT Rebar" className="doc-login__logo" />
            <div className="doc-login__band-meta">
              <span>Document</span>
              <strong>Sign in</strong>
            </div>
          </header>

          <div className="doc-login__body">
            <div className="doc-login__heading">
              <h1 id="signin-title">{greeting()}.</h1>
              <span className="doc-login__date">{today}</span>
            </div>
            <p className="doc-login__lead">Sign in to see every invoice and memo sent to your customers on WhatsApp.</p>

            {error && (
              <div className="signin__error" role="alert">
                <AlertCircle size={16} aria-hidden="true" />
                <span>{error}</span>
              </div>
            )}

            <form className="doc-login__form" onSubmit={(event) => void signIn(event)}>
              <label className="doc-login__field">
                <span>Username</span>
                <input
                  type="text"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  placeholder="Your username"
                  autoComplete="username"
                  autoFocus
                  required
                />
              </label>
              <label className="doc-login__field">
                <span>Password</span>
                <div className="doc-login__password">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="Your password"
                    autoComplete="current-password"
                    required
                  />
                  <button
                    type="button"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    title={showPassword ? 'Hide password' : 'Show password'}
                    onClick={() => setShowPassword((visible) => !visible)}
                  >
                    {showPassword ? <EyeOff size={17} aria-hidden="true" /> : <Eye size={17} aria-hidden="true" />}
                  </button>
                </div>
              </label>
              <button className="doc-login__submit" type="submit" disabled={busy || !username || !password}>
                {busy ? <><span className="signin__spinner" aria-hidden="true" /> Signing in…</> : <>Sign in <ArrowRight size={17} aria-hidden="true" /></>}
              </button>
            </form>
          </div>

          <footer className="doc-login__foot">
            <span><LockKeyhole size={12} aria-hidden="true" /> For your team only</span>
            <span className="doc-login__ticks" aria-hidden="true">Invoices on WhatsApp <CheckCheck size={14} /></span>
          </footer>
        </section>
      </div>
    </main>
  );
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

function LoadingScreen() {
  return (
    <main className="loading-screen">
      <span className="loading-brand">SD</span>
      <div className="spinner" />
      <p>Signing you in…</p>
    </main>
  );
}
