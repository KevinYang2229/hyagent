/**
 * HyAgent Session 的伺服器端儲存（規格 §7.1、§2.6、§7.4；評估文件 §6.2.1 定稿）。
 *
 * 規格 §7.1 明文：Session **必須**為伺服器端有狀態儲存，**不得**為 self-contained JWT，
 * 且**必須**記錄建立時驗證通過的 `kid`。後者註明「必須自第一版即納入 schema，事後補建
 * 無法涵蓋既有 Session」——所以這張表從第一天就帶 kid，不是留著以後再加。
 *
 * ## 三處刻意偏離本 repo 既有 store 的寫法
 *
 * 1. **db 模式的讀取路徑不用記憶體 Map**。tenantStore 是「Map + write-through」，
 *    多副本部署下等同無限 TTL 快取：在 A 副本作廢的 Session，B 副本到重啟前都還認得
 *    （評估文件 §6.4）。規格 §2.6 給的上限是 30 秒，所以這裡每次查 DB。
 *    file 模式沿用 Map——單一行程，Map 本身即 primary，沒有副本可落後，天生合規。
 *
 * 2. **不用 securityClaims 那種「一個 key 一個檔」**。那個模式沒有 TTL、檔案數無限增長，
 *    已是現有缺口，不該再複製一份。file 模式改用單一 JSON 快照（與 tenantStore 同款）。
 *
 * 3. **`sub` 不以明文落地**。作廢用的是 HMAC（`subHash`，等值比對足矣）；業務層需要的原文
 *    走靜態加密（`subEnc`，與 `llmConfig` 金鑰同一套 encryptSecret 機制）。file 模式的快照
 *    預設落在 `os.tmpdir()`，明文使用者識別碼不該躺在系統暫存目錄；db 模式一併採用，
 *    降低 DB 外洩的暴露面。正式環境未設 DATA_ENCRYPTION_KEY 時直接拒絕建立 Session。
 *
 * `sessionToken` 本身也不落地，只存 sha256——與 apiKeys 同樣的理由：DB 外洩不該等於
 * 一批可直接使用的有效 Session。
 */
import type { Prisma } from '@prisma/client';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { env } from '@/config/env';
import { decryptSecret, encryptSecret } from '@/lib/crypto';
import { dataFile } from '@/lib/data-dir';
import { connectDb } from '@/lib/db';
import { logger } from '@/lib/logger';

const STORE_FILE = dataFile('oa-agent-auth-sessions.json');

/** 規格 §7.1 的回應範例即以 `hyas_` 起頭；前綴只是辨識用，不帶任何語意。 */
const TOKEN_PREFIX = 'hyas_';

/** 不透明 token 的熵；256 bits，與 API key 同級。 */
const TOKEN_BYTES = 32;

export interface AuthSession {
  /** sha256(sessionToken)。token 原文只在 create() 回傳一次，之後無法自儲存回推。 */
  id: string;
  tenantId: string;
  /** HMAC(sub)，供 §7.4 依 sub 批次作廢的等值比對 */
  subHash: string;
  /**
   * 加密後的 `sub`。用 readSub() 取原文，不要直接讀這個欄位。
   *
   * 它**不只是後台顯示用**：requireAuth 之後的每一支業務 API 都要真實的 `sub`
   * （對話歸屬、表單、知識庫 ACL），所以這個欄位是承載身分的，不能省略。
   * 能提供的保護就是靜態加密——與 `llmConfig` 金鑰同一套機制、同一個
   * dev 便利（未設 DATA_ENCRYPTION_KEY 時原樣存明文）。
   *
   * 正式環境不接受那個 dev 便利：見 assertRestOfEncryptionReady()。
   */
  subEnc: string;
  /** 建立此 Session 時驗證通過的公鑰（規格 §2.6，撤銷該 kid 時連帶作廢） */
  kid: string;
  /** 終端使用者顯示名（Assertion 的 name claim；選填） */
  name?: string;
  /**
   * Assertion 的 `hyagent:profile`，原樣保存（規格 §4.2.3）。
   *
   * 租戶沒在 HyAgent 建人員目錄時，`getApplicant()` 會由它補出部門與職稱，所以這份
   * 資料必須跟著 Session 一起活——Assertion 是一次性的，用完就沒了。
   * 敏感度與 `name` 同級（都是顯示用的組織資訊），比照它不另做加密；真正需要保護的
   * `sub` 走 subEnc。
   */
  profile?: Record<string, unknown>;
  createdAt: string;
  expiresAt: string;
}

/** create() 的回傳：只有這一次拿得到 token 原文。 */
export interface CreatedAuthSession {
  sessionToken: string;
  expiresIn: number;
  session: AuthSession;
}

// ---- 雜湊與加密 ----

function tokenId(sessionToken: string): string {
  return createHash('sha256').update(sessionToken).digest('hex');
}

