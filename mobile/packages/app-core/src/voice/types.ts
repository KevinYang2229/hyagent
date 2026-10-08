/** 錄音介面：正式版用 expo-audio（expoRecorder.ts），測試用假的。 */
export interface Recorder {
  /** 即時音量（dB）；未提供代表平台不支援音量偵測。 */
  metering?: number;
  requestPermission(): Promise<boolean>;
  start(): Promise<void>;
  stop(): Promise<{ uri: string } | null>;
}
