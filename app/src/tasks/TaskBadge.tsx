/** 任務分頁紅點：補貨單建立成功時 +1，進入任務分頁時歸零；登出時也歸零。 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useSignedOutReset } from '@/auth/useSignedOutReset';

interface TaskBadge {
  count: number;
  bump(): void;
  clear(): void;
}

const TaskBadgeContext = createContext<TaskBadge | null>(null);

export function TaskBadgeProvider({ children }: { children: ReactNode }) {
  const [count, setCount] = useState(0);
  const bump = useCallback(() => setCount((c) => c + 1), []);
  const clear = useCallback(() => setCount(0), []);
  useSignedOutReset(clear);
  const value = useMemo(() => ({ count, bump, clear }), [count, bump, clear]);
  return <TaskBadgeContext.Provider value={value}>{children}</TaskBadgeContext.Provider>;
}

export function useTaskBadge(): TaskBadge {
  const v = useContext(TaskBadgeContext);
  if (!v) throw new Error('useTaskBadge 必須在 TaskBadgeProvider 內使用');
  return v;
}
