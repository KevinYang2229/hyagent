import { parseRichText } from './RichText';

it('拆出條列與粗體片段', () => {
  expect(parseRichText('目前有：\n- **鮭魚**：6 個\n\n結束')).toEqual([
    { bullet: false, parts: [{ text: '目前有：', bold: false }] },
    { bullet: true, parts: [{ text: '鮭魚', bold: true }, { text: '：6 個', bold: false }] },
    { bullet: false, parts: [{ text: '結束', bold: false }] },
  ]);
});
