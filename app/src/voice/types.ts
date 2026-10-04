/** 錄音介面：正式版用 expo-audio（expoRecorder.ts），測試用假的。 */
export interface Recorder {
  requestPermission(): Promise<boolean>;
  start(): Promise<void>;
  stop(): Promise<{ uri: string } | null>;
}
