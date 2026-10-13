/**
 * AI 回覆的讚／倒讚。樂觀更新：先改畫面再送，失敗還原並回報。
 * 倒讚立即記錄，再展開原因面板；送出把原因與說明補進同一筆，略過只保留倒讚。
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { FeedbackReason, ReplyFeedbackInput } from '@hyagent/shared';
import { api } from './api';
import { useImeSubmit } from './useImeSubmit';

const REASONS: { value: FeedbackReason; key: string }[] = [
  { value: 'wrong', key: 'app.feedbackReasonWrong' },
  { value: 'not_answered', key: 'app.feedbackReasonNotAnswered' },
  { value: 'outdated', key: 'app.feedbackReasonOutdated' },
  { value: 'inappropriate', key: 'app.feedbackReasonInappropriate' },
  { value: 'other', key: 'app.feedbackReasonOther' },
];

const COMMENT_MAX = 500;
const THANKS_MS = 2000;

interface Props {
  convId: string;
  replyId: string;
  userId: string;
  value?: ReplyFeedbackInput;
  onChange(next: ReplyFeedbackInput | undefined): void;
  onError(message: string): void;
}

export function FeedbackButtons({ convId, replyId, userId, value, onChange, onError }: Props) {
  const { t } = useTranslation();
  const [panelOpen, setPanelOpen] = useState(false);
  const [reason, setReason] = useState<FeedbackReason | undefined>();
  const [comment, setComment] = useState('');
  const [thanks, setThanks] = useState(false);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  // 點面板外＝略過
  useEffect(() => {
    if (!panelOpen) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setPanelOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [panelOpen]);

  useEffect(() => {
    if (!thanks) return;
    const timer = setTimeout(() => setThanks(false), THANKS_MS);
    return () => clearTimeout(timer);
  }, [thanks]);

  async function apply(next: ReplyFeedbackInput | undefined): Promise<boolean> {
    const previous = value;
    pendingRef.current = true;
    setPending(true);
    onChange(next);
    try {
      if (next) await api.setFeedback(userId, convId, replyId, next);
      else await api.clearFeedback(userId, convId, replyId);
      return true;
    } catch (e) {
      onChange(previous);
      onError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  async function clickUp() {
    if (pendingRef.current) return;
    setPanelOpen(false);
    if (value?.rating === 'up') {
      await apply(undefined);
      return;
    }
    if (await apply({ rating: 'up' })) setThanks(true);
  }

  async function clickDown() {
    if (pendingRef.current) return;
    if (value?.rating === 'down') {
      setPanelOpen(false);
      await apply(undefined);
      return;
    }
    setReason(undefined);
    setComment('');
    if (await apply({ rating: 'down' })) setPanelOpen(true);
  }

  async function submitDetail() {
    if (pendingRef.current) return;
    const trimmed = comment.trim();
    const next: ReplyFeedbackInput = { rating: 'down', ...(reason ? { reason } : {}), ...(trimmed ? { comment: trimmed } : {}) };
    setPanelOpen(false);
    if (await apply(next)) setThanks(true);
  }

  // 選字 Enter（含 Safari 的 keyCode 229）留給輸入法，不能當成送出
  const ime = useImeSubmit(() => void submitDetail());

  return (
    <span ref={wrapRef} className="feedback">
      <button
        type="button"
        className={`msg-action${value?.rating === 'up' ? ' msg-action--active' : ''}`}
        aria-label={t('app.feedbackUp')}
        title={t('app.feedbackUp')}
        aria-pressed={value?.rating === 'up'}
        disabled={pending}
        onClick={() => void clickUp()}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill={value?.rating === 'up' ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M7 10v12" />
          <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z" />
        </svg>
      </button>
      <button
        type="button"
        className={`msg-action${value?.rating === 'down' ? ' msg-action--active' : ''}`}
        aria-label={t('app.feedbackDown')}
        title={t('app.feedbackDown')}
        aria-pressed={value?.rating === 'down'}
        disabled={pending}
        onClick={() => void clickDown()}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill={value?.rating === 'down' ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M17 14V2" />
          <path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z" />
        </svg>
      </button>
      {thanks && <span className="feedback-thanks" role="status">{t('app.feedbackThanks')}</span>}
      {panelOpen && (
        <div className="feedback-panel" role="dialog" aria-label={t('app.feedbackPanelTitle')}>
          <div className="feedback-panel-title">{t('app.feedbackPanelTitle')}</div>
          <div className="feedback-reasons" role="radiogroup">
            {REASONS.map((r) => (
              <label key={r.value} className={`feedback-reason${reason === r.value ? ' is-selected' : ''}`}>
                <input
                  type="radio"
                  name={`feedback-reason-${replyId}`}
                  value={r.value}
                  checked={reason === r.value}
                  onChange={() => setReason(r.value)}
                />
                {t(r.key)}
              </label>
            ))}
          </div>
          <input
            className="feedback-comment"
            aria-label={t('app.feedbackComment')}
            placeholder={t('app.feedbackComment')}
            value={comment}
            maxLength={COMMENT_MAX}
            onChange={(e) => setComment(e.target.value)}
            onCompositionStart={ime.onCompositionStart}
            onCompositionEnd={ime.onCompositionEnd}
            onKeyDown={ime.onKeyDown}
            onKeyUp={ime.onKeyUp}
          />
          <div className="feedback-panel-actions">
            <button type="button" className="feedback-skip" onClick={() => setPanelOpen(false)}>{t('app.feedbackSkip')}</button>
            <button type="button" className="feedback-submit" disabled={pending} onClick={() => void submitDetail()}>{t('app.feedbackSubmit')}</button>
          </div>
        </div>
      )}
    </span>
  );
}
