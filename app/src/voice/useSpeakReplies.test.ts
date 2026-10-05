import { renderHook } from '@testing-library/react-native';
import type { ChatMessage } from '@/chat/types';
import { useSpeakReplies } from './useSpeakReplies';

const agent = (id: string, text: string): ChatMessage => ({ id, role: 'agent', text, at: 0 });
const user = (id: string, text: string): ChatMessage => ({ id, role: 'user', text, at: 0 });

describe('useSpeakReplies', () => {
  it('不唸既有的歷史；新的 AI 回覆才唸；使用者訊息不唸', async () => {
    const speak = jest.fn();
    const stop = jest.fn();
    const { rerender } = await renderHook(({ m, on }: { m: ChatMessage[]; on: boolean }) => useSpeakReplies(m, on, speak, stop), {
      initialProps: { m: [agent('a1', '舊的')], on: true },
    });
    expect(speak).not.toHaveBeenCalled();
    await rerender({ m: [agent('a1', '舊的'), user('u1', '問')], on: true });
    expect(speak).not.toHaveBeenCalled();
    await rerender({ m: [agent('a1', '舊的'), user('u1', '問'), agent('a2', '新的回覆')], on: true });
    expect(speak).toHaveBeenCalledWith('新的回覆');
  });

  it('關閉時不唸並停止朗讀', async () => {
    const speak = jest.fn();
    const stop = jest.fn();
    const { rerender } = await renderHook(({ m, on }: { m: ChatMessage[]; on: boolean }) => useSpeakReplies(m, on, speak, stop), {
      initialProps: { m: [] as ChatMessage[], on: true },
    });
    await rerender({ m: [], on: false });
    expect(stop).toHaveBeenCalled();
    await rerender({ m: [agent('a1', '回覆')], on: false });
    expect(speak).not.toHaveBeenCalled();
  });
});
