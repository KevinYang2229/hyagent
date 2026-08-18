/*
 * 索引對帳 CLI。
 *
 * 執行：npm run reconcile:knowledge -w server -- [--tenant=<id>] [--fix]
 *
 * 預設**只報告不動資料**。加 --fix 才會刪除孤兒 chunks，而且只刪報告上列出的那幾筆
 * （幽靈租戶與反向缺漏一律不自動處理，理由見 knowledge.reconcile 的模組註解）。
 *
 * 前提：DATA_BACKEND=db 且 DATABASE_URL 指向要對帳的資料庫。
 */
import { env } from "@/config/env";
import { closeDb, connectDb } from "@/lib/db";
import {
  deleteOrphanChunks,
  scanIndexDrift,
} from "@/modules/knowledge/knowledge.reconcile";

const USAGE =
  "用法：npm run reconcile:knowledge -w server -- [--tenant=<id>] [--fix]";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const tenant = argv
    .find((a) => a.startsWith("--tenant="))
    ?.split("=")
    .slice(1)
    .join("=");
  const fix = argv.includes("--fix");

  if (argv.some((a) => a === "--help" || a === "-h")) {
    console.log(USAGE);
    return;
  }

  console.log(`DATA_BACKEND=${env.DATA_BACKEND}`);
  if (env.DATA_BACKEND !== "db") {
    console.error("⚠️  對帳僅適用於 DATA_BACKEND=db。");
    process.exit(1);
  }
  await connectDb();

  const { orphans, phantoms, missing } = await scanIndexDrift(tenant);
  const scope = tenant ? `租戶 ${tenant}` : "全部租戶";
  console.log(`對帳範圍：${scope}${fix ? "" : "（唯讀，加 --fix 才會刪除）"}\n`);

  console.log(`■ 孤兒 chunks：${orphans.length} 筆檔案`);
  if (orphans.length > 0) {
    console.table(orphans);
    console.log(
      `  合計 ${orphans.reduce((n, o) => n + o.chunks, 0)} 列。這些列檢索撈得到，但後台看不到也刪不掉。`,
    );
  }

  console.log(`\n■ 幽靈租戶：${phantoms.length} 個`);
  if (phantoms.length > 0) {
    console.table(phantoms);
    console.log(
      "  tenants 表查無此 id。embedding 已付費，正確處置多半是搬去真正的租戶而非刪除，故不自動處理。",
    );
  }

  console.log(`\n■ 反向缺漏（meta 有登記、資料庫無 chunks）：${missing.length} 筆`);
  if (missing.length > 0) {
    console.table(missing);
    console.log("  這是 meta 的問題，刪 chunks 解決不了，需人工確認。");
  }

  if (!fix) {
    if (orphans.length > 0) console.log("\n加上 --fix 可刪除上列孤兒 chunks。");
    else console.log("\n沒有需要處理的孤兒資料。");
  } else if (orphans.length === 0) {
    console.log("\n--fix：沒有孤兒 chunks，未執行任何刪除。");
  } else {
    const deleted = await deleteOrphanChunks(orphans);
    console.log(`\n--fix：已刪除 ${deleted} 列孤兒 chunks。`);
  }

  await closeDb();
}

main().catch(async (err) => {
  console.error(err);
  await closeDb().catch(() => {});
  process.exit(1);
});
