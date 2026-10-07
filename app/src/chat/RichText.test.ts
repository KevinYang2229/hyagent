import { parseRichText } from './RichText';

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
