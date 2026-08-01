import {
  AlertCircle,
  CheckCircle2,
  Eye,
  EyeOff,
  FileCheck2,
  FileText,
  LockKeyhole,
  LogIn,
  MessageCircleMore,
  ShieldCheck,
  UserRound,
} from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import logoImg from './assets/suryadev-logo.jpg';
import { apiRequest, ApiError, AUTH_UNAUTHORIZED_EVENT } from './lib/api';
import { DeliveriesPage } from './pages/DeliveriesPage';
import { DeliveryDetailPage } from './pages/DeliveryDetailPage';
import { OverviewPage } from './pages/OverviewPage';
import { HelpRequestsPage } from './pages/HelpRequestsPage';
import type { AdminUser, AppRoute } from './types';

type AuthResponse = { user: AdminUser; expiresAt: string };

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
    const remainingMs = sessionExpiresAt - Date.now();
    if (remainingMs <= 0) {
      expireSession();
      return;
    }
    const timeout = window.setTimeout(expireSession, remainingMs);
    return () => window.clearTimeout(timeout);
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
      window.history.pushState(null, '', nextPath);
    }
    setPath(nextPath);
  }, []);

  const route = parseRoute(path);

  if (route.page === 'overview') {
    return (
      <OverviewPage
        route={route}
        onNavigate={navigate}
        user={user}
        onLogout={onLogout}
        loggingOut={loggingOut}
      />
    );
  }

  if (route.page === 'deliveries') {
    return (
      <DeliveriesPage
        route={route}
        onNavigate={navigate}
        user={user}
        onLogout={onLogout}
        loggingOut={loggingOut}
      />
    );
  }

  if (route.page === 'delivery' && route.jobId) {
    return (
      <DeliveryDetailPage
        route={route}
        jobId={route.jobId}
        onNavigate={navigate}
        user={user}
        onLogout={onLogout}
        loggingOut={loggingOut}
      />
    );
  }

  if (route.page === 'helpRequests') {
    return (
      <HelpRequestsPage
        route={route}
        onNavigate={navigate}
        user={user}
        onLogout={onLogout}
        loggingOut={loggingOut}
      />
    );
  }

  return (
    <OverviewPage
      route={route}
      onNavigate={navigate}
      user={user}
      onLogout={onLogout}
      loggingOut={loggingOut}
    />
  );
}

function parseRoute(pathname: string): AppRoute {
  const deliveryMatch = pathname.match(/^\/deliveries\/(\d+)\/?$/);
  if (deliveryMatch) return { page: 'delivery', jobId: Number(deliveryMatch[1]) };
  if (/^\/deliveries\/?$/.test(pathname)) return { page: 'deliveries' };
  if (/^\/help-requests\/?$/.test(pathname)) return { page: 'helpRequests' };
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

  return (
    <main className="login-shell">
      <section className="login-brand-panel" aria-label="SuryaDev Invoice Delivery">
        <div className="login-brand">
          <img src={logoImg} alt="SuryaDev Logo" className="login-brand-logo-img" />
          <span><strong>SuryaDev</strong><small>Invoice Delivery Agent</small></span>
        </div>

        <div className="login-brand-content">
          <p className="login-eyebrow">Operations workspace</p>
          <h1>Invoices delivered.<br />Every send visible.</h1>
          <p>One secure place to test invoice delivery, review the exact customer message and follow its complete delivery history.</p>
          <div className="login-benefits">
            <span><CheckCircle2 size={17} aria-hidden="true" /> Controlled test deliveries</span>
            <span><FileText size={17} aria-hidden="true" /> Invoice and PDF audit trail</span>
            <span><MessageCircleMore size={17} aria-hidden="true" /> WhatsApp provider visibility</span>
          </div>
        </div>

        <p className="login-brand-footer"><ShieldCheck size={15} aria-hidden="true" /> Administrator-only workspace</p>
      </section>

      <section className="login-form-panel">
        <div className="login-card">
          <span className="auth-icon"><LockKeyhole size={23} aria-hidden="true" /></span>
          <p className="eyebrow">Secure admin access</p>
          <h2>Welcome back</h2>
          <p className="login-card-description">Sign in to manage test invoice deliveries and communication history.</p>

          {error && (
            <div className="auth-error" role="alert">
              <AlertCircle size={17} aria-hidden="true" />
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={(event) => void signIn(event)}>
            <label className="auth-field">
              <span>Username</span>
              <div className="auth-input-shell">
                <UserRound size={18} aria-hidden="true" />
                <input
                  type="text"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  placeholder="Enter your username"
                  autoComplete="username"
                  autoFocus
                  required
                />
              </div>
            </label>
            <label className="auth-field">
              <span>Password</span>
              <div className="auth-input-shell">
                <LockKeyhole size={18} aria-hidden="true" />
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                  required
                />
                <button
                  type="button"
                  className="password-toggle"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  onClick={() => setShowPassword((visible) => !visible)}
                >
                  {showPassword ? <EyeOff size={17} aria-hidden="true" /> : <Eye size={17} aria-hidden="true" />}
                </button>
              </div>
            </label>
            <button className="button button--primary button--wide login-submit" type="submit" disabled={busy || !username || !password}>
              <LogIn size={17} aria-hidden="true" /> {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <div className="session-note">
            <ShieldCheck size={17} aria-hidden="true" />
            <span>Your session is protected by a secure, HTTP-only cookie and expires automatically.</span>
          </div>
        </div>
        <p className="login-product-note">SuryaDev AI Agents · Invoice Delivery</p>
      </section>
    </main>
  );
}

function LoadingScreen() {
  return (
    <main className="loading-screen">
      <span className="loading-brand">SD</span>
      <div className="spinner" />
      <p>Checking your secure session…</p>
    </main>
  );
}
