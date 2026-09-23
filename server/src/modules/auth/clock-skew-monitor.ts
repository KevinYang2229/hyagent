/**
 * 時鐘偏移的觀測（規格 §10.4，規範性）。
 *
 * 規格要求三件事：每次驗證記錄觀測到的偏移量、偏移絕對值超過容忍值**一半**時告警、
 * 後台**應該**呈現各租戶近期的偏移分佈。
 *
 * 為什麼值得做：clock skew 造成的失敗是整合期最難診斷的一類客訴——客戶看到的是
 * 「有時候登入不了」，而原因在他們機器的 NTP 上。有偏移數字就能一句話結案；沒有就只能猜。
 * 告警閾值取容忍值一半，是為了在真的開始失敗**之前**就看得到趨勢。
 *
 * 只記錄數值。規格 §10.1 與 §11.1 都要求日誌不得含 Assertion 原文、金鑰內容或 claims 值，
 * 所以這裡連 `sub` 都不碰——偏移量是純量，本身不識別任何人。
 */
import { logger } from '@/lib/logger';

/** 每個租戶保留的最近樣本數。夠畫出分佈，又不至於在長跑的行程裡積成負擔。 */
const MAX_SAMPLES_PER_TENANT = 200;

export interface ClockOffsetSample {
  /** `now - iat`，秒。正值＝客戶時鐘落後我方；負值＝客戶時鐘超前 */
  offsetSeconds: number;
  at: number;
}

export interface ClockOffsetStats {
  count: number;
  min: number;
  max: number;
  /** 中位數；用它而非平均，單一台時鐘壞掉的機器不會把整體指標拉歪 */
  median: number;
  /** 超過容忍值一半的樣本數 */
  warnCount: number;
}

const samples = new Map<string, ClockOffsetSample[]>();

/**
 * 記錄一次驗證觀測到的偏移，必要時告警。
 *
 * @param toleranceSeconds 該租戶的 clockSkewSeconds。為 0 時不告警——
 *   容忍值 0 代表「任何偏移都直接失敗」，告警沒有提前預警的價值，失敗本身就是訊號。
 */
export function recordClockOffset(
  tenantId: string,
  offsetSeconds: number,
  toleranceSeconds: number,
): void {
  const list = samples.get(tenantId) ?? [];
  list.push({ offsetSeconds, at: Date.now() });
  if (list.length > MAX_SAMPLES_PER_TENANT) list.splice(0, list.length - MAX_SAMPLES_PER_TENANT);
  samples.set(tenantId, list);

  if (toleranceSeconds > 0 && Math.abs(offsetSeconds) > toleranceSeconds / 2) {
    logger.warn(
      { tenantId, offsetSeconds, toleranceSeconds },
      'assertion clock offset exceeds half of tolerance; check NTP on both sides',
    );
  }
}

/** 後台的分佈呈現用（規格 §10.4、§11.1）。無樣本回 undefined。 */
export function clockOffsetStats(
  tenantId: string,
  toleranceSeconds: number,
): ClockOffsetStats | undefined {
  const list = samples.get(tenantId);
  if (!list?.length) return undefined;
  const sorted = list.map((s) => s.offsetSeconds).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    median: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
    warnCount:
      toleranceSeconds > 0
        ? sorted.filter((o) => Math.abs(o) > toleranceSeconds / 2).length
        : 0,
  };
}

/** 測試用。 */
export function __resetClockOffsets(): void {
  samples.clear();
}
