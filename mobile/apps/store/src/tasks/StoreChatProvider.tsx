/** 門市版對話：寫入動作成功後讓今日重點與補貨單重新取資料、任務分頁亮紅點。 */
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, type ReactNode } from 'react';
import type { Endpoints } from '@hyagent/app-core/api/endpoints';
import { ChatProvider } from '@hyagent/app-core/chat/ChatProvider';
import { useTaskBadge } from './TaskBadge';

export function StoreChatProvider({ children, api }: { children: ReactNode; api?: Endpoints }) {
  const queryClient = useQueryClient();
  const { bump } = useTaskBadge();
  const onActionConfirmed = useCallback(() => {
    bump();
    void queryClient.invalidateQueries({ queryKey: ['todaySummary'] });
    void queryClient.invalidateQueries({ queryKey: ['replenishments'] });
  }, [bump, queryClient]);
  return (
    <ChatProvider api={api} onActionConfirmed={onActionConfirmed}>
      {children}
    </ChatProvider>
  );
}
