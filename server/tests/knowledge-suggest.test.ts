/**
 * 推薦問句的抽樣與輸出驗證（純函式）。
 *
 * 抽樣策略經實測修正：原擬依 title 出現次數排序，但檔案來源的 title 是檔名（零訊號）、
 * 網站來源次數幾乎全為 1（排序等同隨機）。改為等距取文字 ＋ 剝除共同前綴後的 title 清單。
 */
import {
  MAX_ZH_CHARS,
  parseSuggestion,
  sampleIndexForSuggestion,
  stripCommonPrefix,
} from '@/modules/knowledge/knowledge.suggest';
import type { KnowledgeIndexFile } from '@/modules/knowledge/knowledge-index.types';

function makeIndex(chunks: { title: string; text: string; id?: string }[]): KnowledgeIndexFile {
  return {
    generatedAt: 't',
    model: 'm',
    source: 's',
    chunks: chunks.map((c, i) => ({ id: `c${i}`, url: `u${i}`, vector: [0], ...c })),
  };
}

describe('stripCommonPrefix', () => {
  it('剝除網站來源的站名麵包屑前綴，並丟棄剝完為空者', () => {
    // 真實資料形狀：首頁 title 就是站名本身，剝完為空——應丟棄而非放棄整批剝除
    expect(
      stripCommonPrefix(['凌網資訊 › 智慧閱讀服務', '凌網資訊 › 電子化政府', '凌網資訊']),
    ).toEqual(['智慧閱讀服務', '電子化政府']);
  });

  it('只有一個 title 時原樣返回（否則會被剝光）', () => {
    expect(stripCommonPrefix(['1784768063225.html'])).toEqual(['1784768063225.html']);
  });

  it('無共同前綴時原樣返回', () => {
    expect(stripCommonPrefix(['請假規定', '出差辦法'])).toEqual(['請假規定', '出差辦法']);
  });

  /*
   * 檔案來源的實際形狀：同一份檔案所有 chunk 的 title 都是檔名，只有全文摘要那筆
   * 多了後綴。共同前綴等於整個檔名，硬剝下去只剩「（全文摘要）」——模型會被告知
   * 這個知識庫的主題叫「（全文摘要）」，檔名這個唯一訊號反而消失。
   */
  it('前綴吃掉整個檔名、剝完不足兩個時原樣返回（檔案來源）', () => {
    expect(stripCommonPrefix(['CP 匯出.xlsx', 'CP 匯出.xlsx（全文摘要）'])).toEqual([
      'CP 匯出.xlsx',
      'CP 匯出.xlsx（全文摘要）',
    ]);
  });
});

describe('sampleIndexForSuggestion', () => {
  it('chunk 數少於取樣上限時不重複取用同一 chunk', () => {
    const out = sampleIndexForSuggestion(
      makeIndex([
        { title: 'a', text: '第一段內容' },
        { title: 'b', text: '第二段內容' },
        { title: 'c', text: '第三段內容' },
      ]),
    );
    expect(out).toContain('第一段內容');
    expect(out).toContain('第二段內容');
    expect(out).toContain('第三段內容');
    expect(out.match(/第一段內容/g)).toHaveLength(1);
  });

  it('大量 chunk 時等距取樣，涵蓋頭中尾且不超過 10 筆', () => {
    // 斷言首尾皆命中（而非特定 stride 值反推出的中間索引）：
    // FAQ、聯絡方式這類最適合生成推薦問句的素材常落在文件尾端，取樣不能系統性地漏掉它。
    const chunks = Array.from({ length: 285 }, (_, i) => ({
      title: '1784768063225.html',
      text: `段落${i}`,
    }));
    const out = sampleIndexForSuggestion(makeIndex(chunks));
    expect(out).toContain('段落0');
    expect(out).toContain('段落284');
    expect(out.match(/段落\d+/g)?.length).toBeLessThanOrEqual(10);
  });

  it('單一 title（檔案來源）不輸出主題清單，仍從文字取得素材', () => {
    const chunks = Array.from({ length: 20 }, (_, i) => ({
      title: 'report.pdf',
      text: `內文${i}`,
    }));
    const out = sampleIndexForSuggestion(makeIndex(chunks));
    expect(out).not.toContain('主題清單');
    expect(out).toContain('內容摘錄');
  });

  it('索引為空時回空字串', () => {
    expect(sampleIndexForSuggestion(makeIndex([]))).toBe('');
  });

  it('輸出裁切至 2000 字元上限', () => {
    const chunks = Array.from({ length: 50 }, (_, i) => ({
      title: `主題${i}`,
      text: 'x'.repeat(500),
    }));
    expect(sampleIndexForSuggestion(makeIndex(chunks)).length).toBeLessThanOrEqual(2000);
  });
});

