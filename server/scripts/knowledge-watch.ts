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
import { env } from "@/config/env";
import { closeDb, connectDb } from "@/lib/db";
import { LocalFolderSource } from "@/modules/knowledge/batch-source";
import {
  createWatchState,
  runFolderIngestRound,
  type RoundOptions,
} from "@/modules/knowledge/folder-ingest.service";
import { loadIndexMeta } from "@/modules/knowledge/knowledge.index.repo";
import {
  initKnowledgeStore,
  knowledgeStore,
} from "@/modules/knowledge/knowledge.store";
import { initTenantStore, tenantStore } from "@/modules/tenant/tenant.store";
import { initUsageStore } from "@/modules/usage/usage.store";

interface Args {
  root: string;
  intervalSec: number;
  once: boolean;
  dryRun: boolean;
  maxMb: number;
  tenant?: string;
}

const USAGE =
  "用法：npm run watch:knowledge -w server -- --root=<path> [--interval=30] [--once] [--dry-run] [--max-mb=50] [--tenant=<id>]";

function fail(message: string): never {
  console.error(message);
  console.error(USAGE);
  process.exit(1);
}

function parseArgs(argv: string[]): Args {
  const get = (key: string): string | undefined =>
    argv
      .find((a) => a.startsWith(`--${key}=`))
      ?.split("=")
      .slice(1)
      .join("=");
  const has = (key: string): boolean => argv.includes(`--${key}`);

  const root = get("root");
  if (!root) fail("缺少 --root=<path>");

  // 【R9 修正】Number(...) 對不合法輸入回 NaN，若不驗證會安靜地做錯事而非大聲失敗：
  //   --interval=abc → setTimeout(fn, NaN*1000) 會被 Node 夾成約 1ms，輪詢迴圈變成
  //     瘋狂空轉的 busy loop；
  //   --max-mb=abc → maxBytes 為 NaN，而 JS 的 `item.size > NaN` 恆為 false，等於
  //     大小上限這道安全閘直接失效、巨檔照樣送進 embedding API，成本直接反映在帳單上。
  // 用 Number.isFinite（而非 !Number.isNaN）驗證，順便擋掉 Infinity。
  const intervalRaw = get("interval") ?? "30";
  const intervalSec = Number(intervalRaw);
  if (!Number.isFinite(intervalSec) || intervalSec <= 0) {
    fail(`--interval 必須是大於 0 的數字，收到：${intervalRaw}`);
  }

  const maxMbRaw = get("max-mb") ?? "50";
  const maxMb = Number(maxMbRaw);
  // 0 代表「拒絕所有檔案」，是合法且有用的語意（例如不想真的呼叫付費 API 時拿來驗證用）
  if (!Number.isFinite(maxMb) || maxMb < 0) {
    fail(`--max-mb 必須是 >= 0 的數字，收到：${maxMbRaw}`);
  }

  return {
    root,
    intervalSec,
    once: has("once"),
    dryRun: has("dry-run"),
    maxMb,
    tenant: get("tenant"),
  };
}

/**
 * 開跑前把「會寫到哪、用哪個模型」攤開來講。
 *
 * 全新租戶的第一次匯入會定型該租戶的 embedding 模型（之後改設定也不會影響既有索引），
 * 所以要特別標示——這是唯一一個事後只能清空重建的決定。
 *
 * 每個資料夾同時印出它對應到的租戶名稱：資料夾名就是 tenantId，而「拿租戶名稱當資料夾名」
 * 是最容易犯也最難自己發現的錯（匯入會成功、錢會付掉，但那份索引沒有任何人讀得到）。
 * 對得上名稱才代表資料夾名沒寫錯。
 */
