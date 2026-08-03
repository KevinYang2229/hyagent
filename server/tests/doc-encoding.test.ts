/**
 * 檔案編碼偵測。
 *
 * 真實踩到的坑：Word「另存為網頁」在中文 Windows 預設輸出 UTF-16LE，
 * 而解析層一律 `buf.toString('utf8')`，結果每個中文字都變 U+FFFD、ASCII 標記之間夾 NUL
 * 導致 HTML 也解析不出結構——980 個純垃圾 chunk 進了索引，檢索當然答不出來。
 */
import { parseDocument } from '@/modules/knowledge/doc-parse';

const CH = '原住民族委員會主管會報管制案件表';
const HTML = `<html><head><title>${CH}</title></head><body><h2>主辦單位</h2><p>${CH}</p></body></html>`;

/** 加上 BOM 的 UTF-16LE（Word 另存為網頁的實際輸出） */
function utf16le(s: string, bom = true): Buffer {
  const body = Buffer.from(s, 'utf16le');
  return bom ? Buffer.concat([Buffer.from([0xff, 0xfe]), body]) : body;
}

function utf16be(s: string): Buffer {
  const le = Buffer.from(s, 'utf16le');
  const be = Buffer.alloc(le.length);
  for (let i = 0; i < le.length; i += 2) {
    be[i] = le[i + 1];
    be[i + 1] = le[i];
  }
  return Buffer.concat([Buffer.from([0xfe, 0xff]), be]);
}

describe('編碼偵測', () => {
  it('UTF-16LE + BOM 的 HTML（Word 另存為網頁）→ 中文正確且 HTML 結構解得出來', async () => {
    const out = await parseDocument('管制案件.html', utf16le(HTML));
    expect(out.text).toContain('原住民族委員會');
    expect(out.text).toContain('## 主辦單位'); // 編碼對了，htmlToMarkdown 才吃得到結構
    expect(out.text).not.toContain('�');
    expect(out.text).not.toContain('<html');
  });

  it('UTF-16LE 無 BOM → 靠 NUL 分佈判斷', async () => {
    const out = await parseDocument('管制案件.html', utf16le(HTML, false));
    expect(out.text).toContain('原住民族委員會');
    expect(out.text).not.toContain('�');
  });

  it('UTF-16BE + BOM', async () => {
    const out = await parseDocument('管制案件.html', utf16be(HTML));
    expect(out.text).toContain('原住民族委員會');
  });

  it('UTF-8 + BOM → BOM 不會混進內容', async () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(CH, 'utf8')]);
    const out = await parseDocument('a.txt', buf);
    expect(out.text).toBe(CH);
    expect(out.text.charCodeAt(0)).not.toBe(0xfeff);
  });

  it('Big5（政府文件常見）— 由 meta charset 宣告', async () => {
    const html = `<html><head><meta charset="big5"><title>t</title></head><body><p>${CH}</p></body></html>`;
    const buf = Buffer.from(new TextEncoder().encode(html)); // meta 是 ASCII，內文另外轉
    const big5Body = encodeBig5(html);
    expect(buf.length).toBeGreaterThan(0);
    const out = await parseDocument('a.html', big5Body);
    expect(out.text).toContain('原住民族委員會');
  });

  it('純 UTF-8 不受影響（現有檔案不能被改壞）', async () => {
    const out = await parseDocument('a.txt', Buffer.from(CH, 'utf8'));
    expect(out.text).toBe(CH);
  });

  it('任何編碼都解不出可讀內容 → 422，而不是把亂碼寫進索引', async () => {
    await expect(parseDocument('壞檔.txt', Buffer.alloc(3000, 0xff))).rejects.toMatchObject({
      statusCode: 422,
    });
  });
});

/** 測試用 Big5 編碼器：Node 只有 Big5 decoder，編碼端靠 decoder 反查建表 */
function encodeBig5(s: string): Buffer {
  const dec = new TextDecoder('big5');
  const map = new Map<string, [number, number]>();
  for (let hi = 0x81; hi <= 0xfe; hi++) {
    for (let lo = 0x40; lo <= 0xfe; lo++) {
      const ch = dec.decode(new Uint8Array([hi, lo]));
      if (ch.length === 1 && ch !== '�' && !map.has(ch)) map.set(ch, [hi, lo]);
    }
  }
  const out: number[] = [];
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (code < 0x80) out.push(code);
    else {
      const pair = map.get(ch);
      if (!pair) throw new Error(`Big5 無法編碼：${ch}`);
      out.push(pair[0], pair[1]);
    }
  }
  return Buffer.from(out);
}
