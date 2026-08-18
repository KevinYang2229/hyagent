/** 上傳檔解析：格式判定以 magic bytes 為準；可取得結構者轉 Markdown（標題/表格保留）。 */
import { detectFormat, htmlToMarkdown, parseDocument } from '@/modules/knowledge/doc-parse';
import { makeDocx, para, table } from './helpers/make-docx';
import { makeXlsx } from './helpers/make-xlsx';

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
    for (const name of ['a.pdf', 'a.doc', 'a.docx', 'a.xlsx']) {
      expect(() => detectFormat(name, Buffer.from('這只是純文字'))).toThrow(
        expect.objectContaining({ statusCode: 400 }),
      );
    }
  });

  it('docx 與 xlsx 同為 PK zip，靠容器內的 part 名稱區分（副檔名誤標仍以內容為準）', async () => {
    const xlsx = await makeXlsx({ name: '清單', rows: [['年資', '天數']] });
    expect(detectFormat('表.xlsx', xlsx)).toBe('xlsx');
    expect(detectFormat('表.docx', xlsx)).toBe('xlsx');

    const docx = await makeDocx(para('內文'));
    expect(detectFormat('文.xlsx', docx)).toBe('docx');
  });

  it('.xlsx 但內容是 OLE2（舊版 .xls 改副檔名）→ 400，而非交給 word-extractor 抽出雜訊', () => {
    expect(() => detectFormat('舊表.xlsx', OLE2)).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
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

describe('parseDocument — xlsx', () => {
  it('每張工作表轉成 Markdown 表格，表名當標題（chunk 才帶得到「這張表在講什麼」）', async () => {
    const buf = await makeXlsx(
      {
        name: '特休天數',
        rows: [
          ['年資', '天數'],
          ['1年', 7],
        ],
      },
      { name: '加班費率', rows: [['時段', '倍率'], ['平日', 1.34]] },
    );
    const out = await parseDocument('人事規章.xlsx', buf);

    expect(out.format).toBe('xlsx');
    expect(out.fidelity).toBe('structured');
    expect(out.text).toContain('## 特休天數');
    expect(out.text).toContain('| 年資 | 天數 |');
    expect(out.text).toContain('| 1年 | 7 |');
    expect(out.text).toContain('## 加班費率');
    expect(out.text).toContain('| 平日 | 1.34 |');
  });

  it('合併儲存格填回每一列，欄位不位移（等同 HTML 表格展開 rowspan）', async () => {
    const buf = await makeXlsx({
      name: '管制表',
      rows: [
        ['管制代號', '主辦單位', '完成日期'],
        ['430-04', '教育文化處', '2013/02/04'],
        [null, '社會福利處', '2013/02/05'],
        [null, '秘書室', '2013/02/06'],
      ],
      merges: ['A2:A4'],
    });
    const out = await parseDocument('管制.xlsx', buf);

    expect(out.text).toContain('| 430-04 | 教育文化處 | 2013/02/04 |');
    expect(out.text).toContain('| 430-04 | 社會福利處 | 2013/02/05 |');
    expect(out.text).toContain('| 430-04 | 秘書室 | 2013/02/06 |');
  });

  it('公式取計算結果、超連結只留錨點文字（使用者問的是數字，不是 =SUM(...)）', async () => {
    const buf = await makeXlsx({
      name: '費用',
      rows: [
        ['項目', '金額'],
        ['交通', 100],
        ['住宿', 200],
        ['合計', { formula: 'SUM(B2:B3)', result: 300 }],
        ['依據', { text: '差旅辦法', hyperlink: 'https://x.test/rule' }],
      ],
    });
    const out = await parseDocument('費用.xlsx', buf);

    expect(out.text).toContain('| 合計 | 300 |');
    expect(out.text).not.toContain('SUM(B2:B3)');
    expect(out.text).toContain('| 依據 | 差旅辦法 |');
    expect(out.text).not.toContain('https://x.test/rule');
  });

  it('日期輸出為日期字串，不拖著無意義的 T00:00:00.000Z', async () => {
    const buf = await makeXlsx({
      name: '期程',
      rows: [
        ['階段', '截止'],
        ['初審', new Date(Date.UTC(2013, 1, 4))],
      ],
    });
    const out = await parseDocument('期程.xlsx', buf);

    // 不斷言確切日期：exceljs 的日期序號在寫入時會帶進執行環境時區，跨機器不穩定
    expect(out.text).toMatch(/\| 初審 \| \d{4}-\d{2}-\d{2} \|/);
    expect(out.text).not.toContain('T00:00:00.000Z');
  });

  it('略過全空列與尾端空欄（格式殘留會把 columnCount 撐大到超出資料範圍）', async () => {
    const buf = await makeXlsx({
      name: '規定',
      rows: [['項目', '說明'], [], ['特休', '依年資計算']],
      styledBlanks: ['F1'], // 只有樣式沒有值，columnCount 因此變成 6
    });
    const out = await parseDocument('規定.xlsx', buf);

    expect(out.text).toContain('| 項目 | 說明 |');
    expect(out.text).toContain('| 特休 | 依年資計算 |');
    expect(out.text).not.toContain('|  |  |'); // 空列與空欄都不該留下
  });

  it('略過隱藏工作表（查表資料／計算暫存，不是給人讀的內容）', async () => {
    const buf = await makeXlsx(
      { name: '對外公告', rows: [['公告', '本年度特休依年資計算']] },
      { name: '內部計算', rows: [['暫存', '請勿外流的試算欄位']], hidden: true },
    );
    const out = await parseDocument('公告.xlsx', buf);

    expect(out.text).toContain('## 對外公告');
    expect(out.text).not.toContain('## 內部計算');
    expect(out.text).not.toContain('請勿外流的試算欄位');
  });

  it('儲存格內的管線符號會被跳脫，不會拆散表格結構', async () => {
    const buf = await makeXlsx({
      name: '代碼',
      rows: [
        ['欄位', '允許值'],
        ['狀態', '待審|已核|退回'],
      ],
    });
    const out = await parseDocument('代碼.xlsx', buf);

    expect(out.text).toContain('| 狀態 | 待審\\|已核\\|退回 |');
  });
});
