import { parseRichBlocks, parseRichText } from './RichText';

it('拆出條列與粗體片段', () => {
  expect(parseRichText('目前有：\n- **鮭魚**：6 個\n\n結束')).toEqual([
    { bullet: false, parts: [{ text: '目前有：', bold: false }] },
    { bullet: true, marker: '•', parts: [{ text: '鮭魚', bold: true }, { text: '：6 個', bold: false }] },
    { bullet: false, parts: [{ text: '結束', bold: false }] },
  ]);
});

it('有序清單保留原編號', () => {
  expect(parseRichText('1. 先盤點\n2. 再補貨\n10. 收尾')).toEqual([
    { bullet: true, marker: '1.', parts: [{ text: '先盤點', bold: false }] },
    { bullet: true, marker: '2.', parts: [{ text: '再補貨', bold: false }] },
    { bullet: true, marker: '10.', parts: [{ text: '收尾', bold: false }] },
  ]);
});

it('標題去掉開頭的 #，整行粗體', () => {
  expect(parseRichText('## 今日重點\n### **補貨** 建議\n#不是標題')).toEqual([
    { bullet: false, parts: [{ text: '今日重點', bold: true }] },
    { bullet: false, parts: [{ text: '補貨', bold: true }, { text: ' 建議', bold: true }] },
    { bullet: false, parts: [{ text: '#不是標題', bold: false }] },
  ]);
});

describe('markdown 表格與分隔線', () => {
  const reply = [
    '## 主要差異',
    '',
    '| 項目 | 智慧借閱通關系統 | 智慧閘門 |',
    '|------|-----------------|---------|',
    '| **核心功能** | **借閱 + 離館**一次完成 | **身分驗證 + 通行管理** |',
    '| 整合對象 | — | 可整合 HyLib、門禁與訪客系統 |',
    '',
    '---',
    '### 建議',
  ].join('\n');

  it('連續的 | 行畫成表格：表頭、資料列，分隔列不顯示', () => {
    const blocks = parseRichBlocks(reply);
    expect(blocks.map((b) => b.kind)).toEqual(['line', 'table', 'rule', 'line']);
    const table = blocks[1] as Extract<ReturnType<typeof parseRichBlocks>[number], { kind: 'table' }>;
    expect(table.header.map((c) => c.map((p) => p.text).join(''))).toEqual(['項目', '智慧借閱通關系統', '智慧閘門']);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0][1]).toEqual([{ text: '借閱 + 離館', bold: true }, { text: '一次完成', bold: false }]);
  });

  it('被截斷、只剩半列的表格也照樣畫出，缺的欄位補空白', () => {
    const blocks = parseRichBlocks('| 項目 | A | B |\n|---|---|---|\n| 功能 | 借書 |');
    const table = blocks[0] as Extract<ReturnType<typeof parseRichBlocks>[number], { kind: 'table' }>;
    expect(table.rows[0]).toHaveLength(3);
    expect(table.rows[0][2]).toEqual([]);
  });

  it('parseRichText 只回一般行，不含表格與分隔線', () => {
    expect(parseRichText(reply).map((l) => l.parts[0].text)).toEqual(['主要差異', '建議']);
  });
});
