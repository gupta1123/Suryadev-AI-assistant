export type MessageLifecycleState = 'queued' | 'sent' | 'delivered' | 'read' | 'failed';

export type MessageStatusEvidence = {
  sent_at?: string | null;
  delivered_at?: string | null;
  read_at?: string | null;
};

export function messageLifecycleState(
  status: string | null | undefined,
  evidence: MessageStatusEvidence = {},
): MessageLifecycleState {
  const normalized = (status ?? '').toLowerCase();
  if (['failed', 'blocked', 'cancelled', 'rejected'].includes(normalized)) return 'failed';
  if (normalized === 'read' || evidence.read_at) return 'read';
  if (normalized === 'delivered' || evidence.delivered_at) return 'delivered';
  if (['sent', 'completed', 'succeeded'].includes(normalized) || evidence.sent_at) return 'sent';
  return 'queued';
}
