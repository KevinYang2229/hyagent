/*
 * 資料夾批次匯入 watcher。
 *
 * 執行：npm run watch:knowledge -w server -- --root=<path> [--interval=30] [--once]
 *                                            [--dry-run] [--max-mb=50] [--tenant=<id>]
 *
 * 資料夾結構：<root>/<tenantId>/*.pdf|docx|...，消化成功搬 <root>/<tenantId>/_done/，
 * 永久性失敗搬 _failed/ 並附 .error.txt。
 *
 * 前提：DATA_BACKEND=db 且 DATABASE_URL 指向正式 Supabase，否則寫進本機 JSON、正式環境看不到。
 */
import { env } from '@/config/env';
import { closeDb, connectDb } from '@/lib/db';
import { LocalFolderSource } from '@/modules/knowledge/batch-source';
import {
  createWatchState,
  runFolderIngestRound,
  type RoundOptions,
} from '@/modules/knowledge/folder-ingest.service';
import { loadIndex } from '@/modules/knowledge/knowledge.index.repo';
import { initKnowledgeStore, knowledgeStore } from '@/modules/knowledge/knowledge.store';
import { initTenantStore } from '@/modules/tenant/tenant.store';
import { initUsageStore } from '@/modules/usage/usage.store';

interface Args {
  root: string;
  intervalSec: number;
  once: boolean;
  dryRun: boolean;
  maxMb: number;
  tenant?: string;
}

function parseArgs(argv: string[]): Args {
  const get = (key: string): string | undefined =>
    argv.find((a) => a.startsWith(`--${key}=`))?.split('=').slice(1).join('=');
  const has = (key: string): boolean => argv.includes(`--${key}`);

  const root = get('root');
  if (!root) {
    console.error('缺少 --root=<path>');
    console.error('用法：npm run watch:knowledge -w server -- --root=<path> [--interval=30] [--once] [--dry-run] [--max-mb=50] [--tenant=<id>]');
    process.exit(1);
  }
  return {
    root,
    intervalSec: Number(get('interval') ?? 30),
    once: has('once'),
    dryRun: has('dry-run'),
    maxMb: Number(get('max-mb') ?? 50),
    tenant: get('tenant'),
  };
}

/**
 * 開跑前把「會寫到哪、用哪個模型」攤開來講。
 *
 * 全新租戶的第一次匯入會定型該租戶的 embedding 模型（之後改設定也不會影響既有索引），
 * 所以要特別標示——這是唯一一個事後只能清空重建的決定。
 */
async function printPreflight(tenantIds: string[]): Promise<void> {
  console.log(`DATA_BACKEND=${env.DATA_BACKEND}`);
  if (env.DATA_BACKEND !== 'db') {
    console.warn('⚠️  非 db 模式：索引會寫進本機 server/data/*.json，正式環境看不到。');
  }
  console.warn('⚠️  全站重爬期間請勿執行批次匯入——重爬是整份取代，會抹掉期間新增的檔案 chunks。');

  for (const tenantId of tenantIds) {
    const idx = await loadIndex(tenantId);
    if (idx) {
      console.log(`  ${tenantId}：沿用既有索引，模型 ${idx.model}`);
    } else {
      const model = knowledgeStore.getSource(tenantId).embeddingModel;
      console.log(`  ${tenantId}：★ 將建立新索引，模型 ${model}（一經建立即定型）`);
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (env.DATA_BACKEND === 'db') await connectDb();

  // 【R1 修正】CLI 是獨立進程，不會跑過 src/index.ts 的開機流程。
  //
  // knowledgeStore 由記憶體 Map 支撐（見 knowledge.store.ts 的 sources / metas），只有
  // initKnowledgeStore() 會在 DATA_BACKEND=db 時把 Postgres 內容還原進這兩個 Map；file 後端
  // 則本來就已經是空的 no-op，靠 knowledgeStore 內部自己的檔案還原邏輯。若略過這一步，
  // 在 db 模式下：
  //   - knowledgeStore.getMeta() 回預設空值 → runFolderIngestRound 內的 replaceSameName
  //     同名檔偵測永遠落空 → 重丟改版檔會累積重複 chunks（正是這條批次管線要防的事）
  //   - knowledgeStore.getSource() 回預設值 → chunkChars / embeddingModel 不是該租戶在後台
  //     設定的值 → 違反「批次匯入的 RAG 邏輯與 admin 手動上傳完全一致」的核心承諾
  //   - 之後任何 setMeta 的 write-through 都可能以預設值覆蓋掉 DB 中既有的租戶 meta
  // tenantStore（租戶自帶 LLM 金鑰）與 usageStore（用量歸戶）同樣是記憶體 Map + db 還原的
  // 模式，不 init 就會用預設值/空值運作，一樣是靜默錯誤。因此比照 server 開機順序，在進入
  // 輪詢迴圈之前把這三個 store 初始化好；file 後端下三者皆為 no-op，故無條件呼叫，不特判。
  // conversation / submission / audit / form / scope policy / webhook 等 store 這條批次路徑
  // 用不到，不在此初始化之列。
  await initTenantStore();
  await Promise.all([initUsageStore(), initKnowledgeStore()]);

  const source = new LocalFolderSource(args.root);
  const state = createWatchState();
  const opts: RoundOptions = {
    dryRun: args.dryRun,
    maxBytes: args.maxMb * 1024 * 1024,
    tenantFilter: args.tenant,
  };

  console.log(`監控 ${args.root}（間隔 ${args.intervalSec}s${args.once ? '，單輪' : ''}${args.dryRun ? '，dry-run' : ''}）`);
  const initial = await source.list();
  await printPreflight([...new Set(initial.map((i) => i.tenantId))]);

  // 完成當前檔案後才退出：中途硬殺可能留下「chunks 已寫入但檔案未歸檔」的狀態，
  // 下一輪會重跑該檔（同名檔會先 removeFile，故不會重複），但仍以乾淨收尾為佳。
  let stopping = false;
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      if (stopping) {
        console.log('\n強制退出。');
        process.exit(130);
      }
      stopping = true;
      console.log('\n收到中斷訊號，完成當前輪次後退出（再按一次強制退出）…');
    });
  }

  do {
    const pending = await source.list();
    if (pending.length > 0) {
      const totalMb = pending.reduce((sum, i) => sum + i.size, 0) / 1024 / 1024;
      console.log(`待處理 ${pending.length} 個檔 / 共 ${totalMb.toFixed(1)}MB`);
    }

    const result = await runFolderIngestRound(source, state, opts);
    if (result.done || result.failed || result.retry) {
      console.log(
        `本輪：done ${result.done} / failed ${result.failed} / retry ${result.retry} / skipped ${result.skipped}`,
      );
    }
    if (args.once || stopping) break;
    await new Promise((resolve) => setTimeout(resolve, args.intervalSec * 1000));
  } while (!stopping);

  await closeDb();
  console.log('結束。');
}

main().catch(async (err) => {
  console.error(err);
  await closeDb().catch(() => {});
  process.exit(1);
});
