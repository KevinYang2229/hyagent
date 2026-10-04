/**
 * 語音輸入：權限 → 錄音（最長 60 秒）→ 上傳轉文字 → 交給 onText。
 * 狀態用 ref 同步保存，讓「剛開始就按停止」或計時器觸發時讀得到最新狀態。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, errorMessage } from '@/api/errors';
import type { UploadFile } from '@/api/types';
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
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deps = useRef({ recorder, transcribe, onText, now });
  deps.current = { recorder, transcribe, onText, now };

  const apply = useCallback((e: VoiceEvent) => {
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
    if (!rec || d.now() - cur.startedAt < MIN_RECORDING_MS) {
      apply({ type: 'failed', hint: NOT_HEARD });
      return;
    }
    try {
      const { text } = await d.transcribe({ uri: rec.uri, name: 'speech.m4a', type: 'audio/m4a' });
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
    if (!availableRef.current || ref.current.mode !== 'idle') return;
    const d = deps.current;
    if (!(await d.recorder.requestPermission())) {
      apply({ type: 'failed', hint: PERMISSION_HINT });
      return;
    }
    try {
      await d.recorder.start();
    } catch {
      apply({ type: 'failed', hint: '無法開始錄音，請再試一次。' });
      return;
    }
    apply({ type: 'start', at: d.now() });
    timer.current = setTimeout(() => void stop(), MAX_RECORDING_MS);
  }, [apply, stop]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return { state, available, start, stop };
}
