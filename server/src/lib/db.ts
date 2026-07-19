/**
 * DATA_BACKEND=db 共用的 Prisma 連線與寫入佇列。
 *
 * - client 延遲載入：file 模式完全不 import @prisma/client（未 generate 也能跑）。
 * - 各 store 一條 DbWriteQueue：寫入依序排隊、失敗只 warn 不影響當前請求（與 file 後端同語意）。
 * - closeDb()：關機前把所有佇列沖完再斷線（index.ts shutdown 用）。
 */
import type { PrismaClient } from '@prisma/client';
import { logger } from '@/lib/logger';

let client: PrismaClient | undefined;
const queues: DbWriteQueue[] = [];

/** 各 store 的 init 呼叫；重複呼叫回同一個 client */
export async function connectDb(): Promise<PrismaClient> {
  if (!client) {
    const { PrismaClient } = await import('@prisma/client');
    client = new PrismaClient();
  }
  return client;
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

/** 沖完所有 store 的排隊寫入並斷線；file 模式為 no-op */
export async function closeDb(): Promise<void> {
  await Promise.all(queues.map((q) => q.flush()));
  await client?.$disconnect();
  client = undefined;
}
