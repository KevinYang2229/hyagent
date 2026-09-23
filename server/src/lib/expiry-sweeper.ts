/**
 * 一次性紀錄的到期回收（Assertion `jti` + HyAgent Session）。
 *
 * 兩者共用同一支排程是決策 B 的核心理由（評估文件 §7.3、§6.2.1）：原本建議把 jti 放
 * Redis，圖的是 `SET NX EX` 的 TTL 語意；但 Session 進 DB 後本來就需要一支 sweep，
 * jti 搭順風車即可，於是那個優勢消失，而少一個正式環境相依與一套維運是實在的。
 *
 * 清理只是**回收空間**，不是安全邊界：兩個 store 的讀取路徑都自行判斷到期
 * （`expires_at > now()` / lazy 過濾），排程掛掉或還沒跑到時，過期紀錄一樣不會被採信。
 * 這個分工要守住——一旦讓「已清掉」變成「已失效」的前提，排程就從維運工作升級成單點故障。
 */
import { authSessionStore } from '@/lib/auth-session.store';
import { logger } from '@/lib/logger';
import { securityClaims } from '@/lib/security-claims';

/**
 * 間隔 5 分鐘。
 *
 * 取自 Assertion 的有效期上限（規格 §4.3 的 300 秒）：jti 紀錄最多活這麼久，
 * 掃得比這更密只是重複掃同一批還沒到期的列。Session 動輒數小時，跟著這個節奏綽綽有餘。
 */
export const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export interface SweepResult {
  claims: number;
  sessions: number;
}

/** 跑一輪回收。任一邊失敗都不影響另一邊——清理是盡力而為。 */
export async function sweepExpired(): Promise<SweepResult> {
  const [claims, sessions] = await Promise.all([
    securityClaims.sweepExpired().catch((err) => {
      logger.warn({ err }, 'security claim sweep failed');
      return 0;
    }),
    authSessionStore.sweepExpired().catch((err) => {
      logger.warn({ err }, 'auth session sweep failed');
      return 0;
    }),
  ]);
  if (claims || sessions) logger.info({ claims, sessions }, 'expired records swept');
  return { claims, sessions };
}

/** 啟動排程；回傳停止函式。`unref()` 讓它不擋關機。 */
export function startExpirySweeper(intervalMs = SWEEP_INTERVAL_MS): () => void {
  const timer = setInterval(() => {
    void sweepExpired();
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
