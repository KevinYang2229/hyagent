import { act, fireEvent, render, screen } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
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
