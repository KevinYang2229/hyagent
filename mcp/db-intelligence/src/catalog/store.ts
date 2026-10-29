/**
 * Catalog 儲存：MVP 先以檔案保存（每個資料來源一份目前版本 + 各版本歷史），介面讓之後換成 DB 實作。
 * 讀取時一律以 zod 重驗，檔案被手動改壞也不會帶著錯誤結構進到查詢流程。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { catalogSchema, type Catalog } from '../contracts/catalog';

export interface CatalogStore {
  load(dataSourceId: string): Promise<Catalog | undefined>;
  save(catalog: Catalog): Promise<void>;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

function checkId(id: string): string {
  if (!SAFE_ID.test(id)) throw new Error(`不合法的資料來源 ID：${id}`);
  return id;
}

export class FileCatalogStore implements CatalogStore {
  constructor(private readonly dir: string) {}

  private file(id: string, version?: number): string {
    return path.join(this.dir, version === undefined ? `catalog.${checkId(id)}.json` : `catalog.${checkId(id)}.v${version}.json`);
  }

  async load(dataSourceId: string): Promise<Catalog | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.file(dataSourceId), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
    return catalogSchema.parse(JSON.parse(raw));
  }

  async save(catalog: Catalog): Promise<void> {
    const valid = catalogSchema.parse(catalog);
    await mkdir(this.dir, { recursive: true });
    const body = `${JSON.stringify(valid, null, 2)}\n`;
    await writeFile(this.file(valid.dataSourceId, valid.version), body);
    const tmp = `${this.file(valid.dataSourceId)}.tmp`;
    await writeFile(tmp, body);
    await rename(tmp, this.file(valid.dataSourceId));
  }
}

export class MemoryCatalogStore implements CatalogStore {
  private readonly items = new Map<string, Catalog>();

  async load(dataSourceId: string): Promise<Catalog | undefined> {
    const c = this.items.get(dataSourceId);
    return c && structuredClone(c);
  }

  async save(catalog: Catalog): Promise<void> {
    this.items.set(catalog.dataSourceId, structuredClone(catalogSchema.parse(catalog)));
  }
}
