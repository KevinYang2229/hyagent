/**
 * 掃條碼／拍照閘門：相機會對同一張條碼連續觸發，只放行第一次。
 * 查詢失敗時 release({ cooldownMs }) 釋放並進入冷卻：冷卻內相同內容不再放行，
 * 內容改變或冷卻結束才可再掃，避免同一條碼停在畫面時反覆查詢、錯誤橫幅閃爍。
 */
export function createScanGate() {
  let busy = false;
  let current: string | undefined;
  let blockedData: string | undefined;
  let blockedUntil = 0;
  return {
    tryAcquire(data?: string, now: number = Date.now()): boolean {
      if (busy) return false;
      if (data !== undefined && data === blockedData && now < blockedUntil) return false;
      busy = true;
      current = data;
      return true;
    },
    release(opts?: { cooldownMs?: number; now?: number }): void {
      busy = false;
      if (opts?.cooldownMs && current !== undefined) {
        blockedData = current;
        blockedUntil = (opts.now ?? Date.now()) + opts.cooldownMs;
      }
    },
  };
}
