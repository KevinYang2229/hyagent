/** expo-audio 版錄音器（高品質 m4a）。錄音時切換音訊模式，結束後恢復讓朗讀能播放。 */
import { AudioModule, RecordingPresets, setAudioModeAsync, useAudioRecorder, useAudioRecorderState } from 'expo-audio';
import { useMemo } from 'react';
import type { Recorder } from './types';

export function useExpoRecorder(): Recorder {
  const rec = useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true });
  const status = useAudioRecorderState(rec, 150);
  return useMemo<Recorder>(
    () => ({
      metering: status.isRecording ? status.metering : undefined,
      async requestPermission() {
        const r = await AudioModule.requestRecordingPermissionsAsync();
        return r.granted;
      },
      async start() {
        await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
        try {
          await rec.prepareToRecordAsync();
          rec.record();
        } catch (e) {
          await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => undefined);
          throw e;
        }
      },
      async stop() {
        try {
          await rec.stop();
        } finally {
          await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => undefined);
        }
        return rec.uri ? { uri: rec.uri } : null;
      },
    }),
    [rec, status.isRecording, status.metering],
  );
}
