import { initialVoice, voiceReducer } from './voiceMachine';

describe('voiceReducer', () => {
  it('idle → recording → transcribing → idle', () => {
    let s = voiceReducer(initialVoice, { type: 'start', at: 100 });
    expect(s).toEqual({ mode: 'recording', startedAt: 100 });
    s = voiceReducer(s, { type: 'stop' });
    expect(s).toEqual({ mode: 'transcribing' });
    s = voiceReducer(s, { type: 'transcribed' });
    expect(s).toEqual({ mode: 'idle', hint: null });
  });

  it('非對應狀態的事件不改變狀態；失敗回 idle 並帶提示', () => {
    expect(voiceReducer(initialVoice, { type: 'stop' })).toBe(initialVoice);
    const rec = { mode: 'recording' as const, startedAt: 1 };
    expect(voiceReducer(rec, { type: 'start', at: 2 })).toBe(rec);
    expect(voiceReducer({ mode: 'transcribing' }, { type: 'failed', hint: '沒聽清楚' })).toEqual({ mode: 'idle', hint: '沒聽清楚' });
  });
});
