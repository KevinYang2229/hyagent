/**
 * docx 與 xlsx 輸出。
 *
 * 這兩種格式都是二進位容器，「有產出」不等於「打得開」——所以一律做來回驗證：
 * xlsx 用 exceljs 讀回來、docx 用 mammoth（既有依賴，本來就拿來讀 Word）轉回 HTML。
 * 只斷言 buffer 長度的話，寫壞的 zip 也會過。
 */
import { Workbook } from 'exceljs';
import mammoth from 'mammoth';
import { renderDocx } from '@/modules/report/renderers/docx';
import { renderXlsx } from '@/modules/report/renderers/xlsx';
import type { ReportDoc, ReportSection } from '@/modules/report/report.types';

const bar: ReportSection = {
  heading: '參觀者預登',
  query: '各國預登人數是多少？',
  body: '本節說明各國預登情形。\n\n### 重點\n\n- **日本**最多\n- 其次是[美國](https://example.com/us)\n',
  sources: [{ title: 'CC匯出.xlsx', url: 'https://example.com/cc' }],
  hits: 5,
  charts: [{
    kind: 'bar', complete: true, title: '各國預登人數', unit: '人',
    points: [{ label: '日本', value: 3012 }, { label: '美國', value: 2320 }, { label: '德國', value: 1180 }],
    sourceLabel: 'CC匯出.xlsx / 4-CC-國家', totalRows: 3,
  }],
};

const grouped: ReportSection = {
  heading: '預登與報到',
  query: '兩者的落差？',
  body: '兩地的落差如下。',
  sources: [{ title: 'CC匯出.xlsx' }],
  hits: 4,
  charts: [{
    kind: 'grouped', complete: true, title: '預登與報到', series: ['今年預登', '今年報到'],
    points: [
      { label: 'Taiwan', value: 128, values: [128, 96] },
      { label: 'Overseas', value: 232, values: [232, 180] },
    ],
    sourceLabel: 'CC匯出.xlsx / 1-CC-統計', totalRows: 2,
  }],
};

const empty: ReportSection = { heading: '滿意度', query: '滿意度如何？', body: '', sources: [], hits: 0 };

const doc: ReportDoc = {
  title: '參展統計報告',
  topic: '展覽數據',
  locale: 'zh-Hant',
  generatedAt: '2026-08-18T00:00:00.000Z',
  sections: [bar, grouped, empty],
};

describe('xlsx', () => {
  const load = async (d: ReportDoc = doc): Promise<Workbook> => {
    const book = new Workbook();
    // exceljs 宣告的 Buffer 型別與 @types/node 的不是同一個，明確轉一次而不是關掉檢查
    await book.xlsx.load((await renderXlsx(d)) as unknown as Parameters<typeof book.xlsx.load>[0]);
    return book;
  };

  it('章節總表在最前面，列出每一節與其對應的工作表', async () => {
    const sheet = (await load()).worksheets[0];
    expect(sheet.name).toBe('章節');
    expect(sheet.getCell('A1').value).toBe('參展統計報告');
    expect(sheet.getCell('A5').value).toBe('參觀者預登');
    expect(sheet.getCell('D5').value).toBe('各國預登人數'); // 圖畫在哪張工作表
    // 沒有圖的章節照樣列出來，只是圖表欄留白
    expect(sheet.getCell('A7').value).toBe('滿意度');
    expect(sheet.getCell('D7').value).toBe('');
  });

  it('每張圖各一個工作表，數值以「數字」寫入才加總得了', async () => {
    const sheet = (await load()).getWorksheet('各國預登人數');
    expect(sheet?.getCell('A1').value).toBe('各國預登人數');
    expect(String(sheet?.getCell('A2').value)).toContain('直接讀自原始資料');
    expect(sheet?.getCell('A4').value).toBe('項目');
    expect(sheet?.getCell('B4').value).toBe('人');
    expect(sheet?.getCell('A5').value).toBe('日本');
    // 寫成字串的話 Excel 不會加總也不會排序，就失去做成試算表的唯一理由
    expect(typeof sheet?.getCell('B5').value).toBe('number');
    expect(sheet?.getCell('B5').value).toBe(3012);
  });

  it('分組長條的每個數列各成一欄', async () => {
    const sheet = (await load()).getWorksheet('預登與報到');
    expect(sheet?.getCell('B4').value).toBe('今年預登');
    expect(sheet?.getCell('C4').value).toBe('今年報到');
    expect(sheet?.getCell('B5').value).toBe(128);
    expect(sheet?.getCell('C5').value).toBe(96);
  });

  it('工作表名截到 31 字、去掉非法字元、重名加序號', async () => {
    const long = '參觀者預先登記人數統計依國家與地區別分列的完整明細表';
    const chart = { ...bar.charts![0], title: `${long}[A]` };
    const book = await load({
      ...doc,
      sections: [{ ...bar, charts: [chart] }, { ...bar, heading: '第二節', charts: [{ ...chart }] }],
    });
    const names = book.worksheets.slice(1).map((w) => w.name);
    expect(names[0].length).toBeLessThanOrEqual(31);
    expect(names[0]).not.toMatch(/[:\\/?*[\]]/);
    expect(names[1]).not.toBe(names[0]); // 截斷後容易撞名
    expect(names[1]).toMatch(/\(2\)$/);
  });
});

