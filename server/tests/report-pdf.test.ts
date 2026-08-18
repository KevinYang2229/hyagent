/**
 * PDF 輸出。
 *
 * 這個 renderer 依賴外部的 Chromium，行為因此分成兩半：
 * - 沒有瀏覽器時「不提供 pdf 格式」——白名單要誠實反映這個部署做得到什麼，
 *   讓 ?format=pdf 得到 422 而不是 500
 * - 有瀏覽器時真的印得出可用的 PDF
 *
 * setup-env 把 REPORT_PDF_BROWSER 指向不存在的路徑（否則每個 job 測試都會去印一份），
 * 所以要驗真實輸出的案例得自己探測並暫時覆寫 env。
 */
import { existsSync } from 'node:fs';
import { env } from '@/config/env';
import { probeBrowserPath, renderPdf, resolveBrowserPath } from '@/modules/report/renderers/pdf';
import type { ReportDoc } from '@/modules/report/report.types';

const writable = env as { REPORT_PDF_BROWSER?: string };
const original = writable.REPORT_PDF_BROWSER;
afterEach(() => {
  writable.REPORT_PDF_BROWSER = original;
});

const doc: ReportDoc = {
  title: '參展統計報告',
  topic: '展覽數據',
  locale: 'zh-Hant',
  generatedAt: '2026-08-18T00:00:00.000Z',
  sections: [
    {
      heading: '參觀者預登',
      query: 'q',
      body: '本節說明各國預登情形。',
      sources: [{ title: 'CC匯出.xlsx' }],
      hits: 5,
      charts: [{
        kind: 'bar', complete: false, title: '各國預登人數', unit: '人',
        points: [{ label: '日本', value: 30 }, { label: '美國', value: 232 }, { label: '德國', value: 11 }],
      }],
    },
  ],
};

describe('resolveBrowserPath', () => {
  it('env 指定的路徑不存在時不提供 PDF——不默默改用別的瀏覽器', () => {
    writable.REPORT_PDF_BROWSER = '/definitely/not/a/browser';
    expect(resolveBrowserPath()).toBeUndefined();
  });

  it('env 指定且存在時就用它', () => {
    writable.REPORT_PDF_BROWSER = process.execPath; // 一定存在的可執行檔
    expect(resolveBrowserPath()).toBe(process.execPath);
  });

  it('env 未設時退回探測常見位置', () => {
    writable.REPORT_PDF_BROWSER = undefined;
    const probed = probeBrowserPath();
    expect(resolveBrowserPath()).toBe(probed);
    if (probed) expect(existsSync(probed)).toBe(true);
  });
});

describe('renderPdf', () => {
  it('找不到瀏覽器時丟出指名原因的錯誤，而不是產出壞檔', async () => {
    writable.REPORT_PDF_BROWSER = '/definitely/not/a/browser';
    await expect(renderPdf(doc)).rejects.toThrow('找不到 Chromium');
  });

  const browser = probeBrowserPath();
  const withBrowser = browser ? it : it.skip;

  withBrowser('真的印得出 PDF：正確的檔頭、非空、頁數可解析', async () => {
    writable.REPORT_PDF_BROWSER = browser;
    const buf = await renderPdf(doc);
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(buf.length).toBeGreaterThan(1000);
    // 頁樹的 /Count 解得出來，代表這是結構完整的 PDF 而不只是有個檔頭
    const pages = /\/Type\s*\/Pages[\s\S]*?\/Count\s+(\d+)/.exec(buf.toString('latin1'));
    expect(Number(pages?.[1])).toBeGreaterThanOrEqual(1);
  }, 60_000);

  withBrowser('印完不留下暫存檔', async () => {
    writable.REPORT_PDF_BROWSER = browser;
    await renderPdf(doc);
    // mkdtemp 的目錄名有固定前綴；留下任何一個都代表 finally 沒清乾淨
    const { readdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    expect(readdirSync(tmpdir()).filter((f) => f.startsWith('oa-report-'))).toEqual([]);
  }, 60_000);
});
