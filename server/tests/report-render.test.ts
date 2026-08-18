/**
 * 報告渲染：Markdown 產出的節結構、來源清單去重、degraded 標註、查無資料節保留標題。
 */
import type { ReportDoc, ReportSection, SectionChart } from '@/modules/report/report.types';
import { renderers } from '@/modules/report/report.render';
import { renderHtml as renderReportHtml } from '@/modules/report/renderers/html';

function makeDoc(partial: Partial<ReportDoc> = {}): ReportDoc {
  return {
    title: '馬太鞍溪災害補助報告',
    topic: '馬太鞍溪災害補助',
    locale: 'zh-TW',
    generatedAt: '2026-08-11T00:00:00.000Z',
    sections: [
      {
        heading: '申請資格',
        query: '誰可以申請馬太鞍溪災害補助？',
        body: '設籍於受災區域之住戶。（來源：補助申請須知）',
        sources: [{ title: '補助申請須知', url: 'https://example.gov.tw/a' }],
        hits: 3,
      },
    ],
    ...partial,
  };
}

async function renderMd(doc: ReportDoc): Promise<string> {
  return (await renderers.md.render(doc)).toString('utf8');
}

describe('markdown renderer', () => {
  it('輸出標題、主題與各節標題內文', async () => {
    const out = await renderMd(makeDoc());
    expect(out).toContain('# 馬太鞍溪災害補助報告');
    expect(out).toContain('## 申請資格');
    expect(out).toContain('設籍於受災區域之住戶。');
    // 表頭應同時含主題與產生時間
    // 表頭時間以 REPORT_TIMEZONE（預設 Asia/Taipei）呈現：UTC 00:00 ＝ 台北 08:00
    expect(out).toContain('> 馬太鞍溪災害補助 · 2026-08-11 08:00:00');
  });

  it('查無資料的節保留標題，內文為固定語句', async () => {
    const doc = makeDoc({
      sections: [
        { heading: '補助金額', query: '補助金額多少？', body: '', sources: [], hits: 0 },
      ],
    });
    const out = await renderMd(doc);
    expect(out).toContain('## 補助金額');
    expect(out).toContain('知識庫查無相關資料。');
  });

  it('降級的節加註說明，讓讀者知道該節品質不同', async () => {
    const doc = makeDoc({
      sections: [
        {
          heading: '申請期限',
          query: '申請期限到什麼時候？',
          body: '・須知：即日起至 12/31',
          sources: [{ title: '須知' }],
          hits: 2,
          degraded: true,
        },
      ],
    });
    const out = await renderMd(doc);
    expect(out).toContain('本節彙整未完成，以下為檢索到的原始片段');
  });

  it('報告尾端彙整來源清單並去重，有 url 者輸出連結', async () => {
    const doc = makeDoc({
      sections: [
        {
          heading: 'A',
          query: 'a?',
          body: 'a',
          sources: [
            { title: '須知', url: 'https://example.gov.tw/a' },
            { title: '須知', url: 'https://example.gov.tw/a' },
          ],
          hits: 1,
        },
        {
          heading: 'B',
          query: 'b?',
          body: 'b',
          sources: [{ title: '公告' }],
          hits: 1,
        },
      ],
    });
    const out = await renderMd(doc);
    expect(out).toContain('## 來源');
    expect(out.match(/example\.gov\.tw\/a/g)).toHaveLength(1);
    expect(out).toContain('- [須知](https://example.gov.tw/a)');
    expect(out).toContain('- 公告');
  });

  it('英文報告用英文固定語句', async () => {
    const doc = makeDoc({
      locale: 'en',
      sections: [{ heading: 'Amount', query: 'How much?', body: '', sources: [{ title: 'Guide' }], hits: 0 }],
    });
    const out = await renderMd(doc);
    expect(out).toContain('No relevant information found in the knowledge base.');
    expect(out).toContain('## Sources');
  });
});

