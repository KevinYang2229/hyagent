/** 上傳檔解析：格式判定以 magic bytes 為準；可取得結構者轉 Markdown（標題/表格保留）。 */
import { detectFormat, htmlToMarkdown, parseDocument } from '@/modules/knowledge/doc-parse';
import { makeDocx, para, table } from './helpers/make-docx';

const OLE2 = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00]);
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(8)]);
const PDF = Buffer.from('%PDF-1.7\n...');

describe('detectFormat', () => {
  it('副檔名決定意圖、magic bytes 決定事實：兩者衝突時以內容為準', () => {
    // 「.doc 其實是 docx」與反向誤標在實務上都很常見，只信副檔名會拿錯 parser
    expect(detectFormat('報告.doc', ZIP)).toBe('docx');
    expect(detectFormat('報告.docx', OLE2)).toBe('doc');
    expect(detectFormat('報告.txt', PDF)).toBe('pdf');
  });

  it('純文字副檔名依副檔名分流', () => {
    expect(detectFormat('a.txt', Buffer.from('文字'))).toBe('txt');
    expect(detectFormat('a.md', Buffer.from('# 標題'))).toBe('md');
    expect(detectFormat('a.htm', Buffer.from('<p>x</p>'))).toBe('html');
    expect(detectFormat('a.html', Buffer.from('<p>x</p>'))).toBe('html');
  });

  it('不支援副檔名 → 400', () => {
    expect(() => detectFormat('a.exe', Buffer.from('x'))).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
    expect(() => detectFormat('無副檔名', Buffer.from('x'))).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it('宣稱二進位格式但無對應檔頭（損毀/誤標）→ 400，而非交給 parser 噴難解錯誤', () => {
    for (const name of ['a.pdf', 'a.doc', 'a.docx']) {
      expect(() => detectFormat(name, Buffer.from('這只是純文字'))).toThrow(
        expect.objectContaining({ statusCode: 400 }),
      );
    }
  });
});

describe('htmlToMarkdown', () => {
  it('保留標題階層與表格（切塊邊界與章節語意靠這兩者）', () => {
    const md = htmlToMarkdown(
      '<h1>員工手冊</h1><h2>請假規定</h2><p>特休依年資計算</p>' +
        '<table><thead><tr><th>年資</th><th>天數</th></tr></thead>' +
        '<tbody><tr><td>1年</td><td>7</td></tr></tbody></table>',
    );
    expect(md).toContain('# 員工手冊');
    expect(md).toContain('## 請假規定');
    expect(md).toContain('| 年資 | 天數 |');
    expect(md).toContain('| 1年 | 7 |');
  });

  it('去掉純裝飾標記與連結網址，只留文字（對 embedding 是雜訊）', () => {
    const md = htmlToMarkdown('<p>特休<strong>依年資</strong>計算，見<a href="https://x.test/rule">辦法</a></p>');
    expect(md).toContain('特休依年資計算');
    expect(md).toContain('辦法');
    expect(md).not.toContain('**');
    expect(md).not.toContain('https://x.test/rule');
  });

  it('展開 rowspan——被合併的儲存格在後續列補回，欄位不位移', () => {
    // 不補的話後續列會少一格，「主辦單位」整欄左移成「管制代號」，答案錯得理直氣壯
    const md = htmlToMarkdown(
      '<table><thead><tr><td>管制代號</td><td>主辦單位</td><td>完成日期</td></tr></thead>' +
        '<tr><td rowspan="3">430-04</td><td>教育文化處</td><td>2013/02/04</td></tr>' +
        '<tr><td>社會福利處</td><td>2013/02/05</td></tr>' +
        '<tr><td>秘書室</td><td>2013/02/06</td></tr></table>',
    );
    expect(md).toContain('| 430-04 | 教育文化處 | 2013/02/04 |');
    expect(md).toContain('| 430-04 | 社會福利處 | 2013/02/05 |');
    expect(md).toContain('| 430-04 | 秘書室 | 2013/02/06 |');
  });

  it('展開 colspan——跨欄儲存格填滿其涵蓋的每一欄', () => {
    const md = htmlToMarkdown(
      '<table><thead><tr><td>A</td><td>B</td><td>C</td></tr></thead>' +
        '<tr><td>430-05</td><td colspan="2">跨欄備註</td></tr></table>',
    );
    expect(md).toContain('| 430-05 | 跨欄備註 | 跨欄備註 |');
  });

  it('清掉不含正文的節點與 Word 另存網頁的 mso 雜訊', () => {
    const md = htmlToMarkdown(
      '<style>.a{color:red}</style><script>alert(1)</script>' +
        '<!--[if gte mso 9]><xml>垃圾設定</xml><![endif]-->' +
        '<p>正文內容<o:p>空標籤</o:p></p>',
    );
    expect(md).toContain('正文內容');
    expect(md).not.toContain('color:red');
    expect(md).not.toContain('alert');
    expect(md).not.toContain('垃圾設定');
    expect(md).not.toContain('空標籤');
  });
});

describe('parseDocument', () => {
  it('docx → Markdown，標題與表格結構保留、標為 structured', async () => {
    const buf = await makeDocx(
      para('員工手冊', 'Heading1'),
      para('請假規定', 'Heading2'),
      para('特休依年資計算。'),
      table([
        ['年資', '天數'],
        ['1年', '7'],
      ]),
    );
    const out = await parseDocument('手冊.docx', buf);

    expect(out.format).toBe('docx');
    expect(out.fidelity).toBe('structured');
    expect(out.text).toContain('# 員工手冊');
    expect(out.text).toContain('## 請假規定');
    expect(out.text).toContain('特休依年資計算。');
    expect(out.text).toContain('| 年資 | 天數 |'); // 舊的 extractRawText 會把表格壓成無法還原的文字行
  });

  it('htm → Markdown（手動把 doc 另存為網頁的路徑）', async () => {
    const out = await parseDocument('手冊.htm', Buffer.from('<h2>加班規定</h2><p>需事前申請。</p>'));
    expect(out.format).toBe('html');
    expect(out.fidelity).toBe('structured');
    expect(out.text).toContain('## 加班規定');
  });

  it('txt 原樣回傳並標為 text（無結構可用）', async () => {
    const out = await parseDocument('規章.txt', Buffer.from('第一條 公司規章。'));
    expect(out).toMatchObject({ format: 'txt', fidelity: 'text' });
    expect(out.text).toBe('第一條 公司規章。');
  });

  it('md 視為已有結構', async () => {
    const out = await parseDocument('規章.md', Buffer.from('## 條文\n內容'));
    expect(out).toMatchObject({ format: 'md', fidelity: 'structured' });
  });
});
