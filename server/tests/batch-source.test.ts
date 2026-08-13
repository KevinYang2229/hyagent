/** 本機資料夾來源：子資料夾名=tenantId，過濾保留目錄與不支援副檔名，settle 搬檔。 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFolderSource, type PendingItem, DONE_DIR, FAILED_DIR } from '@/modules/knowledge/batch-source';

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
    write(`default/${DONE_DIR}/舊檔.txt`);
    write(`default/${FAILED_DIR}/壞檔.txt`);
    write('default/.DS_Store');
    write('default/圖片.png');
    write(`${DONE_DIR}/不該被當成租戶.txt`);
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
    expect(existsSync(join(root, 'default', DONE_DIR, '規章.txt'))).toBe(true);
  });

  it('settle failed 搬進 _failed 並寫 .error.txt', async () => {
    write('default/壞檔.txt');
    const source = new LocalFolderSource(root);
    const [item] = await source.list();

    await source.settle(item, 'failed', '無可抽取文字（可能為掃描檔或空檔）');

    expect(existsSync(item.ref)).toBe(false);
    expect(existsSync(join(root, 'default', FAILED_DIR, '壞檔.txt'))).toBe(true);
    expect(readFileSync(join(root, 'default', FAILED_DIR, '壞檔.txt.error.txt'), 'utf8')).toContain('掃描檔');
  });

  it('settle 目標已有同名檔時直接覆蓋', async () => {
    write(`default/${DONE_DIR}/規章.txt`, '舊的');
    write('default/規章.txt', '新的');
    const source = new LocalFolderSource(root);
    const [item] = await source.list();

    await source.settle(item, 'done');

    expect(readFileSync(join(root, 'default', DONE_DIR, '規章.txt'), 'utf8')).toBe('新的');
  });
});

describe('LocalFolderSource.list - 錯誤處理', () => {
  afterEach(() => {
    // 恢復權限以便清理暫時目錄
    try {
      chmodSync(join(root, 'no-perm'), 0o700);
    } catch {
      // ignore
    }
  });

  it('root 權限錯誤時拋出（非 ENOENT）', async () => {
    mkdirSync(join(root, 'no-perm'));
    chmodSync(join(root, 'no-perm'), 0o000);
    const source = new LocalFolderSource(join(root, 'no-perm'));

    await expect(source.list()).rejects.toThrow();
  });

  it('租戶層權限錯誤時記錄警告但繼續處理其他租戶', async () => {
    write('good/檔案.txt');
    mkdirSync(join(root, 'bad'));
    chmodSync(join(root, 'bad'), 0o000);

    const source = new LocalFolderSource(root);
    const items = await source.list();

    // 預期 good 租戶的檔案被處理，bad 租戶被略過（沒有拋錯，繼續處理其他租戶）
    expect(byName(items)).toEqual(['good/檔案.txt']);

    // 恢復權限以便清理
    chmodSync(join(root, 'bad'), 0o700);
  });
});
