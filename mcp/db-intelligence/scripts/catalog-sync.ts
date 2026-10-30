/**
 * 掃描資料來源並更新 Catalog，印出差異（規格書 13）。
 * 用法：DBI_DS_PROJECT_01_URL=postgres://...（MariaDB／MySQL 用 mysql://...） npm run catalog:sync -w mcp/db-intelligence -- ds_project_01
 * 環境變數：DBI_CONFIG（預設 config/demo.json）、DBI_CATALOG_DIR（預設 data）
 */
import { FileCatalogStore } from '../src/catalog/store';
import { syncCatalog } from '../src/catalog/sync';
import { loadConfig } from '../src/config';
import { DataSourceConnections } from '../src/pools';

async function main(): Promise<void> {
  const id = process.argv[2];
  if (!id) throw new Error('用法：catalog:sync <dataSourceId>');
  const config = loadConfig(process.env.DBI_CONFIG ?? 'config/demo.json');
  const ds = config.dataSources.find((d) => d.id === id);
  if (!ds) throw new Error(`設定檔沒有資料來源 ${id}`);

  const store = new FileCatalogStore(process.env.DBI_CATALOG_DIR ?? 'data');
  const connections = new DataSourceConnections(() => [ds], { max: 1 });
  try {
    const discovered = await connections.discover(ds);
    const { catalog, diff } = syncCatalog(await store.load(ds.id), discovered, { dataSourceId: ds.id, tenantId: ds.tenantId });
    if (diff.changed) await store.save(catalog);
    console.log(JSON.stringify(diff, null, 2));
    if (diff.addedColumns.length || diff.changedColumns.length) {
      console.log('新增或變更的欄位預設不可查詢，請以 catalog:review 審核後開放。');
    }
  } finally {
    await connections.closeAll();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
