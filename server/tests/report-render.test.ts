/**
 * 報告渲染：Markdown 產出的節結構、來源清單去重、degraded 標註、查無資料節保留標題。
 */
import type { ReportDoc } from '@/modules/report/report.types';
import { renderers } from '@/modules/report/report.render';

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
    expect(out).toContain('> 馬太鞍溪災害補助 · 2026-08-11T00:00:00.000Z');
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
    expect(out).toContain('馬太鞍溪災害補助 · 2026-08-11T00:00:00.000Z');
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
    expect(renderer.contentType).toMatch(/charset=utf-8/);
    const out = await renderer.render(makeDoc());
    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out.length).toBeGreaterThan(0);
  });
});
