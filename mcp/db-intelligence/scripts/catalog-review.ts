/**
 * 套用管理員審核檔（核准資料集、開放欄位、定義指標、發布）。
 * 用法：npm run catalog:review -w mcp/db-intelligence -- ds_project_01 config/demo-review.json
 */
import { readFileSync } from 'node:fs';
import { applyCatalogReview } from '../src/catalog/review';
import { FileCatalogStore } from '../src/catalog/store';

async function main(): Promise<void> {
  const [id, file] = process.argv.slice(2);
  if (!id || !file) throw new Error('用法：catalog:review <dataSourceId> <review.json>');
  const store = new FileCatalogStore(process.env.DBI_CATALOG_DIR ?? 'data');
  const catalog = await store.load(id);
  if (!catalog) throw new Error(`尚未掃描資料來源 ${id}，請先執行 catalog:sync`);
  const next = applyCatalogReview(catalog, JSON.parse(readFileSync(file, 'utf8')));
  await store.save(next);
  console.log(`Catalog ${id} 已更新為 v${next.version}（${next.published ? '已發布' : '未發布'}）`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
