/**
 * DATA_BACKEND=db 共用的 Prisma 連線與寫入佇列。
 *
 * - client 延遲載入：file 模式完全不 import @prisma/client（未 generate 也能跑）。
 * - 各 store 一條 DbWriteQueue：寫入依序排隊、失敗只 warn 不影響當前請求（與 file 後端同語意）。
 * - closeDb()：關機前把所有佇列沖完再斷線（index.ts shutdown 用）。
 */
import type { PrismaClient } from '@prisma/client';
import { env } from '@/config/env';
import { logger } from '@/lib/logger';

let client: PrismaClient | undefined;
const queues: DbWriteQueue[] = [];

/**
 * 未指定時套用的連線池上限。
 *
 * Prisma 的預設是「實體核心數 × 2 + 1」——10 核心的開發機就是 21 條，而 Supabase 的
 * session pooler 預設只給 15，**單一個 process 就能把整個 pooler 佔滿**，其他連線一律
 * 收到 `EMAXCONNSESSION: max clients reached`。而且這個上限是全帳號共用的：正式站的
 * server、批次匯入 CLI、臨時腳本全都在搶同一個 15。
 *
 * 取 5 是因為本專案的資料庫工作幾乎都是序列的（各 store 一條 DbWriteQueue、批次匯入
 * 逐檔處理），併發度本來就低；留下的餘裕讓 server 與 CLI 可以並存。真的需要更高的
 * 部署可用 DB_CONNECTION_LIMIT 覆寫，或直接在 DATABASE_URL 帶 ?connection_limit=N。
 */
const DEFAULT_CONNECTION_LIMIT = 5;

/**
 * 補上 connection_limit（URL 已自帶則尊重原值）。
 * 在此處理而非要求每個部署改 .env：漏改的後果是連線耗盡，而症狀（逾時、連不上）
 * 看起來完全不像連線數問題，非常難查。
 */
export function withConnectionLimit(url: string, limit: number): string {
  try {
    const u = new URL(url);
    if (!u.searchParams.has('connection_limit')) {
      u.searchParams.set('connection_limit', String(limit));
    }
    return u.toString();
  } catch {
    return url; // 解析不了就原樣送出，交給 Prisma 自己報錯
  }
}

/** 各 store 的 init 呼叫；重複呼叫回同一個 client */
export async function connectDb(): Promise<PrismaClient> {
  if (!client) {
    const { PrismaClient } = await import('@prisma/client');
    const limit = env.DB_CONNECTION_LIMIT ?? DEFAULT_CONNECTION_LIMIT;
    const url = env.DATABASE_URL ? withConnectionLimit(env.DATABASE_URL, limit) : undefined;
    client = url
      ? new PrismaClient({ datasources: { db: { url } } })
      : new PrismaClient();
  }
  return client;
}

/** 取得已連線的 Prisma client；未連線（file 模式）回 undefined */
export function getDb(): PrismaClient | undefined {
  return client ?? undefined;
}

export class DbWriteQueue {
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly label: string) {
    queues.push(this);
  }

  /** 排入一筆寫入；boot 順序保證 connectDb 已完成，client 未備妥時防禦性略過 */
  enqueue(task: (db: PrismaClient) => Promise<void>): void {
    const db = client;
    if (!db) return;
    this.chain = this.chain
      .then(() => task(db))
      .catch((err) => logger.warn({ err }, `failed to persist ${this.label} to db`));
  }

  flush(): Promise<void> {
    return this.chain;
  }
}

/**
 * 就緒探測：db 模式下對已連線的 client 打一次 `SELECT 1`，確認資料庫可達。
 * file 模式或尚未連線（不需 db）回 true——readiness 端點據此回 200/503。
 */
export async function pingDb(): Promise<boolean> {
  if (!client) return true;
  try {
    await client.$queryRaw`SELECT 1`;
    return true;
  } catch (err) {
    logger.warn({ err }, 'db ping failed');
    return false;
  }
}

/**
 * 沖完所有 store 的排隊寫入（等所有 enqueue 的 task 真正 await 完成）。
 * 呼叫者若要在寫入之後做任何依賴「資料已落地」的動作（例如回讀驗證），
 * 必須先 await 這個函式——enqueue 只是把 task 排進 chain，呼叫端拿不到
 * 那個 Promise，沒有東西會自動幫忙等。
 */
export async function flushDbWrites(): Promise<void> {
  await Promise.all(queues.map((q) => q.flush()));
}

/** 沖完所有 store 的排隊寫入並斷線；file 模式為 no-op */
export async function closeDb(): Promise<void> {
  await flushDbWrites();
  await client?.$disconnect();
  client = undefined;
}
