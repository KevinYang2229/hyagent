/**
 * 一次性遷移：把 server/data 的知識庫 JSON 灌進 Postgres。
 *
 * 用法（需 DATA_BACKEND=db 與 DATABASE_URL）：
 *   npm run migrate:knowledge -w server -- --dry-run   # 只列出將遷移的內容
 *   npm run migrate:knowledge -w server                # 實際寫入
 *
 * 可重複執行：saveIndex 為整份取代，重跑同一份檔案結果相同。
 * 遷移的是既有向量，不會重新呼叫 embedding API（不產生費用）。
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { env } from '@/config/env';
import { closeDb, connectDb } from '@/lib/db';
import { saveIndex } from '@/modules/knowledge/knowledge.index.repo';
import { initKnowledgeStore, knowledgeStore } from '@/modules/knowledge/knowledge.store';
import type { KnowledgeIndexFile } from '@/modules/knowledge/knowledge-index.types';
import type { KnowledgeIndexMeta, KnowledgeSource } from '@/modules/knowledge/knowledge.store';

const INDEX_RE = /^knowledge-index\.(.+)\.json$/;

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  if (env.DATA_BACKEND !== 'db') {
    console.error('需要 DATA_BACKEND=db 才能遷移；目前為', env.DATA_BACKEND);
    await closeDb();
    process.exit(1);
  }

  const dir = resolve(process.cwd(), env.KNOWLEDGE_INDEX_DIR);
  if (!existsSync(dir)) {
    console.error('找不到索引目錄：', dir);
    await closeDb();
    process.exit(1);
  }

  // knowledgeStore 的 db 寫入走 DbWriteQueue，enqueue 時若 Prisma client 尚未連線會靜默丟棄任務
  // （見 lib/db.ts 的 enqueue：client 為 undefined 就直接 return，不會排入佇列，closeDb 也沖不到）。
  // 因此必須在下面呼叫 knowledgeStore.saveSource / setMeta 之前，先確保連線已建立；
  // initKnowledgeStore() 內部會呼叫 connectDb()，之後 module-level 的 client 才會就緒。
  await initKnowledgeStore();

  // 先搬設定檔（來源設定 + meta），再搬各租戶索引
  const configPath = resolve(dir, 'knowledge-config.json');
  if (existsSync(configPath)) {
    const raw = JSON.parse(readFileSync(configPath, 'utf8')) as {
      sources: [string, KnowledgeSource][];
      metas: [string, KnowledgeIndexMeta][];
    };
    for (const [tenantId, src] of raw.sources ?? []) {
      console.log(`[設定] ${tenantId} startUrl=${src.startUrl || '(無)'}`);
      // updatedAt 由 saveSource 重新標記；來源內容照搬
      if (!dryRun) knowledgeStore.saveSource(tenantId, src);
    }
    for (const [tenantId, meta] of raw.metas ?? []) {
      console.log(`[meta] ${tenantId} status=${meta.status} chunkCount=${meta.chunkCount}`);
      if (!dryRun) knowledgeStore.setMeta(tenantId, meta);
    }
  } else {
    console.log('（無 knowledge-config.json，略過設定遷移）');
  }

  for (const name of readdirSync(dir)) {
    const m = INDEX_RE.exec(name);
    if (!m) continue;
    const tenantId = m[1];
    const idx = JSON.parse(readFileSync(resolve(dir, name), 'utf8')) as KnowledgeIndexFile;
    const dims = idx.chunks[0]?.vector.length ?? 0;
    console.log(`[索引] ${tenantId}: ${idx.chunks.length} chunks, ${dims} 維, model=${idx.model}`);
    if (dims && dims !== 3072) {
      console.error(`  ✗ 維度 ${dims} 與 knowledge_chunks 的 halfvec(3072) 不符，跳過`);
      continue;
    }
    if (!dryRun) {
      await saveIndex(tenantId, idx);
      console.log('  ✓ 已寫入');
    }
  }

  if (dryRun) {
    console.log('\n--dry-run：未寫入任何資料');
  } else {
    await printReadBackSummary();
  }
  await closeDb();
}

/**
 * 從資料庫回讀並印出摘要——操作者的成功判準不能只是「沒有拋例外」。
 *
 * knowledgeStore.saveSource / setMeta 走 DbWriteQueue.enqueue，其失敗路徑只有
 * logger.warn（見 lib/db.ts），所以上面那些 `[設定] …` / `[meta] …` 不管寫入成功與否
 * 都會照印。（`✓ 已寫入` 例外——它跟在 awaited 的 saveIndex 之後，是可信的。）
 * 回讀是唯一能證明資料真的落地的方式。closeDb() 之前呼叫，此時佇列已沖完。
 */
async function printReadBackSummary(): Promise<void> {
  const db = await connectDb();
  const [{ count: sourceCount }] = await db.$queryRaw<{ count: bigint }[]>`
    select count(*) as count from knowledge_sources
  `;
  const chunkRows = await db.$queryRaw<{ tenant_id: string; count: bigint }[]>`
    select tenant_id, count(*) as count from knowledge_chunks group by 1 order by 1
  `;
  console.log('\n=== 回讀摘要（資料庫實際內容）===');
  console.log(`knowledge_sources: ${sourceCount} 列`);
  if (chunkRows.length === 0) {
    console.log('knowledge_chunks: 空 —— 沒有任何向量寫入，請檢查上面的錯誤訊息');
  } else {
    for (const r of chunkRows) console.log(`knowledge_chunks[${r.tenant_id}]: ${r.count} chunks`);
  }
}

main().catch(async (err) => {
  console.error(err);
  await closeDb();
  process.exit(1);
});