async function printPreflight(tenantIds: string[]): Promise<void> {
  console.log(`DATA_BACKEND=${env.DATA_BACKEND}`);
  if (env.DATA_BACKEND !== "db") {
    console.warn(
      "⚠️  非 db 模式：索引會寫進本機 server/data/*.json，正式環境看不到。",
    );
  }
  console.warn(
    "⚠️  網站正在重新爬取資料時，請不要同時批次匯入文件，否則這段期間匯入的內容可能會被清除。",
  );

  for (const tenantId of tenantIds) {
    const tenant = tenantStore.getTenant(tenantId);
    if (!tenant) {
      console.warn(
        `  ⚠️  ${tenantId}：查無此租戶，該資料夾的檔案會全部判為失敗並搬進 _failed/。\n` +
          `      資料夾名必須是租戶 id，不是租戶名稱。目前可用的租戶：\n` +
          tenantStore
            .listTenants()
            .map((t) => `        ${t.id}  （${t.name}）`)
            .join("\n"),
      );
      continue;
    }
    // loadIndexMeta：這裡只要印出 model，不需要（也不該）把整份向量撈回來
    const idx = await loadIndexMeta(tenantId);
    if (idx) {
      console.log(
        `  ${tenantId}（${tenant.name}）：沿用既有索引，模型 ${idx.model}`,
      );
    } else {
      const model = knowledgeStore.getSource(tenantId).embeddingModel;
      console.log(
        `  ${tenantId}（${tenant.name}）：★ 將建立新索引，模型 ${model}（一經建立即定型）`,
      );
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (env.DATA_BACKEND === "db") await connectDb();

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

  console.log(
    `監控 ${args.root}（間隔 ${args.intervalSec}s${args.once ? "，單輪" : ""}${args.dryRun ? "，dry-run" : ""}）`,
  );
  const initial = await source.list();
  await printPreflight([...new Set(initial.map((i) => i.tenantId))]);

  // 完成當前檔案後才退出：中途硬殺可能留下「chunks 已寫入但檔案未歸檔」的狀態，
  // 下一輪會重跑該檔（同名檔會先 removeFile，故不會重複），但仍以乾淨收尾為佳。
  let stopping = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      if (stopping) {
        console.log("\n強制退出。");
        process.exit(130);
      }
      stopping = true;
      console.log("\n收到中斷訊號，完成當前輪次後退出（再按一次強制退出）…");
    });
  }

  /** 掃描待處理清單 + 跑一輪 + 印出結果；連續模式與 --once 的第二輪共用同一份報告邏輯 */
  const runReportedRound = async (): Promise<void> => {
    const pending = await source.list();
    if (pending.length > 0) {
      const totalMb = pending.reduce((sum, i) => sum + i.size, 0) / 1024 / 1024;
      console.log(`待處理 ${pending.length} 個檔 / 共 ${totalMb.toFixed(1)}MB`);
    }

    const result = await runFolderIngestRound(source, state, opts);
    if (result.done || result.failed || result.retry || result.locked) {
      console.log(
        `本輪：done ${result.done} / failed ${result.failed} / retry ${result.retry}` +
          ` / skipped ${result.skipped} / locked ${result.locked}`,
      );
    }
    if (result.locked > 0) {
      console.warn(
        `⚠️  有 ${result.locked} 個檔因該租戶正被另一條匯入流程處理而略過。` +
          "同時跑兩支 watcher 會讓同一份資料被匯入兩次、embedding 付兩次錢，請確認只留一支。",
      );
    }
  };

  if (args.once) {
    // 【R8 修正】--once 必須在單次呼叫內自行完成兩輪，否則永遠不會匯入任何檔案。
    //
    // WatchState（上面的 state）只存在於這個 process 的記憶體裡，從不落地；而穩定性判定
    // （selectStable，見 folder-ingest.service.ts）要求同一個 state 連續兩輪看到相同的
    // (size, mtime) 才會把檔案視為「寫完」。若 --once 只跑一輪，那一輪必然是每個檔案第一次
    // 被觀測到，state 裡沒有上一輪的指紋可比對，結果永遠是 skipped、永遠不會處理任何檔案——
    // 這不是「要跑兩次指令」的問題，跨 process 重跑一樣是全新的空 state，一樣看不到任何東西
    // （這正是先前手動驗證時，同一個 --once 指令連跑四次結果都相同的原因）。連帶地，若把
    // --once 掛到 cron 上，每次呼叫都是新 process，也一樣永遠不會匯入。
    //
    // 因此這裡改為：第一輪只用來建立指紋（掃描 + selectStable 記錄 seen，不會有任何檔案
    // 通過穩定性判定，故不列印統計避免使用者誤讀成「done 0＝失敗」），等待 --interval 秒
    // 讓寫入未完成的檔案有機會穩定下來，再跑第二輪——此時第一輪記錄的指紋就派得上用場，
    // 真正符合條件的檔案才會被處理。兩輪共用同一個 state 與 opts（含 dryRun），
    // 所以 --dry-run --once 也會照樣走兩輪，第二輪才列得出 [dry-run] 將匯入。
    console.log(
      `第一輪掃描：僅記錄檔案指紋，等待 ${args.intervalSec}s 確認寫入已穩定…`,
    );
    await runFolderIngestRound(source, state, opts);
    if (!stopping) {
      await new Promise((resolve) =>
        setTimeout(resolve, args.intervalSec * 1000),
      );
    }
    if (!stopping) await runReportedRound();
  } else {
    do {
      await runReportedRound();
      if (stopping) break;
      await new Promise((resolve) =>
        setTimeout(resolve, args.intervalSec * 1000),
      );
    } while (!stopping);
  }

  await closeDb();
  console.log("結束。");
}

main().catch(async (err) => {
  console.error(err);
  await closeDb().catch(() => {});
  process.exit(1);
});
