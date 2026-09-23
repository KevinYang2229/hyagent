/**
 * `jti` 一次性紀錄的正式實作（規格 §8.5 步驟 19–20）。
 *
 * 決策 B（評估文件 §7.3）：放 DB 的 `security_claims`，加 `expires_at`，與 session store
 * 共用一支清理排程，**不引入 Redis**。原本建議 Redis 是為了 `SET NX EX` 的 TTL 語意，
 * 但在已經需要一支 sweep 的前提下那個優勢消失，而少一個正式環境相依與一套維運是實在的。
 *
 * 原子性由 securityClaims 保證（db：`INSERT … ON CONFLICT`；file：`wx` 開檔），
 * 這裡只負責命名空間與時間單位的轉換。
 */
import { securityClaims } from '@/lib/security-claims';
import type { ReplayStore } from './replay-store';

/** 與 `refresh-used:` / `refresh-revoked:` 同一張表，靠前綴分流。 */
const PREFIX = 'assertion-jti:';

export class ClaimReplayStore implements ReplayStore {
  /**
   * @param key              驗證器組成的 `${tenant}:${kid}:${jti}`——含 tenant 與 kid，
   *                         因此不同租戶、不同金鑰的相同 jti 不會互相干擾（規格 §8.5）。
   * @param expiresAtSeconds 取 Assertion 的 `exp`：紀錄只需活到該 Assertion 失效為止。
   */
  async consume(key: string, expiresAtSeconds: number): Promise<boolean> {
    return securityClaims.claim(`${PREFIX}${key}`, expiresAtSeconds);
  }
}

export const claimReplayStore = new ClaimReplayStore();
