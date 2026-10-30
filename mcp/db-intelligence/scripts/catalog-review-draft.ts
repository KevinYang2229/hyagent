/**
 * 由已掃描的 Catalog 產生審核檔草稿（先執行 catalog:sync）。
 * 用法：npm run catalog:review-draft -w mcp/db-intelligence -- ds_project_01 > review.json
 * 草稿內容：資料集 pending、欄位不開放、敏感度依名稱猜測、DB 註解標為待確認、依命名推測的關聯 pending。
 */
import { buildReviewDraft } from '../src/catalog/reviewDraft';
import { FileCatalogStore } from '../src/catalog/store';

async function main(): Promise<void> {
  const id = process.argv[2];
  if (!id) throw new Error('用法：catalog:review-draft <dataSourceId>');
  const catalog = await new FileCatalogStore(process.env.DBI_CATALOG_DIR ?? 'data').load(id);
  if (!catalog) throw new Error(`尚未掃描資料來源 ${id}，請先執行 catalog:sync 或在後台按「掃描結構」`);
  const draft = buildReviewDraft(catalog);
  process.stdout.write(`${JSON.stringify(draft, null, 2)}\n`);
  const cols = draft.datasets!.reduce((n, d) => n + Object.keys(d.columns ?? {}).length, 0);
  console.error(`已產生草稿：${draft.datasets!.length} 個資料集、${cols} 個欄位、推測關聯 ${draft.addRelationships!.length} 條。`);
  console.error('請完成：核准要開放的資料集與欄位、確認敏感度、補業務描述並刪除「【待確認】」、核准正確的關聯，再以 catalog:review 套用。');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
