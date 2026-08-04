/**
 * 推薦問句的抽樣與輸出驗證（純函式）。
 *
 * 抽樣策略經實測修正：原擬依 title 出現次數排序，但檔案來源的 title 是檔名（零訊號）、
 * 網站來源次數幾乎全為 1（排序等同隨機）。改為等距取文字 ＋ 剝除共同前綴後的 title 清單。
 */
import {
  parseSuggestion,
  sampleIndexForSuggestion,
  stripCommonPrefix,
} from '@/modules/knowledge/knowledge.suggest';
import type { KnowledgeIndexFile } from '@/modules/knowledge/knowledge-index.types';

function makeIndex(chunks: { title: string; text: string }[]): KnowledgeIndexFile {
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

  it('zh 超過 20 字元回 ok: false', () => {
    expect(parseSuggestion(`{"zh-Hant":"${'字'.repeat(21)}","en":"ok"}`).ok).toBe(false);
  });

  it('en 超過 12 個單字回 ok: false', () => {
    const long = Array.from({ length: 13 }, (_, i) => `w${i}`).join(' ');
    expect(parseSuggestion(`{"zh-Hant":"短句","en":"${long}"}`).ok).toBe(false);
  });
});
