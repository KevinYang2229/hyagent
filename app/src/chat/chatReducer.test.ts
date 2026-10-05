import type { PendingActionView } from '@hyagent/shared';
import { chatReducer, initialChatState } from './chatReducer';
import type { ChatState } from './types';

const action: PendingActionView = { id: 'a1', summary: { title: '建立補貨單', fields: [] }, expiresAt: '2099-01-01T00:00:00.000Z' };

describe('chatReducer', () => {
  it('送出 → 加使用者訊息、sending；收到回合 → 加 AI 訊息（含表格）、記下對話 id 與待確認動作', () => {
    let s = chatReducer(initialChatState, { type: 'userSent', text: '查庫存' });
    expect(s.sending).toBe(true);
    expect(s.messages[0]).toMatchObject({ role: 'user', text: '查庫存' });
    const block = { type: 'table' as const, columns: [], rows: [] };
    s = chatReducer(s, { type: 'turnReceived', conversationId: 'c1', turn: { status: 'collecting', reply: '查到了', blocks: [block], suggestions: ['補貨'], pendingAction: action } });
    expect(s).toMatchObject({ sending: false, conversationId: 'c1', pending: action });
    expect(s.messages[1]).toMatchObject({ role: 'agent', text: '查到了', blocks: [block], suggestions: ['補貨'] });
  });

  it('沒有 reply 不加訊息；新回合沒有待確認動作 → 清掉舊的', () => {
    let s: ChatState = { ...initialChatState, conversationId: 'c1', pending: action };
    s = chatReducer(s, { type: 'turnReceived', turn: { status: 'collecting', reply: null } });
    expect(s.messages).toHaveLength(0);
    expect(s.pending).toBeNull();
    expect(s.conversationId).toBe('c1');
  });

  it('送出失敗 → 錯誤系統訊息；動作完成／取消／失效 → 清掉待確認', () => {
    let s = chatReducer({ ...initialChatState, sending: true }, { type: 'sendFailed', message: '無法連線' });
    expect(s.sending).toBe(false);
    expect(s.messages.at(-1)).toMatchObject({ role: 'system', tone: 'error', text: '無法連線' });
    s = chatReducer({ ...s, pending: action }, { type: 'actionFinished', text: '已完成「建立補貨單」。' });
    expect(s.pending).toBeNull();
    expect(s.messages.at(-1)).toMatchObject({ role: 'agent', text: '已完成「建立補貨單」。' });
    s = chatReducer({ ...s, pending: action }, { type: 'actionGone', message: '已逾時' });
    expect(s.pending).toBeNull();
    expect(s.messages.at(-1)).toMatchObject({ role: 'system', tone: 'info' });
  });

  it('提議動作記下對話 id；reset 回到初始', () => {
    let s = chatReducer(initialChatState, { type: 'actionProposed', conversationId: 'c9', action });
    expect(s).toMatchObject({ conversationId: 'c9', pending: action });
    s = chatReducer(s, { type: 'reset' });
    expect(s).toEqual(initialChatState);
  });
});
