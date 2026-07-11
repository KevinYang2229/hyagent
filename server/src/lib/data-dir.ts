/**
 * 持久化檔案位置的唯一決定點。
 *
 * 預設 os.tmpdir()（沿用既有行為）；設 OA_AGENT_DATA_DIR 可整批改位。
 * 測試（tests/setup-env.ts）為每個 jest worker 建獨立暫存目錄——
 * 否則測試與 dev server 共寫同一批檔，跑一次測試就污染 dev 資料
 * （曾實際發生：測試整包覆寫 default 租戶授予、灌入上百個測試租戶）。
 */
import os from 'node:os';
import path from 'node:path';

export function dataFile(name: string): string {
  return path.join(process.env.OA_AGENT_DATA_DIR ?? os.tmpdir(), name);
}