/**
 * 正式環境不得把使用者識別碼明文落地（評估文件 §6.2.1 b）。
 *
 * encryptSecret() 在未設 DATA_ENCRYPTION_KEY 時原樣回傳明文，那是給 dev 的便利；
 * 但 file 模式的快照預設就落在 `os.tmpdir()`，正式環境照單全收等於把一份使用者清單
 * 放進系統暫存目錄。在建立第一個 Session 時就擋下來，而不是等外洩了才發現。
 */
function assertEncryptionReady(): void {
  if (env.NODE_ENV === 'production' && !env.DATA_ENCRYPTION_KEY) {
    throw new Error(
      '正式環境必須設定 DATA_ENCRYPTION_KEY：HyAgent Session 需要保存終端使用者識別碼，未設金鑰會以明文落地',
    );
  }
}

/** 取回 Session 上的使用者識別碼原文。 */
export function readSub(session: Pick<AuthSession, 'subEnc'>): string {
  return decryptSecret(session.subEnc);
}

/**
 * `sub` 的 HMAC。
 *
 * 綁 tenantId 進來，是為了讓不同租戶的相同 `sub`（例如兩家客戶都用員工編號 `507`）
 * 算出不同的雜湊——否則依 sub 作廢會跨租戶誤殺，而那正是 §7.4 最不該發生的事。
 * 金鑰沿用 JWT_REFRESH_SECRET，但加上用途字串，避免與 credentialVersion 的 HMAC 撞用途。
 */
export function hashSub(tenantId: string, sub: string): string {
  return createHmac('sha256', env.JWT_REFRESH_SECRET)
    .update(`auth-session-sub:${tenantId}:${sub}`)
    .digest('hex');
}

// ---- file 後端：記憶體 Map（即 primary）+ 單一 JSON 快照 ----

const sessions = new Map<string, AuthSession>();

function isExpired(session: AuthSession, nowMs: number): boolean {
  return Date.parse(session.expiresAt) <= nowMs;
}

function persistFile(): void {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify({ sessions: [...sessions.values()] }));
  } catch (err) {
    logger.warn({ err, file: STORE_FILE }, 'failed to persist auth sessions');
  }
}

if (env.DATA_BACKEND !== 'db') {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8')) as { sessions?: AuthSession[] };
      const now = Date.now();
      // 載入時就濾掉過期的：重啟本來就是最自然的清理時機，不必等排程跑第一輪
      for (const s of raw.sessions ?? []) if (!isExpired(s, now)) sessions.set(s.id, s);
      logger.info({ sessions: sessions.size }, 'auth sessions restored from disk');
    }
  } catch (err) {
    logger.warn({ err, file: STORE_FILE }, 'failed to restore auth sessions; starting empty');
  }
}

// ---- db 後端：每次查 DB（見檔頭第 1 點）----

interface AuthSessionDbRow {
  id: string;
  tenantId: string;
  subHash: string;
  subEnc: string;
  kid: string;
  name: string | null;
  profile: unknown;
  createdAt: Date;
  expiresAt: Date;
}

