/** 有待確認動作時，在任何分頁上跳出確認彈窗；key 綁動作 id，換新動作就重置編輯狀態。 */
import { useChat } from '@hyagent/app-core/chat/ChatProvider';
import { ConfirmModal } from './ConfirmModal';

export function ConfirmModalHost() {
  const chat = useChat();
  const pending = chat.state.pending;
  return <ConfirmModal key={pending?.id ?? 'none'} action={pending} onConfirm={chat.confirm} onCancel={chat.cancel} />;
}
