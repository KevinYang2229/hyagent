/**
 * AI 產品顧問面板的開關：中央 HyAgent 按鈕與各頁的「問 AI」都透過這裡打開面板，
 * 帶問題時直接送出（回覆中會由 ChatProvider 排隊）。
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useChat } from '@hyagent/app-core/chat/ChatProvider';

interface AdvisorContextValue {
  open: boolean;
  /** 打開面板；有 question 就直接送出 */
  show(question?: string): void;
  hide(): void;
}

const AdvisorContext = createContext<AdvisorContextValue | null>(null);

export function AdvisorProvider({ children }: { children: ReactNode }) {
  const chat = useChat();
  const [open, setOpen] = useState(false);
  const send = chat.send;
  const show = useCallback((question?: string) => {
    setOpen(true);
    if (question?.trim()) void send(question);
  }, [send]);
  const hide = useCallback(() => setOpen(false), []);
  const value = useMemo(() => ({ open, show, hide }), [open, show, hide]);
  return <AdvisorContext.Provider value={value}>{children}</AdvisorContext.Provider>;
}

export function useAdvisor(): AdvisorContextValue {
  const v = useContext(AdvisorContext);
  if (!v) throw new Error('useAdvisor 必須在 AdvisorProvider 內使用');
  return v;
}