describe('parseSuggestion', () => {
  it('接受合法 JSON 並 trim', () => {
    expect(parseSuggestion('{"zh-Hant":" 補助怎麼申請？ ","en":" How to apply? "}')).toEqual({
      ok: true,
      prompts: { 'zh-Hant': '補助怎麼申請？', en: 'How to apply?' },
    });
  });

  it('容忍 JSON 前後的額外文字', () => {
    expect(parseSuggestion('好的：\n{"zh-Hant":"補助怎麼申請？","en":"How to apply?"}\n')).toEqual({
      ok: true,
      prompts: { 'zh-Hant': '補助怎麼申請？', en: 'How to apply?' },
    });
  });

  it('壞 JSON 回 ok: false', () => {
    expect(parseSuggestion('not json at all').ok).toBe(false);
    expect(parseSuggestion('{"zh-Hant":').ok).toBe(false);
  });

  it('缺 key 或空字串回 ok: false', () => {
    expect(parseSuggestion('{"zh-Hant":"補助怎麼申請？"}').ok).toBe(false);
    expect(parseSuggestion('{"zh-Hant":"","en":"How to apply?"}').ok).toBe(false);
  });

  // 用常數推導而非寫死字數：上限依 widget chip 容量調整過一次，寫死的假資料會靜默失效
  it('zh 超過上限回 ok: false，剛好等於上限則通過', () => {
    expect(parseSuggestion(`{"zh-Hant":"${'字'.repeat(MAX_ZH_CHARS + 1)}","en":"ok"}`).ok).toBe(false);
    expect(parseSuggestion(`{"zh-Hant":"${'字'.repeat(MAX_ZH_CHARS)}","en":"ok"}`).ok).toBe(true);
  });

  it('en 超過 12 個單字回 ok: false', () => {
    const long = Array.from({ length: 13 }, (_, i) => `w${i}`).join(' ');
    expect(parseSuggestion(`{"zh-Hant":"短句","en":"${long}"}`).ok).toBe(false);
  });
});

/**
 * 兩種來源餵給模型的素材品質必須對等。
 *
 * 檔案來源的推薦詞實測「時好時壞」而網站來源穩定，差別就在主題清單：網站有多個
 * 頁面標題，檔案卻只有一行「（全文摘要）」，模型只能靠內容摘錄裡那段全文摘要碰運氣。
 */
describe('檔案來源的主題清單必須帶得出檔名', () => {
  const NAME = 'CP 匯出.xlsx';
  const fileChunks = [
    ...Array.from({ length: 30 }, (_, i) => ({
      title: NAME,
      text: `2019 台灣 ${i} 人次 日本 ${i * 2} 人次`,
    })),
    { title: `${NAME}（全文摘要）`, text: '本檔為台北國際電腦展歷年參觀者統計。' },
  ];

  it('素材含檔名，且不會出現只剩後綴的假主題', () => {
    const out = sampleIndexForSuggestion(makeIndex(fileChunks));

    expect(out).toContain(NAME);
    expect(out).not.toContain('- （全文摘要）');
  });

  it('網站來源不受影響，仍剝掉站名麵包屑只留頁名', () => {
    const out = sampleIndexForSuggestion(
      makeIndex([
        { title: '凌網科技 › 智慧閱讀', text: '智慧閱讀的說明' },
        { title: '凌網科技 › 數位典藏', text: '數位典藏的說明' },
        { title: '凌網科技', text: '首頁' },
      ]),
    );

    expect(out).toContain('- 智慧閱讀');
    expect(out).toContain('- 數位典藏');
    expect(out).not.toContain('凌網科技 ›');
  });
});

/**
 * 全文摘要的待遇：它是入庫時請模型讀完整份檔案產生的 150~250 字鳥瞰，訊號密度遠高於
 * 任何一段原文片段。原本它和其他摘錄一樣被砍到 150 字、又混在等距抽樣的十段之中——
 * 表格類檔案那十段長得幾乎一樣，等於整份素材只有十分之一有主題訊息，還被砍掉四成。
 * 實測結果就是檔案來源的推薦詞比網站來源難生成得多。
 */
describe('全文摘要在素材中的待遇', () => {
  const NAME = 'CP 匯出.xlsx';
  /** 250 字摘要（實際上限），用來驗證不再被 150 字上限截斷 */
  const SUMMARY = '本檔為台北國際電腦展歷年參觀者統計，'.repeat(2)
    + '涵蓋各年度來台參觀人次與國別拆分，並含年度成長率與專業買主佔比欄位。'.repeat(3);
  const fileIndex = makeIndex([
    ...Array.from({ length: 30 }, (_, i) => ({
      id: `f-${i}`, title: NAME, text: `2019 台灣 ${i} 人次 日本 ${i * 2} 人次`,
    })),
    { id: 'f-summary', title: `${NAME}（全文摘要）`, text: SUMMARY },
  ]);

  it('獨立成段，且不被原文摘錄的 150 字上限截斷', () => {
    const out = sampleIndexForSuggestion(fileIndex);

    expect(out).toContain('文件摘要：');
    expect(out).toContain(SUMMARY.slice(0, 300));
  });

  it('排在最前面——尾端裁切時訊號最強的一段不能先被砍掉', () => {
    const out = sampleIndexForSuggestion(fileIndex);

    expect(out.indexOf('文件摘要：')).toBe(0);
  });

  /*
   * 等距抽樣的最後一筆恆為 index n-1，而摘要就排在最後。不排除它就會重複出現，
   * 第二次還被砍成半句，白白佔掉十段摘錄裡的一格。
   */
  it('不重複出現在內容摘錄裡', () => {
    const out = sampleIndexForSuggestion(fileIndex);

    const excerpts = out.slice(out.indexOf('內容摘錄：'));
    expect(excerpts).not.toContain(SUMMARY.slice(0, 50));
  });

  it('只有摘要 chunk 的索引仍取得素材，不會因排除而變空', () => {
    const out = sampleIndexForSuggestion(makeIndex([{ id: 'f-summary', title: NAME, text: SUMMARY }]));

    expect(out).toContain('文件摘要：');
    expect(out).not.toBe('');
  });

  it('網站來源沒有摘要 chunk，不輸出文件摘要段', () => {
    const out = sampleIndexForSuggestion(
      makeIndex([
        { id: 'abc123def456-0', title: '凌網科技 › 智慧閱讀', text: '智慧閱讀的說明' },
        { id: 'abc123def456-1', title: '凌網科技 › 數位典藏', text: '數位典藏的說明' },
      ]),
    );

    expect(out).not.toContain('文件摘要：');
    expect(out).toContain('主題清單：');
  });
});
