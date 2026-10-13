import { act, fireEvent, render, screen } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import { ChatContextForTest } from './ChatProvider';
import { MessageBubble } from './MessageBubble';
import type { ChatMessage } from './types';

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn().mockResolvedValue(undefined) }));

const messages: ChatMessage[] = [
  { id: '1', role: 'user', text: '查庫存', at: 0 },
  { id: '2', role: 'agent', text: '庫存充足', at: 0 },
  { id: '3', role: 'system', text: '連線失敗', tone: 'error', at: 0 },
];

it.each(messages)('$role 訊息可複製，也可帶回輸入框重新編輯', async (message) => {
  const onEdit = jest.fn();
  await render(<MessageBubble message={message} showSuggestions={false} onSuggestion={jest.fn()} onEdit={onEdit} />);
  await act(async () => { await fireEvent.press(screen.getByLabelText('複製訊息')); });
  expect(Clipboard.setStringAsync).toHaveBeenLastCalledWith(message.text);
  expect(screen.getByLabelText('已複製訊息')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('重新編輯訊息'));
  expect(onEdit).toHaveBeenCalledWith(message.text);
});

describe('評價按鈕', () => {
  function renderWithChat(message: ChatMessage, rate = jest.fn().mockResolvedValue(true)) {
    return render(
      <ChatContextForTest.Provider value={{ rate } as never}>
        <MessageBubble message={message} showSuggestions={false} onSuggestion={jest.fn()} onEdit={jest.fn()} />
      </ChatContextForTest.Provider>,
    );
  }

  it('有 replyId 的 AI 回覆顯示讚／倒讚；按讚呼叫 rate', async () => {
    const rate = jest.fn().mockResolvedValue(true);
    await renderWithChat({ id: 'a1', role: 'agent', text: '答', replyId: 'r1', conversationId: 'c1', at: 0 }, rate);
    await act(async () => { await fireEvent.press(screen.getByLabelText('有幫助')); });
    expect(rate).toHaveBeenCalledWith('a1', { rating: 'up' });
  });

  it('倒讚後開啟原因面板，送出補上原因', async () => {
    const rate = jest.fn().mockResolvedValue(true);
    await renderWithChat({ id: 'a1', role: 'agent', text: '答', replyId: 'r1', conversationId: 'c1', at: 0 }, rate);
    await act(async () => { await fireEvent.press(screen.getByLabelText('沒有幫助')); });
    expect(rate).toHaveBeenLastCalledWith('a1', { rating: 'down' });
    await fireEvent.press(screen.getByLabelText('答錯了'));
    await act(async () => { await fireEvent.press(screen.getByLabelText('送出回饋')); });
    expect(rate).toHaveBeenLastCalledWith('a1', { rating: 'down', reason: 'wrong' });
  });

  it('沒有 replyId 或不在 ChatProvider 內時不顯示評價', async () => {
    await render(<MessageBubble message={{ id: 'a1', role: 'agent', text: '答', replyId: 'r1', at: 0 }} showSuggestions={false} onSuggestion={jest.fn()} onEdit={jest.fn()} />);
    expect(screen.queryByLabelText('有幫助')).toBeNull();
    await renderWithChat({ id: 'a2', role: 'agent', text: '答', at: 0 });
    expect(screen.queryByLabelText('有幫助')).toBeNull();
  });

  it('上一次評價尚未完成時，再按不會重複呼叫 rate', async () => {
    let resolve!: (v: boolean) => void;
    const rate = jest.fn().mockImplementation(() => new Promise<boolean>((r) => { resolve = r; }));
    await renderWithChat({ id: 'a1', role: 'agent', text: '答', replyId: 'r1', conversationId: 'c1', at: 0 }, rate);
    await act(async () => { await fireEvent.press(screen.getByLabelText('有幫助')); });
    await act(async () => { await fireEvent.press(screen.getByLabelText('有幫助')); });
    await act(async () => { await fireEvent.press(screen.getByLabelText('沒有幫助')); });
    expect(rate).toHaveBeenCalledTimes(1);
    await act(async () => { resolve(true); });
    await act(async () => { await fireEvent.press(screen.getByLabelText('有幫助')); });
    expect(rate).toHaveBeenCalledTimes(2);
  });
});
