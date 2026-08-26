/**
 * shadow 階段統計：以 (租戶, 檔案) 累加，資料量等於檔案數而非查詢數。
 *
 * 刻意不用 auditStore：AuditEntry 綁 toolId（語意不符），且 MAX_PER_TENANT=500，
 * 而 shadow 是每次知識庫查詢一筆的高頻寫入——會把真正的工具稽核紀錄整批擠掉。
 *
 * 不記問句全文（可能含個資）；要定位漏標的檔案，file_id 與少量 sample_user_ids 已足夠。
 * 全租戶切至 on 後，本表與三態旗標一起退場。
 */
import { connectDb } from '@/lib/db';
import { env } from '@/config/env';
import { logger } from '@/lib/logger';

export interface ShadowStat {
  fileId: string;
  blockedCount: number;
  sampleUserIds: string[];
  lastBlockedAt: string;
}

const SAMPLE_LIMIT = 5;

/** 旁路性質：記錄失敗不得影響檢索主流程 */
export async function recordShadowBlocks(
  tenantId: string,
  userId: string,
  fileIds: string[],
): Promise<void> {
  if (env.DATA_BACKEND !== 'db' || fileIds.length === 0) return;
  try {
    const db = await connectDb();
    for (const fileId of fileIds) {
      await db.$executeRaw`
        insert into knowledge_acl_shadow (tenant_id, file_id, blocked_count, sample_user_ids, last_blocked_at)
        values (${tenantId}, ${fileId}, 1, array[${userId}]::text[], now())
        on conflict (tenant_id, file_id) do update set
          blocked_count = knowledge_acl_shadow.blocked_count + 1,
          sample_user_ids = (
            select array_agg(u) from (
              select distinct unnest(knowledge_acl_shadow.sample_user_ids || array[${userId}]::text[]) as u
              limit ${SAMPLE_LIMIT}
            ) s
          ),
          last_blocked_at = now()
      `;
    }
  } catch (err) {
    logger.warn({ err, tenantId }, 'shadow 統計寫入失敗（不影響檢索）');
  }
}

export async function listShadowStats(tenantId: string): Promise<ShadowStat[]> {
  if (env.DATA_BACKEND !== 'db') return [];
  const db = await connectDb();
  const rows = await db.$queryRaw<
    { file_id: string; blocked_count: bigint; sample_user_ids: string[] | null; last_blocked_at: Date }[]
  >`
    select file_id, blocked_count, sample_user_ids, last_blocked_at
    from knowledge_acl_shadow where tenant_id = ${tenantId}
    order by blocked_count desc
  `;
  return rows.map((r) => ({
    fileId: r.file_id,
    blockedCount: Number(r.blocked_count),
    sampleUserIds: r.sample_user_ids ?? [],
    lastBlockedAt: r.last_blocked_at.toISOString(),
  }));
}
