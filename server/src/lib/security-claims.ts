/**
 * Atomic, durable claims. Never fail open or expire submission claims automatically.
 *
 * 兩類用途，差別只在有沒有 TTL：
 *   - 無 TTL（`refresh-used:` / `refresh-revoked:` / 送出防重）：永久保存，語意不可過期。
 *   - 有 TTL（Assertion 的 `jti`，規格 §8.5）：保存到該 Assertion 的 `exp` 為止即可。
 *     `exp - iat <= 300`，所以每筆最多活 5 分鐘；沒有 TTL 的話，每 5 分鐘一筆會無限累積，
 *     file 模式更是一個 jti 一個檔案。
 *
 * 原子性是規格 §8.5 的硬要求：若用「先查再寫」兩步驟，並行的重放請求會同時通過檢查。
 * db 模式靠 `INSERT … ON CONFLICT`，file 模式靠 `wx` 旗標開檔，兩者都是單一不可分割的操作。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '@/config/env';
import { dataFile } from './data-dir';
import { connectDb } from './db';
import { logger } from './logger';

function claimsDir(): string {
  const dir = dataFile('oa-agent-security-claims');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function filename(key: string): string {
  return path.join(claimsDir(), createHash('sha256').update(key).digest('hex'));
}

/**
 * file 模式的到期時間就寫在檔案內容裡（epoch 秒，空內容＝永不過期）。
 *
 * 不用 mtime：它會被備份、同步工具與 `cp -p` 之外的複製動作改掉，而這裡的判斷
 * 直接決定一張用過的 Assertion 能不能再用一次——不該依賴檔案系統的旁支屬性。
 */
function readExpiry(file: string): number | null {
  const body = fs.readFileSync(file, 'utf-8').trim();
  if (!body) return null;
  const seconds = Number(body);
  return Number.isFinite(seconds) ? seconds : null;
}

function isExpired(expiresAtSeconds: number | null, nowSeconds: number): boolean {
  return expiresAtSeconds !== null && expiresAtSeconds <= nowSeconds;
}

function writeClaimFile(file: string, expiresAtSeconds?: number): void {
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    if (expiresAtSeconds !== undefined) fs.writeFileSync(fd, String(expiresAtSeconds));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export const securityClaims = {
  /**
   * 第一次宣告回 true；已存在且未過期回 false。
   *
   * @param expiresAtSeconds 省略＝永不過期（既有的 refresh / 送出防重用法，語意不變）。
   *   已過期的紀錄不算佔用——它代表的 Assertion 本來就已過期，攔它沒有意義，
   *   而且會讓「清理排程還沒跑到」變成行為差異。
   */
  async claim(key: string, expiresAtSeconds?: number): Promise<boolean> {
    if (env.DATA_BACKEND === 'db') {
      const db = await connectDb();
      const expiresAt = expiresAtSeconds === undefined ? null : new Date(expiresAtSeconds * 1000);
      // 衝突時只有「既有紀錄已過期」才讓新的蓋過去；未過期則 WHERE 不成立、影響 0 列。
      const count = await db.$executeRaw`
        INSERT INTO security_claims (key, expires_at) VALUES (${key}, ${expiresAt})
        ON CONFLICT (key) DO UPDATE SET expires_at = EXCLUDED.expires_at
        WHERE security_claims.expires_at IS NOT NULL AND security_claims.expires_at <= now()`;
      return count === 1;
    }
    const file = filename(key);
    try {
      writeClaimFile(file, expiresAtSeconds);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (!isExpired(readExpiry(file), Math.floor(Date.now() / 1000))) return false;
      // 過期紀錄：換成新的。單一行程，unlink → create 之間沒有其他寫入者。
      fs.unlinkSync(file);
      writeClaimFile(file, expiresAtSeconds);
      return true;
    }
  },

  async has(key: string): Promise<boolean> {
    if (env.DATA_BACKEND === 'db') {
      const db = await connectDb();
      const rows = await db.$queryRaw<Array<{ key: string }>>`
        SELECT key FROM security_claims
        WHERE key = ${key} AND (expires_at IS NULL OR expires_at > now())`;
      return rows.length > 0;
    }
    const file = filename(key);
    try {
      return !isExpired(readExpiry(file), Math.floor(Date.now() / 1000));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  },

  /**
   * 刪除已過期的紀錄，回傳刪除筆數。由共用的清理排程呼叫（見 lib/expiry-sweeper.ts）。
   *
   * 只碰有 `expires_at` 的列：refresh 與送出防重的紀錄沒有到期時間，語意上永久有效，
   * 清掉它們等於讓一張用過的 refresh token 重新可用。
   */
  async sweepExpired(): Promise<number> {
    if (env.DATA_BACKEND === 'db') {
      const db = await connectDb();
      return db.$executeRaw`
        DELETE FROM security_claims WHERE expires_at IS NOT NULL AND expires_at <= now()`;
    }
    const now = Math.floor(Date.now() / 1000);
    const dir = claimsDir();
    let removed = 0;
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      try {
        if (!isExpired(readExpiry(file), now)) continue;
        fs.unlinkSync(file);
        removed += 1;
      } catch (err) {
        // 併發刪除或讀取失敗：清理是盡力而為，不該讓排程整支掛掉
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          logger.warn({ err, file }, 'failed to sweep security claim');
        }
      }
    }
    return removed;
  },
};
