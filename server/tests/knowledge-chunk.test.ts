/** 檔案來源切塊：保留段落邊界（normalizeDocText）＋依標題分節並帶章節路徑（chunkMarkdown）。 */
import {
  chunkMarkdown,
  chunkText,
  normalizeDocText,
  squash,
} from '@/modules/knowledge/ingest.service';

describe('normalizeDocText', () => {
  it('壓水平空白但保留換行——squash 會把 \\n 一起壓掉，切塊就再也切不到段落邊界', () => {
    const raw = '第一段   內容\r\n第二段\t內容';
    expect(normalizeDocText(raw)).toBe('第一段 內容\n第二段 內容');
    expect(squash(raw)).toBe('第一段 內容 第二段 內容'); // 對照：舊行為
  });

  it('段落之間最多留一個空行，行首行尾空白清掉', () => {
    expect(normalizeDocText('一\n\n\n\n二\n   三   \n')).toBe('一\n\n二\n三');
  });

  it('Markdown 標題行不被併進前一段', () => {
    expect(normalizeDocText('內文結束。\n## 下一節\n新內容')).toContain('\n## 下一節\n');
  });
});

describe('chunkText overlap', () => {
  const text = '第一句話內容。'.repeat(60);

  it('預設不重疊（網站爬取沿用既有行為）', () => {
    const chunks = chunkText(text, 100);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('').length).toBeLessThanOrEqual(text.length);
  });

  it('overlap > 0 時後一塊開頭承接前一塊結尾，答案不會剛好被切在邊界上', () => {
    const chunks = chunkText(text, 100, 20);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[1].startsWith(chunks[0].slice(-20))).toBe(true);
  });
});

describe('chunkMarkdown', () => {
  const body = (s: string): string => `${s}的細則說明如下，請依規定辦理並保留紀錄。`.repeat(4);

  it('每塊前綴所屬標題路徑，chunk 自帶章節脈絡', () => {
    const md = ['# 員工手冊', '## 請假規定', body('特休'), '## 加班規定', body('加班')].join('\n');
    const chunks = chunkMarkdown(md, 400);

    expect(chunks.every((c) => c.startsWith('員工手冊 > '))).toBe(true);
    expect(chunks.some((c) => c.startsWith('員工手冊 > 請假規定\n'))).toBe(true);
    expect(chunks.some((c) => c.startsWith('員工手冊 > 加班規定\n'))).toBe(true);
  });

  it('不同章節的內容不會混進同一塊（先前湊字數會讓跨節內容互相污染）', () => {
    const md = ['## 請假規定', body('特休'), '## 加班規定', body('加班')].join('\n');
    for (const c of chunkMarkdown(md, 4000)) {
      expect(c.includes('特休') && c.includes('加班')).toBe(false);
    }
  });

  it('進入同級標題時捨棄前一個同級路徑，不會累積成錯誤階層', () => {
    const md = ['# A', '## A1', body('甲'), '# B', '## B1', body('乙')].join('\n');
    const chunks = chunkMarkdown(md, 4000);
    expect(chunks.find((c) => c.includes('乙'))?.startsWith('B > B1\n')).toBe(true);
    expect(chunks.some((c) => c.startsWith('A > A1 > '))).toBe(false);
  });

  it('無標題的純文字（doc/pdf 降級路徑）退化成無前綴切塊', () => {
    const chunks = chunkMarkdown(body('出差'), 4000);
    expect(chunks.length).toBe(1);
    expect(chunks[0].startsWith('出差的細則')).toBe(true);
  });

  it('標題路徑很長時仍保留正文字元預算，不會被前綴擠光', () => {
    const deep = ['# ' + '長'.repeat(300), '## ' + '標'.repeat(300), body('內容')].join('\n');
    expect(chunkMarkdown(deep, 400).length).toBeGreaterThan(0);
  });
});

describe('chunkMarkdown 表格（一列一 chunk）', () => {
  const HEADER = '| 管制代號 | 指示交辦事項 | 主辦單位 | 完成日期 |';
  const DIVIDER = '| --- | --- | --- | --- |';
  const table = (...rows: string[]): string => ['# 交辦案件表', '', HEADER, DIVIDER, ...rows].join('\n');

  it('每列自成一塊且自帶欄位名——表頭不再只存在於第一塊', () => {
    const chunks = chunkMarkdown(
      table(
        '| 430-01(2013/01/24) | 業務報告案 | 教育文化處 | 2013/02/04 |',
        '| 430-02(2013/01/24) | 職員名冊案 | 秘書室 | 2013/02/08 |',
      ),
      800,
    );
    expect(chunks.length).toBe(2);
    // 關鍵：第二塊也帶得到「主辦單位」欄位名，不必依賴前一塊的表頭
    expect(chunks.every((c) => c.includes('主辦單位：'))).toBe(true);
    expect(chunks[1]).toContain('管制代號：430-02(2013/01/24)');
    expect(chunks[1]).toContain('主辦單位：秘書室');
    expect(chunks[1]).toContain('交辦案件表'); // 標題路徑仍保留
  });

  it('空白儲存格不進 chunk（避免「欄位：」空值雜訊）', () => {
    const [chunk] = chunkMarkdown(table('| 430-03 |  | 教育文化處 |  |'), 800);
    expect(chunk).toContain('管制代號：430-03');
    expect(chunk).toContain('主辦單位：教育文化處');
    expect(chunk).not.toContain('指示交辦事項：');
    expect(chunk).not.toContain('完成日期：');
  });

  it('單列過長時切開長欄位，短欄位當識別鍵重複帶進每個片段', () => {
    const long = '本案辦理情形說明如下，請依規定辦理並保留紀錄。'.repeat(60);
    const chunks = chunkMarkdown(table(`| 430-04 | ${long} | 教育文化處 | 2013/02/04 |`), 800);

    expect(chunks.length).toBeGreaterThan(1);
    // 每個片段都還認得出是哪一筆、誰主辦——這是先前表頭遺失時做不到的
    expect(chunks.every((c) => c.includes('管制代號：430-04'))).toBe(true);
    expect(chunks.every((c) => c.includes('主辦單位：教育文化處'))).toBe(true);
    expect(chunks.every((c) => c.includes('指示交辦事項：'))).toBe(true);
  });

  it('表格前後的散文各自成塊，不與表格列混在一起', () => {
    const md = ['## 說明', '前言'.repeat(20), '', HEADER, DIVIDER, '| A1 | B1 | C1 | D1 |'].join('\n');
    const chunks = chunkMarkdown(md, 800);
    expect(chunks.some((c) => c.includes('前言') && !c.includes('管制代號：'))).toBe(true);
    expect(chunks.some((c) => c.includes('管制代號：A1') && !c.includes('前言'))).toBe(true);
  });

  it('沒有分隔列的管線文字不當成表格（避免誤判散文）', () => {
    const md = ['| 這看起來像表格但沒有分隔列 |', '一般段落內容，長度足夠成塊。'.repeat(3)].join('\n');
    const chunks = chunkMarkdown(md, 800);
    expect(chunks.some((c) => c.includes('這看起來像表格但沒有分隔列'))).toBe(true);
    expect(chunks.every((c) => !c.includes('：|'))).toBe(true);
  });
});
