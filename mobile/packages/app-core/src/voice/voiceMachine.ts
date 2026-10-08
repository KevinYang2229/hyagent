/** 語音輸入狀態（純函式）：待機 → 錄音 → 轉文字 → 待機；失敗回待機並帶提示。 */
export const MAX_RECORDING_MS = 60_000;
export const MIN_RECORDING_MS = 500;
export const NOT_HEARD = '沒聽清楚，再說一次好嗎？';
export const PERMISSION_HINT = '需要麥克風權限才能語音對話，請到系統設定開啟，或改用打字。';
export const SPEECH_OFF_HINT = '語音辨識目前未啟用，請改用打字。';

export type VoiceState = { mode: 'idle'; hint: string | null } | { mode: 'recording'; startedAt: number } | { mode: 'transcribing' };

export type VoiceEvent =
  | { type: 'start'; at: number }
  | { type: 'stop' }
  | { type: 'transcribed' }
  | { type: 'failed'; hint: string };

export const initialVoice: VoiceState = { mode: 'idle', hint: null };

export function voiceReducer(s: VoiceState, e: VoiceEvent): VoiceState {
  switch (e.type) {
    case 'start':
      return s.mode === 'idle' ? { mode: 'recording', startedAt: e.at } : s;
    case 'stop':
      return s.mode === 'recording' ? { mode: 'transcribing' } : s;
    case 'transcribed':
      return { mode: 'idle', hint: null };
    case 'failed':
      return { mode: 'idle', hint: e.hint };
    default:
      return s;
  }
}
