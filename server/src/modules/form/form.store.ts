/**
 * 租戶表單 Definition store：記憶體 Map ＋ 可切換持久化後端（env.DATA_BACKEND）。
 *
 * - file（預設）：整包 JSON 檔（沿用既有行為）。
 * - db：每份定義一列（tenant_id, form_id）定向 upsert / delete。
 *   開機由 initFormStore() 載回（index.ts 於 listen 前呼叫）。
 *
 * 此 store 只放「租戶自建／覆寫」的表單；內建共用表單仍由 schemas/ 目錄（base）提供，
 * 解析優先序由 form.registry 決定（租戶覆寫 > base）。
 */
import fs from 'node:fs';
import type { Prisma } from '@prisma/client';
import { dataFile } from '@/lib/data-dir';
import { connectDb, DbWriteQueue } from '@/lib/db';
import { env } from '@/config/env';
import { logger } from '@/lib/logger';
import type { Definition } from './form.types';

const STORE_FILE = dataFile('oa-agent-forms.json');

/** 磁碟形狀：tenantId → (formId → Definition) */
type StoreShape = Record<string, Record<string, Definition>>;

// tenantId → (formId → Definition)
const byTenant = new Map<string, Map<string, Definition>>();

const writeQueue = new DbWriteQueue('forms');

function persistFile(): void {
  try {
    const data: StoreShape = {};
    for (const [tenantId, forms] of byTenant) {
      data[tenantId] = Object.fromEntries(forms);
    }
    fs.writeFileSync(STORE_FILE, JSON.stringify(data));
  } catch (err) {
    logger.warn({ err, file: STORE_FILE }, 'failed to persist forms');
  }
}

// file 後端：模組載入即同步還原（沿用既有行為）
if (env.DATA_BACKEND !== 'db') {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8')) as StoreShape;
      for (const [tenantId, forms] of Object.entries(raw ?? {})) {
        byTenant.set(tenantId, new Map(Object.entries(forms)));
      }
      logger.info({ tenants: byTenant.size }, 'tenant forms restored from disk');
    }
  } catch (err) {
    logger.warn({ err, file: STORE_FILE }, 'failed to restore forms; starting empty');
  }
}

/**
 * db 後端的開機載入：連 DB、還原兩層 Map。
 * 必須在開始服務請求前 await（index.ts listen 前）；file 後端為 no-op。
 */
export async function initFormStore(): Promise<void> {
  if (env.DATA_BACKEND !== 'db') return;
  const db = await connectDb();
  const rows = await db.tenantFormRow.findMany();
  for (const r of rows) {
    let forms = byTenant.get(r.tenantId);
    if (!forms) {
      forms = new Map();
      byTenant.set(r.tenantId, forms);
    }
    forms.set(r.formId, r.definition as unknown as Definition);
  }
  logger.info({ tenants: byTenant.size, forms: rows.length }, 'tenant forms restored from db');
}

export const formStore = {
  /** 取得某租戶對某 formId 的覆寫/自建定義；無則 undefined（呼叫端再 fallback base） */
  getOverride(tenantId: string, formId: string): Definition | undefined {
    return byTenant.get(tenantId)?.get(formId);
  },

  /** 列出某租戶所有自建/覆寫定義 */
  listOverrides(tenantId: string): Definition[] {
    return [...(byTenant.get(tenantId)?.values() ?? [])];
  },

  /** 建立或更新一份定義（formId 取自 def.formId） */
  saveDefinition(tenantId: string, def: Definition): Definition {
    let forms = byTenant.get(tenantId);
    if (!forms) {
      forms = new Map();
      byTenant.set(tenantId, forms);
    }
    forms.set(def.formId, def);
    if (env.DATA_BACKEND === 'db') {
      const formId = def.formId;
      // 與 file 後端同語意：undefined 欄位序列化時剔除
      const definition = JSON.parse(JSON.stringify(def)) as Prisma.InputJsonValue;
      writeQueue.enqueue(async (db) => {
        await db.tenantFormRow.upsert({
          where: { tenantId_formId: { tenantId, formId } },
          create: { tenantId, formId, definition },
          update: { definition },
        });
      });
    } else {
      persistFile();
    }
    return def;
  },

  /** 移除某租戶所有自建/覆寫表單（刪租戶級聯清理用） */
  purgeTenant(tenantId: string): void {
    byTenant.delete(tenantId);
    if (env.DATA_BACKEND === 'db') {
      writeQueue.enqueue(async (db) => {
        await db.tenantFormRow.deleteMany({ where: { tenantId } });
      });
      return;
    }
    persistFile();
  },

  /** 刪除一份定義；回傳是否確有刪除 */
  deleteDefinition(tenantId: string, formId: string): boolean {
    const removed = byTenant.get(tenantId)?.delete(formId) ?? false;
    if (removed) {
      if (env.DATA_BACKEND === 'db') {
        writeQueue.enqueue(async (db) => {
          await db.tenantFormRow.deleteMany({ where: { tenantId, formId } });
        });
      } else {
        persistFile();
      }
    }
    return removed;
  },
};
