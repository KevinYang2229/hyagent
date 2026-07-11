/**
 * 租戶表單 Definition store（MVP）：記憶體 Map ＋ 磁碟持久化。
 *
 * 與 tenant.store / conversation.store 同款：放 os.tmpdir() 的 JSON，跨 dev 重啟留得住；
 * 之後接 Prisma FormDefinition 表只要換掉這層，registry / service 介面不變。
 *
 * 此 store 只放「租戶自建／覆寫」的表單；內建共用表單仍由 schemas/ 目錄（base）提供，
 * 解析優先序由 form.registry 決定（租戶覆寫 > base）。
 */
import fs from 'node:fs';
import { dataFile } from '@/lib/data-dir';
import { logger } from '@/lib/logger';
import type { Definition } from './form.types';

const STORE_FILE = dataFile('oa-agent-forms.json');

/** 磁碟形狀：tenantId → (formId → Definition) */
type StoreShape = Record<string, Record<string, Definition>>;

// tenantId → (formId → Definition)
const byTenant = new Map<string, Map<string, Definition>>();

function persist(): void {
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

// 啟動時載入既有資料（壞檔則略過）
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
    persist();
    return def;
  },

  /** 刪除一份定義；回傳是否確有刪除 */
  deleteDefinition(tenantId: string, formId: string): boolean {
    const removed = byTenant.get(tenantId)?.delete(formId) ?? false;
    if (removed) persist();
    return removed;
  },
};
