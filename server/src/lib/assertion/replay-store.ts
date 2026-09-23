/**
 * jti 一次性紀錄（防重放）。
 *
 * 對應規格：§8.5 重放防護（步驟 19–20）。
 * 移植自參考實作 `HyAgentSDK(js)/src/hyagent-verifier.mjs` 的 MemoryReplayStore。
 *
 * 規格要求寫入必須**具原子性**：若用「先查再寫」兩步驟，並行的重放請求會同時通過檢查。
 * 本 repo 既有的 `lib/security-claims.ts` 已經是原子 claim（db 模式
 * `INSERT … ON CONFLICT DO NOTHING`、file 模式以 wx 旗標開檔），缺的只有 TTL——
 * jti 每 5 分鐘一筆會無限累積。正式實作見評估文件決策 B：
 * `security_claims` 加 `expires_at`，與 session store 共用一支清理排程，不引入 Redis。
 *
 * 這裡先定義介面與記憶體實作，供驗證器與測試使用；DB 實作屬 jti 防重放的工作項。
 */

export interface ReplayStore {
  /**
   * 第一次使用回 true；重複使用回 false。
   *
   * @param key              一次性鍵值，由驗證器組成 `${tenant}:${kid}:${jti}`
   * @param expiresAtSeconds 紀錄可被清除的時間點，取 Assertion 的 exp
   * @param nowSeconds       目前時間，由驗證器傳入以與驗章使用同一個時鐘
   */
  consume(key: string, expiresAtSeconds: number, nowSeconds: number): Promise<boolean>;
}

/**
 * 記憶體實作，僅適用單一行程。
 *
 * 清理過期紀錄刻意使用呼叫端傳入的 nowSeconds 而非 Date.now()：
 * 兩者不一致時，注入測試時鐘的重放測試會出現偽陰性。
 */
export class MemoryReplayStore implements ReplayStore {
  private readonly seen = new Map<string, number>();

  async consume(
    key: string,
    expiresAtSeconds: number,
    nowSeconds: number = Math.floor(Date.now() / 1000),
  ): Promise<boolean> {
    for (const [seenKey, expiresAt] of this.seen) {
      if (expiresAt <= nowSeconds) this.seen.delete(seenKey);
    }
    if (this.seen.has(key)) return false;
    this.seen.set(key, expiresAtSeconds);
    return true;
  }
}