/** jsonb 欄位回來的是任意 JSON；只有「純物件」才當 profile 用，其餘視為沒有。 */
function toProfile(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function fromRow(row: AuthSessionDbRow): AuthSession {
  return {
    id: row.id,
    tenantId: row.tenantId,
    subHash: row.subHash,
    subEnc: row.subEnc,
    kid: row.kid,
    ...(row.name ? { name: row.name } : {}),
    ...(toProfile(row.profile) ? { profile: toProfile(row.profile)! } : {}),
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

export interface CreateAuthSessionInput {
  tenantId: string;
  /** 終端使用者識別（Assertion 的 sub）。只有這裡收得到明文，不會原樣落地。 */
  sub: string;
  kid: string;
  name?: string;
  /** Assertion 的 `hyagent:profile`（規格 §4.2.3）；沒有就不存 */
  profile?: Record<string, unknown>;
  /** 規格 §7.1：租戶的 sessionExpiresIn */
  expiresInSeconds: number;
}

export const authSessionStore = {
  /** 建立 Session；回傳的 sessionToken 僅此一次可取得。 */
  async create({
    tenantId,
    sub,
    kid,
    name,
    profile,
    expiresInSeconds,
  }: CreateAuthSessionInput): Promise<CreatedAuthSession> {
    assertEncryptionReady();
    const sessionToken = TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString('base64url');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + expiresInSeconds * 1000);
    const session: AuthSession = {
      id: tokenId(sessionToken),
      tenantId,
      subHash: hashSub(tenantId, sub),
      subEnc: encryptSecret(sub),
      kid,
      ...(name ? { name } : {}),
      ...(profile && Object.keys(profile).length > 0 ? { profile } : {}),
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };

    if (env.DATA_BACKEND === 'db') {
      const db = await connectDb();
      await db.authSessionRow.create({
        data: {
          id: session.id,
          tenantId,
          subHash: session.subHash,
          subEnc: session.subEnc,
          kid,
          name: name ?? null,
          // jsonb 欄位：沒有 profile 就整個不帶（Prisma 的 JSON null 要用 DbNull，欄位本身可為空）
          ...(session.profile ? { profile: session.profile as Prisma.InputJsonObject } : {}),
          createdAt: now,
          expiresAt,
        },
      });
    } else {
      sessions.set(session.id, session);
      persistFile();
    }
    return { sessionToken, expiresIn: expiresInSeconds, session };
  },

  /**
   * 以 sessionToken 取 Session。過期或不存在一律回 undefined。
   *
   * 每次請求都走這裡、沒有任何快取——規格 §2.6 第 4 條要的就是這個，
   * 而現行 requireAuth 每請求重查租戶的作法本來就滿足它，改造後不能退步。
   */
  async get(sessionToken: string): Promise<AuthSession | undefined> {
    const id = tokenId(sessionToken);
    if (env.DATA_BACKEND === 'db') {
      const db = await connectDb();
      const row = await db.authSessionRow.findFirst({ where: { id, expiresAt: { gt: new Date() } } });
      return row ? fromRow(row) : undefined;
    }
    const session = sessions.get(id);
    if (!session) return undefined;
    // lazy 過濾：排程還沒跑到時，行為必須與已清掉時一致
    if (isExpired(session, Date.now())) {
      sessions.delete(id);
      persistFile();
      return undefined;
    }
    return session;
  },

  /** 主動結束單一 Session（規格 §7.2 `DELETE /v1/sessions/current`、SDK 的 logout()）。 */
  async revoke(sessionToken: string): Promise<boolean> {
    const id = tokenId(sessionToken);
    if (env.DATA_BACKEND === 'db') {
      const db = await connectDb();
      const { count } = await db.authSessionRow.deleteMany({ where: { id } });
      return count > 0;
    }
    const existed = sessions.delete(id);
    if (existed) persistFile();
    return existed;
  },

  /**
   * 依 `kid` 批次作廢（規格 §2.6）：撤銷公鑰時連帶登出以該金鑰建立的所有 Session。
   *
   * 這正是 kid 欄位存在的理由——沒有它，撤銷公鑰只能擋住「之後」的換發，
   * 已經拿到 Session 的人會一路用到自然過期。
   */
  async revokeByKid(tenantId: string, kid: string): Promise<number> {
    if (env.DATA_BACKEND === 'db') {
      const db = await connectDb();
      const { count } = await db.authSessionRow.deleteMany({ where: { tenantId, kid } });
      return count;
    }
    let removed = 0;
    for (const [id, s] of sessions) {
      if (s.tenantId === tenantId && s.kid === kid) {
        sessions.delete(id);
        removed += 1;
      }
    }
    if (removed) persistFile();
    return removed;
  },

  /**
   * 依 `sub` 批次作廢（規格 §7.4）：帳號停權、離職等由伺服器端發起的身分變更。
   *
   * 對「查無有效 Session 的 sub」回 0 而不是丟錯——規格 §7.4 要求冪等且回 200，
   * 否則這支端點就成了「這個帳號現在有沒有人在線」的探測器。
   */
  async revokeBySub(tenantId: string, sub: string): Promise<number> {
    const subHash = hashSub(tenantId, sub);
    if (env.DATA_BACKEND === 'db') {
      const db = await connectDb();
      const { count } = await db.authSessionRow.deleteMany({ where: { tenantId, subHash } });
      return count;
    }
    let removed = 0;
    for (const [id, s] of sessions) {
      if (s.tenantId === tenantId && s.subHash === subHash) {
        sessions.delete(id);
        removed += 1;
      }
    }
    if (removed) persistFile();
    return removed;
  },

  /** 租戶刪除時一併清空。 */
  async revokeByTenant(tenantId: string): Promise<number> {
    if (env.DATA_BACKEND === 'db') {
      const db = await connectDb();
      const { count } = await db.authSessionRow.deleteMany({ where: { tenantId } });
      return count;
    }
    let removed = 0;
    for (const [id, s] of sessions) {
      if (s.tenantId === tenantId) {
        sessions.delete(id);
        removed += 1;
      }
    }
    if (removed) persistFile();
    return removed;
  },

  /** 清掉已過期的紀錄，回傳筆數。由共用的清理排程呼叫（lib/expiry-sweeper.ts）。 */
  async sweepExpired(): Promise<number> {
    if (env.DATA_BACKEND === 'db') {
      const db = await connectDb();
      const { count } = await db.authSessionRow.deleteMany({ where: { expiresAt: { lte: new Date() } } });
      return count;
    }
    const now = Date.now();
    let removed = 0;
    for (const [id, s] of sessions) {
      if (isExpired(s, now)) {
        sessions.delete(id);
        removed += 1;
      }
    }
    if (removed) persistFile();
    return removed;
  },

  /** 測試用：清空 file 模式的記憶體狀態。 */
  __resetForTests(): void {
    sessions.clear();
    persistFile();
  },
};
