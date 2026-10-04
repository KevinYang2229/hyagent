/** 朗讀（裝置內建 TTS，zh-TW）。 */
import * as Speech from 'expo-speech';
import { stripMarkdown } from './markdown';

export function speak(text: string): void {
  const t = stripMarkdown(text);
  if (!t) return;
  void Speech.stop();
  Speech.speak(t, { language: 'zh-TW' });
}

export function stopSpeaking(): void {
  void Speech.stop();
}
