import { chunkText, chunkWebsitePage, extractPage, normalizeUrl } from '@/modules/knowledge/ingest.service';

describe('ingest 純函式', () => {
  it('extractPage 取標題與頁尾聯絡資訊', () => {
    const html = `<html><head><title>凌網</title></head><body>
      <main><h2>產品</h2><p>${'內容'.repeat(20)}</p></main>
      <footer>台北分公司 TEL：02-2395-6966</footer></body></html>`;
    const page = extractPage(html);
    expect(page.title).toBe('凌網');
    const chunks = chunkWebsitePage(page, 800);
    expect(chunks.some((c) => c.title === '凌網 > 聯絡資訊' && c.text.includes('02-2395-6966'))).toBe(true);
  });

  it('chunkText 依長度切段且過短片段剔除', () => {
    const chunks = chunkText('第一句。'.repeat(200), 200);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length >= 20)).toBe(true);
  });

  it('normalizeUrl 濾掉跨網域與檔案連結', () => {
    const origin = 'https://a.com';
    expect(normalizeUrl('/x', 'https://a.com/', origin)).toBe('https://a.com/x');
    expect(normalizeUrl('https://b.com/x', 'https://a.com/', origin)).toBeNull();
    expect(normalizeUrl('/a.pdf', 'https://a.com/', origin)).toBeNull();
  });
});

/**
 * 網站分節依文件順序讀取（HTML → Markdown → chunkMarkdown），不再只抓「標題的同層元素」。
 * 以下每種結構都是舊版實測會漏抓、歸錯章節或重複收錄的情況。
 */
describe('網站分節：各種常見網頁結構', () => {
  const para = (label: string) => `<p>${label}的內容，長度足夠通過門檻，再多寫一些字以免被當成過短片段而剔除。</p>`;
  const chunksOf = (body: string) =>
    chunkWebsitePage(extractPage(`<html><head><title>站名</title></head><body>${body}</body></html>`), 800);
  const sectionOf = (body: string, label: string) => chunksOf(body).filter((c) => c.text.includes(label));

  it('第一個標題前的前言不漏抓', () => {
    const body = `<main>${para('前言')}<h2>請假規定</h2>${para('請假')}</main>`;
    expect(sectionOf(body, '前言的內容')).toHaveLength(1);
    expect(sectionOf(body, '請假的內容')[0].title).toBe('站名 > 請假規定');
  });

  it('首頁簡介夾在 hero 標題與服務卡片之間也抓得到', () => {
    const body = `<div class="hero"><h1>專業顧問服務</h1></div><div class="intro">${para('公司簡介')}</div>`
      + `<div class="cards"><div class="card"><h3>服務一</h3>${para('服務一')}</div></div><h2>聯絡我們</h2>${para('聯絡')}`;
    expect(sectionOf(body, '公司簡介的內容')[0].title).toBe('站名 > 專業顧問服務');
    expect(sectionOf(body, '服務一的內容')[0].title).toBe('站名 > 專業顧問服務 > 服務一');
    // h2 排在 h1 之後，依標題層級歸在 h1 底下（與上傳檔案的標題路徑規則相同）
    expect(sectionOf(body, '聯絡的內容')[0].title).toBe('站名 > 專業顧問服務 > 聯絡我們');
  });

  it('標題包在獨立容器裡，內容仍歸到正確的章節', () => {
    const body = `<main><h2>請假規定</h2>${para('請假')}<div class="card"><h3>加班規定</h3></div><div class="card-body">${para('加班')}</div></main>`;
    const [overtime] = sectionOf(body, '加班的內容');
    expect(overtime.title).toBe('站名 > 請假規定 > 加班規定');
    expect(overtime.text).not.toContain('請假的內容');
  });

  it('標題底下有子標題時，內容只收錄一次', () => {
    const body = `<main><h2>人事規章</h2><div><h3>請假</h3>${para('請假細則')}</div></main>`;
    const hits = sectionOf(body, '請假細則的內容');
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe('站名 > 人事規章 > 請假');
  });

  it('h4 以下的標題也會成為章節', () => {
    const body = `<main><h4>請假規定</h4>${para('請假')}<h4>加班規定</h4>${para('加班')}</main>`;
    expect(sectionOf(body, '加班的內容')[0].title).toBe('站名 > 加班規定');
    expect(sectionOf(body, '加班的內容')[0].text).not.toContain('請假的內容');
  });

  it('移除導覽列、頁首與腳本，不讓雜訊進索引', () => {
    const body = `<header>網站選單</header><nav>首頁 產品 聯絡</nav><script>var x = 1;</script><main><h2>產品</h2>${para('產品')}</main>`;
    const text = chunksOf(body).map((c) => c.text).join('\n');
    expect(text).toContain('產品的內容');
    expect(text).not.toMatch(/網站選單|首頁 產品 聯絡|var x/);
  });

  it('每個片段開頭帶完整的標題路徑', () => {
    const body = `<main><h2>人事規章</h2><h3>請假</h3>${para('請假')}</main>`;
    expect(sectionOf(body, '請假的內容')[0].text.startsWith('站名 > 人事規章 > 請假\n')).toBe(true);
  });
});