describe('docx', () => {
  const html = async (d: ReportDoc = doc): Promise<string> => {
    const buffer = await renderDocx(d);
    expect(buffer.subarray(0, 2).toString()).toBe('PK'); // docx 是 zip
    return (await mammoth.convertToHtml({ buffer })).value;
  };

  it('章節標題、內文與 Markdown 的強調與清單都帶得過去', async () => {
    const out = await html();
    expect(out).toContain('參展統計報告');
    expect(out).toMatch(/<h2>參觀者預登<\/h2>/);
    expect(out).toContain('本節說明各國預登情形。');
    expect(out).toMatch(/<h3>重點<\/h3>/);
    expect(out).toContain('<strong>日本</strong>');
    expect(out).toContain('<li>');
  });

  it('連結保留 href；白名單外的 scheme 只留文字，不成為可點連結', async () => {
    expect(await html()).toContain('href="https://example.com/us"');

    // markdown-it 允許 mailto:，safeUrl 的白名單只放行 http/https——第二道防線要真的擋得住
    const mail = { ...bar, body: '寄到[信箱](mailto:a@example.com)。' };
    const out = await html({ ...doc, sections: [mail] });
    expect(out).toContain('信箱');
    expect(out).not.toContain('mailto:');

    /*
     * javascript: 由 markdown-it 的 validateLink 擋在更前面：它根本不產生 link token，
     * 那段語法會原樣留成文字。文字裡出現 "javascript:" 無害（也誠實反映原始材料說了什麼），
     * 要守住的不變式是「沒有指向它的可點連結」。
     */
    const evil = { ...bar, body: '見[惡意網站](javascript:alert(1))。' };
    const evilOut = await html({ ...doc, sections: [evil] });
    expect(evilOut).toContain('惡意網站');
    expect(evilOut).not.toContain('href="javascript:');
  });

  it('圖表成為可編輯的資料表，數字原樣可核對', async () => {
    const out = await html();
    expect(out).toContain('各國預登人數');
    expect(out).toMatch(/<table>[\s\S]*3,012[\s\S]*<\/table>/);
    expect(out).toContain('項目');
    // 分組長條的兩個數列各一欄
    expect(out).toContain('今年預登');
    expect(out).toContain('今年報到');
  });

  it('零命中的章節印出固定語句，不留空白', async () => {
    const out = await html();
    expect(out).toMatch(/<h2>滿意度<\/h2>/);
    expect(out).toContain('知識庫查無相關資料');
  });

  it('來源清單附在最後，帶得出連結', async () => {
    const out = await html();
    expect(out).toContain('href="https://example.com/cc"');
    expect(out).toContain('CC匯出.xlsx');
  });
});
