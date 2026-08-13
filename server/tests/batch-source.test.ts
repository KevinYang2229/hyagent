/** 本機資料夾來源：子資料夾名=tenantId，過濾保留目錄與不支援副檔名，settle 搬檔。 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFolderSource, type PendingItem } from '@/modules/knowledge/batch-source';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'batch-source-'));
});

function write(rel: string, content = '內容'): string {
  const path = join(root, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf8');
  return path;
}

function byName(items: PendingItem[]): string[] {
  return items.map((i) => `${i.tenantId}/${i.name}`).sort();
}

describe('LocalFolderSource.list', () => {
  it('子資料夾名成為 tenantId，收支援的副檔名', async () => {
    write('default/規章.txt');
    write('default/手冊.docx');
    write('acme/辦法.pdf');

    const items = await new LocalFolderSource(root).list();
    expect(byName(items)).toEqual(['acme/辦法.pdf', 'default/手冊.docx', 'default/規章.txt']);
  });

  it('忽略 _done / _failed / 點開頭 / 不支援副檔名', async () => {
    write('default/規章.txt');
    write('default/_done/舊檔.txt');
    write('default/_failed/壞檔.txt');
    write('default/.DS_Store');
    write('default/圖片.png');
    write('_done/不該被當成租戶.txt');
    write('.hidden/也不該.txt');

    const items = await new LocalFolderSource(root).list();
    expect(byName(items)).toEqual(['default/規章.txt']);
  });

  it('不遞迴進租戶資料夾底下的子目錄', async () => {
    write('default/規章.txt');
    write('default/子目錄/深層.txt');

    const items = await new LocalFolderSource(root).list();
    expect(byName(items)).toEqual(['default/規章.txt']);
  });

  it('回報 size 與 mtimeMs', async () => {
    write('default/規章.txt', '一二三');
    const [item] = await new LocalFolderSource(root).list();
    expect(item.size).toBeGreaterThan(0);
    expect(typeof item.mtimeMs).toBe('number');
  });

  it('root 不存在時回空陣列而非拋錯', async () => {
    const items = await new LocalFolderSource(join(root, '不存在')).list();
    expect(items).toEqual([]);
  });
});

describe('LocalFolderSource.read / settle', () => {
  it('read 讀回檔案內容', async () => {
    write('default/規章.txt', '特休規定');
    const source = new LocalFolderSource(root);
    const [item] = await source.list();
    await expect(source.read(item)).resolves.toEqual(Buffer.from('特休規定', 'utf8'));
  });

  it('settle done 把檔案搬進 _done，原位置消失', async () => {
    write('default/規章.txt');
    const source = new LocalFolderSource(root);
    const [item] = await source.list();

    await source.settle(item, 'done');

    expect(existsSync(item.ref)).toBe(false);
    expect(existsSync(join(root, 'default/_done/規章.txt'))).toBe(true);
  });

  it('settle failed 搬進 _failed 並寫 .error.txt', async () => {
    write('default/壞檔.txt');
    const source = new LocalFolderSource(root);
    const [item] = await source.list();

    await source.settle(item, 'failed', '無可抽取文字（可能為掃描檔或空檔）');

    expect(existsSync(item.ref)).toBe(false);
    expect(existsSync(join(root, 'default/_failed/壞檔.txt'))).toBe(true);
    expect(readFileSync(join(root, 'default/_failed/壞檔.txt.error.txt'), 'utf8')).toContain('掃描檔');
  });

  it('settle 目標已有同名檔時直接覆蓋', async () => {
    write('default/_done/規章.txt', '舊的');
    write('default/規章.txt', '新的');
    const source = new LocalFolderSource(root);
    const [item] = await source.list();

    await source.settle(item, 'done');

    expect(readFileSync(join(root, 'default/_done/規章.txt'), 'utf8')).toBe('新的');
  });
});