describe('html renderer', () => {
  async function renderHtml(doc: ReportDoc): Promise<string> {
    return (await renderers.html.render(doc)).toString('utf8');
  }

  it('輸出完整 HTML 文件且不引用任何外部資源', async () => {
    const out = await renderHtml(makeDoc());
    expect(out).toContain('<!doctype html>');
    expect(out).toContain('<style>');
    expect(out).not.toMatch(/https?:\/\/[^"']*\.(css|js)/);
    expect(out).not.toContain('<link');
    expect(out).not.toContain('<script');
    // 表頭應同時含主題與產生時間
    expect(out).toContain('馬太鞍溪災害補助 · 2026-08-11 08:00:00');
  });

  it('escape 標題與內文——內容來自被爬取的外部網站，屬不可信輸入', async () => {
    const doc = makeDoc({
      title: '<script>alert(1)</script>',
      sections: [
        {
          heading: '<img onerror=alert(1)>',
          query: 'q',
          body: 'a & b < c',
          sources: [{ title: '"引號"', url: 'https://example.gov.tw/?a=1&b=2' }],
          hits: 1,
        },
      ],
    });
    const out = await renderHtml(doc);
    expect(out).not.toContain('<script>alert(1)</script>');
    expect(out).not.toContain('<img onerror');
    expect(out).toContain('&lt;script&gt;');
    expect(out).toContain('a &amp; b &lt; c');
    expect(out).toContain('https://example.gov.tw/?a=1&amp;b=2');
  });

  it('查無資料節與降級節的標註與 Markdown 一致', async () => {
    const doc = makeDoc({
      sections: [
        { heading: '金額', query: 'q', body: '', sources: [], hits: 0 },
        { heading: '期限', query: 'q', body: '片段', sources: [], hits: 1, degraded: true },
      ],
    });
    const out = await renderHtml(doc);
    expect(out).toContain('知識庫查無相關資料。');
    expect(out).toContain('本節彙整未完成，以下為檢索到的原始片段');
  });

  it('lang 屬性與固定語句 locale 一致（normalizeLocale 處理各種語言標籤）', async () => {
    const doc = makeDoc({
      locale: 'en-US',
      sections: [{ heading: 'Amount', query: 'How much?', body: '', sources: [{ title: 'Guide' }], hits: 0 }],
    });
    const out = await renderHtml(doc);
    expect(out).toContain('lang="en"');
    expect(out).toContain('No relevant information found in the knowledge base.');
  });

  it('javascript: scheme 的 url 被攔截，該來源輸出純文字不產生連結', async () => {
    const doc = makeDoc({
      sections: [
        {
          heading: '惡意來源',
          query: 'q',
          body: '內容',
          sources: [{ title: '惡意網站', url: 'javascript:alert(1)' }],
          hits: 1,
        },
      ],
    });
    const htmlOut = await renderHtml(doc);
    const mdOut = await renderMd(makeDoc({
      sections: [
        {
          heading: '惡意來源',
          query: 'q',
          body: '內容',
          sources: [{ title: '惡意網站', url: 'javascript:alert(1)' }],
          hits: 1,
        },
      ],
    }));
    expect(htmlOut).not.toContain('javascript:');
    expect(mdOut).not.toContain('](javascript:');
    expect(htmlOut).toContain('惡意網站');
    expect(mdOut).toContain('惡意網站');
  });
});

describe('renderer 登錄表契約', () => {
  // 對每一個登錄的 renderer 跑同一份 doc：之後新增格式會自動被這條涵蓋
  it.each(Object.keys(renderers))('%s renderer 產出非空內容且有 contentType', async (format) => {
    const renderer = renderers[format];
    expect(renderer.format).toBe(format);
    expect(renderer.contentType).toMatch(/^[a-z]+\/[a-z.+-]+/);
    // 文字格式必須宣告 charset：少了它，瀏覽器改用系統預設解碼，中文就是一片亂碼
    if (renderer.contentType.startsWith('text/')) {
      expect(renderer.contentType).toMatch(/charset=utf-8/);
    }
    const out = await renderer.render(makeDoc());
    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out.length).toBeGreaterThan(0);
  }, 30_000);
});

/**
 * 章節內文是 Markdown（LLM 輸出的既有慣例，client 也用 react-markdown 渲染聊天訊息）。
 * 兩個 renderer 都必須把它當 Markdown 處理，而不是純文字：
 * HTML 要轉成真正的標籤，Markdown 要讓內文標題正確巢狀在章節標題底下。
 */
describe('章節內文的 Markdown 處理', () => {
  const MD_BODY = [
    '# 目標市場與客戶定位',
    '',
    '凌網資訊的目標市場涵蓋三大領域。',
    '',
    '## 政府機關市場',
    '',
    '提供**電子化政府**解決方案，包括：',
    '',
    '- HyCMS 網站管理平台',
    '- HyEIP 員工入口網',
  ].join('\n');

  function docWithBody(body: string): ReportDoc {
    return makeDoc({
      sections: [
        {
          heading: '目標市場與客戶定位',
          query: 'q？',
          body,
          sources: [{ title: '產品' }],
          hits: 3,
        },
      ],
    });
  }

  it('HTML：Markdown 語法轉成標籤，不留字面的 ## 與 **', async () => {
    const out = (await renderers.html.render(docWithBody(MD_BODY))).toString('utf8');
    expect(out).toContain('<strong>電子化政府</strong>');
    expect(out).toContain('<li>HyCMS 網站管理平台</li>');
    expect(out).not.toMatch(/^##\s/m);
    expect(out).not.toContain('**電子化政府**');
  });

  it('HTML：內文標題降級為 h3，巢狀在章節的 h2 底下', async () => {
    const out = (await renderers.html.render(docWithBody(MD_BODY))).toString('utf8');
    // 章節標題現在帶節次號，標題文字包在自己的 span 裡
    expect(out).toContain('<span>目標市場與客戶定位</span>');
    expect(out).toContain('<h3>政府機關市場</h3>');
    // 內文不得產生與章節同級或更高的標題，否則報告階層會壞掉
    expect(out).not.toContain('<h1>目標市場與客戶定位</h1>');
    // 內文的 ## 必須降成 h3；章節標題與導覽區塊的 h2 由 renderer 自己產生
    expect(out).not.toContain('<h2>政府機關市場');
    expect(out).toContain('<h3>政府機關市場</h3>');
  });

  it('HTML：內文開頭重複章節標題時剔除，不重複顯示', async () => {
    const out = (await renderers.html.render(docWithBody(MD_BODY))).toString('utf8');
    expect(out.match(/目標市場與客戶定位/g) ?? []).toHaveLength(1);
  });

  it('HTML：內文裡的 raw HTML 仍被 escape，不得放行', async () => {
    const out = (
      await renderers.html.render(docWithBody('正常內容 <script>alert(1)</script>'))
    ).toString('utf8');
    expect(out).not.toContain('<script>alert(1)</script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('HTML：內文裡的 javascript: 連結不得變成可點連結', async () => {
    const out = (
      await renderers.html.render(docWithBody('[點我](javascript:alert(1))'))
    ).toString('utf8');
    expect(out).not.toContain('href="javascript:');
  });

  it('Markdown：內文標題降級到章節（##）底下，且剔除重複的章節標題', async () => {
    const out = (await renderers.md.render(docWithBody(MD_BODY))).toString('utf8');
    expect(out).toContain('## 目標市場與客戶定位');
    expect(out).toContain('### 政府機關市場');
    // 內文原本的 H1 會讓 H2 底下冒出更高階層，必須被降級掉
    expect(out).not.toMatch(/^# 目標市場與客戶定位$/m);
    expect(out.match(/^## 目標市場與客戶定位$/gm) ?? []).toHaveLength(1);
  });

  it('Markdown：粗體與清單原樣保留（本來就是 Markdown）', async () => {
    const out = (await renderers.md.render(docWithBody(MD_BODY))).toString('utf8');
    expect(out).toContain('**電子化政府**');
    expect(out).toContain('- HyCMS 網站管理平台');
  });
});

/**
 * 報告表頭的產生時間：ISO 8601（2026-08-13T01:41:29.850Z）是給機器看的，
 * 報告是給人讀的文件，要 YYYY-MM-DD HH:mm:ss。
 *
 * 時區不能用伺服器本地時間——正式環境跑在 UTC，會把台北的 09:41 印成 01:41，
 * 而裸的日期字串看起來就像本地時間，比原本帶 Z 的 ISO 更容易誤導。
 */
describe('產生時間的呈現', () => {
  // 2026-08-13T01:41:29.850Z ＝ 台北時間 2026-08-13 09:41:29
  const doc = makeDoc({ generatedAt: '2026-08-13T01:41:29.850Z' });

  it('Markdown：輸出 YYYY-MM-DD HH:mm:ss，不留 T 與 Z', async () => {
    const out = (await renderers.md.render(doc)).toString('utf8');
    expect(out).toContain('2026-08-13 09:41:29');
    expect(out).not.toContain('2026-08-13T01:41:29.850Z');
  });

  it('HTML：同樣格式', async () => {
    const out = (await renderers.html.render(doc)).toString('utf8');
    expect(out).toContain('2026-08-13 09:41:29');
    expect(out).not.toContain('T01:41:29');
  });

  it('跨日的 UTC 時間換算到台北不會錯日期', async () => {
    // 2026-08-12T16:30:00Z ＝ 台北 2026-08-13 00:30:00（日期要進位）
    const out = (
      await renderers.md.render(makeDoc({ generatedAt: '2026-08-12T16:30:00.000Z' }))
    ).toString('utf8');
    expect(out).toContain('2026-08-13 00:30:00');
  });

  it('小時用 24 小時制，午後不得出現 01:xx PM 這種形式', async () => {
    const out = (
      await renderers.md.render(makeDoc({ generatedAt: '2026-08-13T13:05:07.000Z' }))
    ).toString('utf8');
    expect(out).toContain('2026-08-13 21:05:07');
    expect(out).not.toMatch(/PM|AM/);
  });
});

/**
 * 版面：重點數字、目錄、憑證標記、來源去重。
 *
 * 實跑的報告被評為「不好閱讀、資訊不多」，這幾件事是回應：開頭要有全貌與入口，
 * 圖表的可信度要一眼看得出來，而重複的來源會讓讀者懷疑整份報告的嚴謹度。
 */
describe('報告版面', () => {
  const chart = (over: Partial<SectionChart> = {}): SectionChart => ({
    kind: 'bar', complete: true, title: '各國參展商家數', unit: '家',
    points: [{ label: '美國', value: 1930 }, { label: '日本', value: 1379 }, { label: '韓國', value: 920 }],
    sourceLabel: 'CP.xlsx / 4-CP', totalRows: 122, ...over,
  });
  const doc = (sections: ReportSection[]): ReportDoc => ({
    title: '參展統計報告', topic: '展覽數據', locale: 'zh-Hant',
    generatedAt: '2026-08-18T00:00:00.000Z', sections,
  });
  const section = (heading: string, over: Partial<ReportSection> = {}): ReportSection => ({
    heading, query: 'q', body: '內文。', sources: [{ title: 'CP.xlsx' }], hits: 5, ...over,
  });

  it('重點數字取真實存在的那一格，時間序列取最新、其餘取最大', () => {
    const html = renderReportHtml(doc([
      section('A', { charts: [chart()] }),
      section('B', { charts: [chart({ kind: 'line', title: '歷年趨勢',
        points: [{ label: '2023', value: 900 }, { label: '2024', value: 100 }] })] }),
    ]));
    expect(html).toContain('1,930');   // 最大值，不是總和
    expect(html).toContain('最高：美國');
    expect(html).toContain('100');     // 折線取最後一期而非最大值
    expect(html).toContain('最新：2024');
  });

  it('節錄圖不進重點數字——放大成大字等於替它背書', () => {
    const html = renderReportHtml(doc([section('A', { charts: [chart({ complete: false })] })]));
    expect(html).not.toContain('重點數字');
  });

  it('憑證標記分成實心與虛線兩種，一眼看得出可信度', () => {
    const exact = renderReportHtml(doc([section('A', { charts: [chart()] })]));
    expect(exact).toContain('prov-exact');
    expect(exact).toContain('>原始資料</span>');
    const sample = renderReportHtml(doc([section('A', { charts: [chart({ complete: false })] })]));
    expect(sample).toContain('prov-sample');
    expect(sample).toContain('>節錄</span>');
  });

  it('目錄與章節錨點對得起來；單節報告不生目錄', () => {
    const many = renderReportHtml(doc([section('第一節'), section('第二節')]));
    expect(many).toContain('href="#sec-01"');
    expect(many).toContain('id="sec-02"');
    expect(many).toContain('目錄');
    // 只有一節時目錄只是雜訊
    expect(renderReportHtml(doc([section('唯一')]))).not.toContain('目錄');
  });

  it('同一個來源不因某節沒帶連結而重複列出，且保留可點的那一筆', () => {
    const html = renderReportHtml(doc([
      section('A', { sources: [{ title: 'CC匯出.xlsx' }] }),
      section('B', { sources: [{ title: 'CC匯出.xlsx', url: 'https://example.com/cc' }] }),
    ]));
    expect(html.match(/CC匯出\.xlsx/g) ?? []).toHaveLength(1);
    expect(html).toContain('href="https://example.com/cc"');
  });
});
