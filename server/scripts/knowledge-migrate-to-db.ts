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
import { closeDb } from '@/lib/db';
import { saveIndex } from '@/modules/knowledge/knowledge.index.repo';
import { knowledgeStore } from '@/modules/knowledge/knowledge.store';
import type { KnowledgeIndexFile } from '@/modules/knowledge/knowledge-index.types';
import type { KnowledgeIndexMeta, KnowledgeSource } from '@/modules/knowledge/knowledge.store';

const INDEX_RE = /^knowledge-index\.(.+)\.json$/;

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  if (env.DATA_BACKEND !== 'db') {
    console.error('需要 DATA_BACKEND=db 才能遷移；目前為', env.DATA_BACKEND);
    process.exit(1);
  }

  const dir = resolve(process.cwd(), env.KNOWLEDGE_INDEX_DIR);
  if (!existsSync(dir)) {
    console.error('找不到索引目錄：', dir);
    process.exit(1);
  }

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

  if (dryRun) console.log('\n--dry-run：未寫入任何資料');
  await closeDb();
}

main().catch(async (err) => {
  console.error(err);
  await closeDb();
  process.exit(1);
});
