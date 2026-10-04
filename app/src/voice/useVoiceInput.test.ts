import { act, renderHook } from '@testing-library/react-native';
import { ApiError } from '@/api/errors';
import type { Recorder } from './types';
import { MAX_RECORDING_MS, NOT_HEARD, PERMISSION_HINT } from './voiceMachine';
import { useVoiceInput } from './useVoiceInput';

function fakeRecorder(over: Partial<Recorder> = {}): Recorder {
  return {
    requestPermission: jest.fn(async () => true),
    start: jest.fn(async () => undefined),
    stop: jest.fn(async () => ({ uri: 'file:///rec.m4a' })),
    ...over,
  };
}

async function setup(recorder: Recorder, transcribe: jest.Mock, clock: { t: number }) {
  const onText = jest.fn();
  const hook = await renderHook(() => useVoiceInput({ recorder, transcribe, onText, now: () => clock.t }));
  return { ...hook, onText };
}

describe('useVoiceInput', () => {
  it('錄音 → 停止 → 轉文字 → onText', async () => {
    const clock = { t: 0 };
    const transcribe = jest.fn(async () => ({ text: ' 查庫存 ' }));
    const { result, onText } = await setup(fakeRecorder(), transcribe, clock);
    await act(async () => { await result.current.start(); });
    expect(result.current.state.mode).toBe('recording');
    clock.t = 2000;
    await act(async () => { await result.current.stop(); });
    expect(transcribe).toHaveBeenCalledWith({ uri: 'file:///rec.m4a', name: 'speech.m4a', type: 'audio/m4a' });
    expect(onText).toHaveBeenCalledWith('查庫存');
    expect(result.current.state).toEqual({ mode: 'idle', hint: null });
  });

  it('不到 500 毫秒 → 不上傳、提示沒聽清楚', async () => {
    const clock = { t: 0 };
    const transcribe = jest.fn();
    const { result, onText } = await setup(fakeRecorder(), transcribe, clock);
    await act(async () => { await result.current.start(); });
    clock.t = 300;
    await act(async () => { await result.current.stop(); });
    expect(transcribe).not.toHaveBeenCalled();
    expect(onText).not.toHaveBeenCalled();
    expect(result.current.state).toEqual({ mode: 'idle', hint: NOT_HEARD });
  });

  it('轉出空字串 → 不送出、提示沒聽清楚', async () => {
    const clock = { t: 0 };
    const { result, onText } = await setup(fakeRecorder(), jest.fn(async () => ({ text: '   ' })), clock);
    await act(async () => { await result.current.start(); });
    clock.t = 1500;
    await act(async () => { await result.current.stop(); });
    expect(onText).not.toHaveBeenCalled();
    expect(result.current.state).toEqual({ mode: 'idle', hint: NOT_HEARD });
  });

  it('沒有麥克風權限 → 不錄音、提示權限', async () => {
    const recorder = fakeRecorder({ requestPermission: jest.fn(async () => false) });
    const { result } = await setup(recorder, jest.fn(), { t: 0 });
    await act(async () => { await result.current.start(); });
    expect(recorder.start).not.toHaveBeenCalled();
    expect(result.current.state).toEqual({ mode: 'idle', hint: PERMISSION_HINT });
  });

  it('語音未啟用（503 SPEECH_UNAVAILABLE）→ available=false，之後 start 不動作', async () => {
    const clock = { t: 0 };
    const recorder = fakeRecorder();
    const transcribe = jest.fn(async () => { throw new ApiError('未啟用', 503, 'SPEECH_UNAVAILABLE'); });
    const { result } = await setup(recorder, transcribe, clock);
    await act(async () => { await result.current.start(); });
    clock.t = 1000;
    await act(async () => { await result.current.stop(); });
    expect(result.current.available).toBe(false);
    await act(async () => { await result.current.start(); });
    expect(recorder.start).toHaveBeenCalledTimes(1);
  });

  it('錄滿 60 秒自動停止並轉文字', async () => {
    jest.useFakeTimers();
    try {
      const clock = { t: 0 };
      const transcribe = jest.fn(async () => ({ text: '好' }));
      const { result, onText } = await setup(fakeRecorder(), transcribe, clock);
      await act(async () => { await result.current.start(); });
      clock.t = MAX_RECORDING_MS;
      await act(async () => { jest.advanceTimersByTime(MAX_RECORDING_MS); });
      await act(async () => { await Promise.resolve(); });
      expect(transcribe).toHaveBeenCalledTimes(1);
      expect(onText).toHaveBeenCalledWith('好');
    } finally {
      jest.useRealTimers();
    }
  });

  it('上傳失敗 → 回 idle 並顯示錯誤訊息', async () => {
    const clock = { t: 0 };
    const transcribe = jest.fn(async () => { throw new ApiError('無法連線到伺服器，請檢查網路', 0, 'NETWORK'); });
    const { result } = await setup(fakeRecorder(), transcribe, clock);
    await act(async () => { await result.current.start(); });
    clock.t = 1000;
    await act(async () => { await result.current.stop(); });
    expect(result.current.state).toEqual({ mode: 'idle', hint: '無法連線到伺服器，請檢查網路' });
  });

  it('錄音中卸載 → 停止錄音器', async () => {
    const recorder = fakeRecorder();
    const { result, unmount } = await setup(recorder, jest.fn(), { t: 0 });
    await act(async () => { await result.current.start(); });
    await unmount();
    expect(recorder.stop).toHaveBeenCalledTimes(1);
  });

  it('卸載後才轉完文字 → 不呼叫 onText', async () => {
    const clock = { t: 0 };
    let resolve: (v: { text: string }) => void = () => undefined;
    const transcribe = jest.fn(() => new Promise<{ text: string }>((r) => { resolve = r; }));
    const { result, onText, unmount } = await setup(fakeRecorder(), transcribe, clock);
    await act(async () => { await result.current.start(); });
    clock.t = 2000;
    let pending: Promise<void> = Promise.resolve();
    await act(async () => { pending = result.current.stop(); await Promise.resolve(); });
    await unmount();
    resolve({ text: '查庫存' });
    await pending;
    expect(onText).not.toHaveBeenCalled();
  });

  it('同一時間連按兩次 start → 只開始錄音一次', async () => {
    const recorder = fakeRecorder();
    const { result } = await setup(recorder, jest.fn(), { t: 0 });
    await act(async () => { await Promise.all([result.current.start(), result.current.start()]); });
    expect(recorder.start).toHaveBeenCalledTimes(1);
    expect(result.current.state.mode).toBe('recording');
  });

  it('requestPermission 丟例外 → 回 idle 並提示權限，不產生未處理的拒絕', async () => {
    const recorder = fakeRecorder({ requestPermission: jest.fn(async () => { throw new Error('boom'); }) });
    const { result } = await setup(recorder, jest.fn(), { t: 0 });
    await act(async () => { await result.current.start(); });
    expect(result.current.state).toEqual({ mode: 'idle', hint: PERMISSION_HINT });
  });
});
