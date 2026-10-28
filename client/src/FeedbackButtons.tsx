/**
 * AI 回覆的讚／倒讚。樂觀更新：先改畫面再送，失敗還原並回報。
 * 倒讚立即記錄，再以彈窗填寫原因；送出把原因與說明補進同一筆，略過只保留倒讚。
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { FeedbackReason, ReplyFeedbackInput } from '@hyagent/shared';
import { Dialog } from '@hyagent/ui';
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
  const downRef = useRef<HTMLButtonElement>(null);
  const questionnaireRef = useRef<HTMLDivElement>(null);

  // 彈窗內循環鍵盤焦點，關閉後回到倒讚鈕；背景訊息不跟著捲動。
  useEffect(() => {
    if (!panelOpen) return;
    const dialog = questionnaireRef.current?.closest<HTMLElement>('[role="dialog"]');
    const trigger = downRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    questionnaireRef.current?.querySelector<HTMLInputElement>('input')?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !dialog) return;
      const selectedRadio = dialog.querySelector('input[type="radio"]:checked')
        ?? dialog.querySelector('input[type="radio"]');
      const controls = Array.from(dialog.querySelectorAll<HTMLElement>('input, button'))
        .filter((control) => !control.matches(':disabled')
          && (!(control instanceof HTMLInputElement) || control.type !== 'radio' || control === selectedRadio));
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first?.focus();
      }
    };
    dialog?.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      dialog?.removeEventListener('keydown', onKeyDown);
      if (trigger?.isConnected) trigger.focus();
    };
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
    <>
      <span className="feedback">
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
          ref={downRef}
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
      </span>
      <Dialog isOpen={panelOpen} title={t('app.feedbackPanelTitle')}
        cancelText={t('app.feedbackSkip')} confirmText={t('app.feedbackSubmit')}
        onClose={() => setPanelOpen(false)} onConfirm={() => void submitDetail()}>
        <div ref={questionnaireRef} className="feedback-questionnaire">
          <div className="feedback-reasons" role="radiogroup" aria-label={t('app.feedbackPanelTitle')}>
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
        </div>
      </Dialog>
    </>
  );
}
