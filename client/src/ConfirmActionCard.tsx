/**
 * 寫入動作確認卡片：AI 提議的寫入（寄信、預約…）在這裡由使用者確認後才執行。
 * 一次性：按下後立刻鎖住，不論成功失敗都不再顯示按鈕（避免雙擊重送）。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PendingActionView } from '@hyagent/shared';
import { ApiError } from './api';

type Phase = 'ready' | 'busy' | 'done' | 'failed' | 'cancelled' | 'expired';

export interface ConfirmActionCardProps {
  action: PendingActionView;
  onConfirm(): Promise<{ ok: boolean; reply: string }>;
  onCancel(): Promise<{ reply: string }>;
}

export function ConfirmActionCard({ action, onConfirm, onCancel }: ConfirmActionCardProps) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>(() => (Date.parse(action.expiresAt) <= Date.now() ? 'expired' : 'ready'));
  const [error, setError] = useState<string | null>(null);

  async function run(kind: 'confirm' | 'cancel') {
    if (phase !== 'ready') return;
    setPhase('busy');
    try {
      if (kind === 'confirm') {
        const r = await onConfirm();
        setPhase(r.ok ? 'done' : 'failed');
      } else {
        await onCancel();
        setPhase('cancelled');
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.code === 'ACTION_EXPIRED') {
        setPhase('expired');
        return;
      }
      setError(e instanceof Error ? e.message : String(e));
      setPhase('failed');
    }
  }

  const statusText: Partial<Record<Phase, string>> = {
    busy: t('action.running'),
    done: t('action.done'),
    failed: t('action.failed'),
    cancelled: t('action.cancelled'),
    expired: t('action.expired'),
  };

  return (
    <div className="confirm-card" data-testid="confirm-action-card" data-phase={phase}>
      <div className="confirm-card-title">{action.summary.title}</div>
      <dl className="confirm-card-fields">
        {action.summary.fields.map((f) => (
          <div key={f.label} className="confirm-card-field">
            <dt>{f.label}</dt>
            <dd>{f.value}</dd>
          </div>
        ))}
      </dl>
      {phase === 'ready' || phase === 'busy' ? (
        <div className="confirm-card-actions">
          <button type="button" className="confirm-card-primary" data-testid="action-confirm" disabled={phase === 'busy'} onClick={() => void run('confirm')}>
            {phase === 'busy' ? t('action.running') : t('action.confirm')}
          </button>
          <button type="button" data-testid="action-cancel" disabled={phase === 'busy'} onClick={() => void run('cancel')}>
            {t('action.cancel')}
          </button>
        </div>
      ) : (
        <div className="confirm-card-status" role="status">
          {statusText[phase]}
          {error && <div className="confirm-card-error">{error}</div>}
        </div>
      )}
    </div>
  );
}
