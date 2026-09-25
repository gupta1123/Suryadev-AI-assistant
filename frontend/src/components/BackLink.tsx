import { ArrowLeft } from 'lucide-react';

// The page we came from is stored in history state by the app router on every in-app navigation.
type HistoryState = { from?: string } | null;

const PAGE_LABELS: Array<[RegExp, string]> = [
  [/^\/documents\/\d+/, 'Document'],
  [/^\/documents/, 'Documents'],
  [/^\/customers\/\d+/, 'Customer'],
  [/^\/customers/, 'Customers'],
  [/^\/payments\/\d+/, 'Payment'],
  [/^\/payments/, 'Payments'],
  [/^\/attention/, 'Needs attention'],
  [/^\/settings/, 'Settings'],
  [/^\/$/, 'Home'],
];

function labelFor(path: string): string | null {
  return PAGE_LABELS.find(([pattern]) => pattern.test(path))?.[1] ?? null;
}

/** Back link that returns to the page the user actually came from, or to a sensible parent page. */
export function BackLink({
  fallbackPath,
  fallbackLabel,
  onNavigate,
}: {
  fallbackPath: string;
  fallbackLabel: string;
  onNavigate: (path: string) => void;
}) {
  const from = (window.history.state as HistoryState)?.from;
  const fromLabel = from ? labelFor(from) : null;
  const useHistory = Boolean(from && fromLabel && from !== window.location.pathname);

  return (
    <button
      className="back-link"
      type="button"
      onClick={() => (useHistory ? window.history.back() : onNavigate(fallbackPath))}
    >
      <ArrowLeft size={15} aria-hidden="true" /> {useHistory ? fromLabel : fallbackLabel}
    </button>
  );
}
