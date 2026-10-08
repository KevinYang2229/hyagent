/**
 * 語音輸入：權限 → 錄音（最長 60 秒）→ 上傳轉文字 → 交給 onText。
 * 狀態用 ref 同步保存，讓「剛開始就按停止」或計時器觸發時讀得到最新狀態。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, errorMessage } from '@hyagent/app-core/api/errors';
import type { UploadFile } from '@hyagent/app-core/api/types';
import type { Recorder } from './types';
import {
  MAX_RECORDING_MS, MIN_RECORDING_MS, NOT_HEARD, PERMISSION_HINT, SPEECH_OFF_HINT, initialVoice, voiceReducer,
  type VoiceEvent, type VoiceState,
} from './voiceMachine';

export function useVoiceInput({
  recorder,
  transcribe,
  onText,
  now = Date.now,
}: {
  recorder: Recorder;
  transcribe(file: UploadFile): Promise<{ text: string }>;
  onText(text: string): void;
  now?: () => number;
}) {
  const [state, setState] = useState<VoiceState>(initialVoice);
  const [available, setAvailable] = useState(true);
  const ref = useRef<VoiceState>(initialVoice);
  const availableRef = useRef(true);
  const mounted = useRef(true);
  const starting = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deps = useRef({ recorder, transcribe, onText, now });
  deps.current = { recorder, transcribe, onText, now };

  const apply = useCallback((e: VoiceEvent) => {
    if (!mounted.current) return;
    ref.current = voiceReducer(ref.current, e);
    setState(ref.current);
  }, []);

  const stop = useCallback(async () => {
    const cur = ref.current;
    if (cur.mode !== 'recording') return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    apply({ type: 'stop' });
    const d = deps.current;
    let rec: { uri: string } | null;
    try {
      rec = await d.recorder.stop();
    } catch {
      apply({ type: 'failed', hint: '錄音失敗，請再試一次。' });
      return;
    }
    if (!mounted.current) return;
    if (!rec || d.now() - cur.startedAt < MIN_RECORDING_MS) {
      apply({ type: 'failed', hint: NOT_HEARD });
      return;
    }
    try {
      const { text } = await d.transcribe({ uri: rec.uri, name: 'speech.m4a', type: 'audio/m4a' });
      if (!mounted.current) return;
      const t = text.trim();
      if (!t) {
        apply({ type: 'failed', hint: NOT_HEARD });
        return;
      }
      apply({ type: 'transcribed' });
      d.onText(t);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'SPEECH_UNAVAILABLE') {
        availableRef.current = false;
        setAvailable(false);
        apply({ type: 'failed', hint: SPEECH_OFF_HINT });
        return;
      }
      apply({ type: 'failed', hint: errorMessage(e) });
    }
  }, [apply]);

  const start = useCallback(async () => {
    // starting 同步旗標：await 權限／開始錄音期間 mode 仍是 idle，避免連點或自動開始＋手點重複進入
    if (!availableRef.current || ref.current.mode !== 'idle' || starting.current) return;
    starting.current = true;
    try {
      const d = deps.current;
      let granted = false;
      try {
        granted = await d.recorder.requestPermission();
      } catch {
        granted = false;
      }
      if (!granted) {
        apply({ type: 'failed', hint: PERMISSION_HINT });
        return;
      }
      try {
        await d.recorder.start();
      } catch {
        apply({ type: 'failed', hint: '無法開始錄音，請再試一次。' });
        return;
      }
      if (!mounted.current) {
        void d.recorder.stop().catch(() => undefined);
        return;
      }
      apply({ type: 'start', at: d.now() });
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void stop(), MAX_RECORDING_MS);
    } finally {
      starting.current = false;
    }
  }, [apply, stop]);

  // 卸載：停止計時；若還在錄音就停掉錄音器（還原音訊模式），之後不再更新狀態或呼叫 onText
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      if (ref.current.mode === 'recording') void deps.current.recorder.stop().catch(() => undefined);
    };
  }, []);

  return { state, available, start, stop };
}
