/**
 * 租戶管理者帳號 store：記憶體 Map ＋ 可切換持久化後端（env.DATA_BACKEND）。
 * db 後端：每帳號一列（data jsonb 整包；username 小寫並加 unique），寫入走 DbWriteQueue。
 * 開機由 initAdminAccountStore() 載回（index.ts 於 listen 前呼叫）。
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import type { Prisma } from '@prisma/client';
import { dataFile } from '@/lib/data-dir';
import { connectDb, DbWriteQueue } from '@/lib/db';
import { env } from '@/config/env';
import { logger } from '@/lib/logger';
import { AppError } from '@/utils/app-error';
import type { AdminAccount } from './admin-account.types';

export { toPublicAccount } from './admin-account.types';
export type { AdminAccount, PublicAdminAccount } from './admin-account.types';

const STORE_FILE = dataFile('oa-agent-admin-accounts.json');

const accounts = new Map<string, AdminAccount>();

const writeQueue = new DbWriteQueue('admin_accounts');

function persistFile(): void {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify([...accounts.values()]));
  } catch (err) {
    logger.warn({ err, file: STORE_FILE }, 'failed to persist admin accounts');
  }
}

function upsertToDb(a: AdminAccount): void {
  const data = JSON.parse(JSON.stringify(a)) as Prisma.InputJsonValue;
  const row = {
    id: a.id,
    tenantId: a.tenantId,
    username: a.username,
    data,
    createdAt: new Date(a.createdAt),
  };
  writeQueue.enqueue(async (db) => {
    await db.adminAccountRow.upsert({ where: { id: row.id }, create: row, update: { data } });
  });
}

function persist(a: AdminAccount): void {
  if (env.DATA_BACKEND === 'db') upsertToDb(a);
  else persistFile();
}

// file 後端：模組載入即同步還原
if (env.DATA_BACKEND !== 'db') {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8')) as AdminAccount[];
      for (const a of raw) accounts.set(a.id, a);
      logger.info({ count: accounts.size }, 'admin accounts restored from disk');
    }
  } catch (err) {
    logger.warn({ err, file: STORE_FILE }, 'failed to restore admin accounts; starting empty');
  }
}

/** db 後端的開機載入；必須在開始服務請求前 await，file 後端為 no-op。 */
export async function initAdminAccountStore(): Promise<void> {
  if (env.DATA_BACKEND !== 'db') return;
  const db = await connectDb();
  const rows = await db.adminAccountRow.findMany();
  for (const r of rows) {
    const a = r.data as unknown as AdminAccount;
    accounts.set(a.id, a);
  }
  logger.info({ count: accounts.size }, 'admin accounts restored from db');
}

export const adminAccountStore = {
  create(input: {
    tenantId: string;
    username: string;
    displayName: string;
    passwordHash: string;
    permissions?: AdminAccount['permissions'];
  }): AdminAccount {
    const username = input.username.toLowerCase();
    if (this.getByUsername(username)) throw AppError.conflict('帳號名稱已被使用');
    const now = new Date().toISOString();
    const account: AdminAccount = {
      id: randomBytes(8).toString('hex'),
      tenantId: input.tenantId,
      username,
      displayName: input.displayName,
      passwordHash: input.passwordHash,
      status: 'active',
      permissions: input.permissions ?? {},
      credentialVersion: 0,
      createdAt: now,
      updatedAt: now,
    };
    accounts.set(account.id, account);
    persist(account);
    return account;
  },

  get(id: string): AdminAccount | undefined {
    return accounts.get(id);
  },

  getByUsername(username: string): AdminAccount | undefined {
    const u = username.toLowerCase();
    for (const a of accounts.values()) if (a.username === u) return a;
    return undefined;
  },

  listByTenant(tenantId: string): AdminAccount[] {
    return [...accounts.values()].filter((a) => a.tenantId === tenantId);
  },

  update(
    id: string,
    patch: Partial<
      Pick<AdminAccount, 'displayName' | 'status' | 'permissions' | 'passwordHash' | 'lastLoginAt'>
    > & { bumpCredential?: boolean },
  ): AdminAccount | undefined {
    const cur = accounts.get(id);
    if (!cur) return undefined;
    const { bumpCredential, ...fields } = patch;
    const next: AdminAccount = { ...cur, updatedAt: new Date().toISOString() };
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) (next as unknown as Record<string, unknown>)[k] = v;
    }
    if (bumpCredential) next.credentialVersion = cur.credentialVersion + 1;
    accounts.set(id, next);
    persist(next);
    return next;
  },

  remove(id: string): boolean {
    if (!accounts.delete(id)) return false;
    if (env.DATA_BACKEND === 'db') {
      writeQueue.enqueue(async (db) => {
        await db.adminAccountRow.deleteMany({ where: { id } });
      });
    } else {
      persistFile();
    }
    return true;
  },

  /** 刪租戶級聯清理：回傳刪除筆數 */
  removeByTenant(tenantId: string): number {
    let n = 0;
    for (const [id, a] of accounts) {
      if (a.tenantId === tenantId) {
        accounts.delete(id);
        n++;
      }
    }
    if (n === 0) return 0;
    if (env.DATA_BACKEND === 'db') {
      writeQueue.enqueue(async (db) => {
        await db.adminAccountRow.deleteMany({ where: { tenantId } });
      });
    } else {
      persistFile();
    }
    return n;
  },

  /** 僅供測試 */
  clear(): void {
    accounts.clear();
    if (env.DATA_BACKEND !== 'db') persistFile();
  },
};
