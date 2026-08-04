/**
 * 依索引內容生成 widget 開場推薦問句。
 *
 * 生成時機為索引異動（爬取完成／上傳／刪檔），結果快取進 KnowledgeIndexMeta，
 * widget 載入時直接讀快取、零延遲。生成失敗一律不寫入，前端就不顯示推薦 chip。
 *
 * 抽樣不做任何排名，只保證覆蓋度：索引來源有兩種形狀，檔案來源的 title 是檔名（零訊號）、
 * 網站來源的 title 資訊豐富但出現次數幾乎全為 1（依次數排序等同隨機），故次數不可用。
 */
import { env } from '@/config/env';
import { getLLMProvider } from '@/lib/llm';
import { logger } from '@/lib/logger';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { usageStore } from '@/modules/usage/usage.store';
import type { KnowledgeIndexFile } from './knowledge-index.types';
import { knowledgeStore } from './knowledge.store';
import type { SuggestedPrompts } from './knowledge.store';

const MAX_TEXT_SAMPLES = 10;
const TEXT_CHARS = 150;
const MAX_TITLES = 20;
const MAX_TOTAL_CHARS = 2000;
const MAX_ZH_CHARS = 20;
const MAX_EN_WORDS = 12;

/** 剝除 title 的共同前綴（網站來源的站名麵包屑）；剝完為空者丟棄 */
export function stripCommonPrefix(titles: string[]): string[] {
  // 單一 title 的共同前綴即其自身，剝除會全空；直接原樣返回
  if (titles.length < 2) return titles;

  let prefixLen = 0;
  const first = titles[0];
  outer: for (; prefixLen < first.length; prefixLen++) {
    const ch = first[prefixLen];
    for (const t of titles) {
      if (t[prefixLen] !== ch) break outer;
    }
  }
  if (prefixLen === 0) return titles;

  return titles
    // 共同前綴可能落在分隔符之前（如剝到「凌網資訊」而留下「 › 智慧閱讀」），一併清掉開頭分隔符
    .map((t) => t.slice(prefixLen).replace(/^[\s›>|/\\\-–—:：]+/, '').trim())
    .filter(Boolean);
}

/** 從索引抽出餵給 LLM 的素材：等距文字摘錄 ＋（多 title 時）主題清單 */
export function sampleIndexForSuggestion(idx: KnowledgeIndexFile): string {
  const chunks = idx.chunks;
  if (chunks.length === 0) return '';

  // 首尾皆含的等距抽樣：FAQ、常見問題、聯絡方式這類最適合生成推薦問句的素材常落在文件尾端，
  // 若跨距只從 0 起跳（stride = n/MAX），最後一筆恆為 (MAX-1)*stride，永遠碰不到 index n-1。
  // 改用「第 k 筆 = floor(k * (n-1) / (count-1))」，第一筆必為 0、最後一筆必為 n-1。
  const count = Math.min(chunks.length, MAX_TEXT_SAMPLES);
  const samples: string[] = [];
  for (let k = 0; k < count; k++) {
    const i = count === 1 ? 0 : Math.floor((k * (chunks.length - 1)) / (count - 1));
    const text = chunks[i].text.trim().slice(0, TEXT_CHARS);
    if (text) samples.push(text);
  }

  const distinct = [...new Set(chunks.map((c) => c.title).filter(Boolean))];
  const topics = distinct.length > 1 ? stripCommonPrefix(distinct).slice(0, MAX_TITLES) : [];

  const parts: string[] = [];
  if (topics.length > 0) parts.push(`主題清單：\n${topics.map((t) => `- ${t}`).join('\n')}`);
  if (samples.length > 0) parts.push(`內容摘錄：\n${samples.map((s) => `- ${s}`).join('\n')}`);
  return parts.join('\n\n').slice(0, MAX_TOTAL_CHARS);
}

export const SUGGESTION_SYSTEM_PROMPT = `你要為一個網站客服機器人產生「開場推薦問句」。
使用者訊息是該網站知識庫的主題清單與內容摘錄。請產生一句訪客最可能想問、且這份知識庫確實答得出來的問句。

規則：
- 必須是訪客會實際輸入的口語問句，不是標題或條列的改寫
- 必須具體指向這份知識庫的內容。禁止「有哪些產品或服務」「相關規定為何」這類換成任何組織都成立的泛問
- 繁體中文版 ${MAX_ZH_CHARS} 個字元以內；英文版 ${MAX_EN_WORDS} 個單字以內，兩者語意一致
- 只輸出 JSON，不要有其他文字：
{"zh-Hant":"...","en":"..."}`;

/** 驗證 LLM 輸出；任一項不合即整筆丟棄（回 undefined），呼叫端不寫入、前端不顯示 chip */
export function parseSuggestion(text: string): SuggestedPrompts | undefined {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;

  const obj = parsed as Record<string, unknown>;
  const zh = typeof obj['zh-Hant'] === 'string' ? obj['zh-Hant'].trim() : '';
  const en = typeof obj.en === 'string' ? obj.en.trim() : '';
  if (!zh || !en) return undefined;
  if (zh.length > MAX_ZH_CHARS) return undefined;
  if (en.split(/\s+/).length > MAX_EN_WORDS) return undefined;

  return { 'zh-Hant': zh, en };
}

/**
 * per-tenant 世代編號：refresh 呼叫可能重疊（爬取/上傳/刪檔可連續觸發），且不保證
 * resolve 順序與發動順序一致。用世代編號讓「較晚發動」的呼叫永遠贏——寫入前若發現
 * 自己的世代已被更晚發動的呼叫超越，一律放棄寫入，避免舊呼叫用過期內容（甚至已刪除
 * 的內容）覆蓋新呼叫剛寫入、或剛清空的結果。
 */
const generations = new Map<string, number>();

/** 遞增並回傳該租戶的最新世代編號；呼叫本身即代表「這是目前最新一次 refresh」 */
function beginGeneration(tenantId: string): number {
  const gen = (generations.get(tenantId) ?? 0) + 1;
  generations.set(tenantId, gen);
  return gen;
}

/** 判斷 gen 是否仍是該租戶目前最新的一次呼叫；不是即代表這次呼叫已過期 */
function isLatestGeneration(tenantId: string, gen: number): boolean {
  return generations.get(tenantId) === gen;
}

/**
 * 重新生成某租戶的推薦問句並寫回 meta。
 *
 * 永不 reject：呼叫端一律以 `void refreshSuggestedPrompts(...)` 觸發，
 * 任何失敗（含 store 讀寫拋錯）都不得影響索引本身的狀態，故整個函式體都在
 * try/catch 保護內。
 */
export async function refreshSuggestedPrompts(
  tenantId: string,
  idx: KnowledgeIndexFile,
): Promise<void> {
  const gen = beginGeneration(tenantId);

  try {
    // 索引已空：清除舊句，不留下指向已刪內容的問句。
    // 這段沒有 await，同步執行完畢前不可能有其他呼叫插入，故世代必為最新，
    // 不需再檢查；此呼叫遞增的世代會讓「更早發動、還在 await 中」的舊呼叫
    // 之後寫入時被判定過期。
    if (idx.chunks.length === 0) {
      const meta = knowledgeStore.getMeta(tenantId);
      if (meta.suggestedPrompts) {
        const { suggestedPrompts: _drop, ...rest } = meta;
        knowledgeStore.setMeta(tenantId, rest);
      }
      return;
    }

    const material = sampleIndexForSuggestion(idx);
    // chunks 非空，但每筆文字 trim 後皆為空白、且沒有多個相異 title 可用時
    // （例如僅含空白內容的頁面、且與其他 chunk 同 title），抽樣素材會是空字串——
    // 沒有可餵給 LLM 的內容，直接放棄，不視為錯誤
    if (!material) return;

    const result = await getLLMProvider(
      tenantStore.getTenant(tenantId)?.llmConfig,
    ).createMessage({
      system: SUGGESTION_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: material }] }],
      // 與 intent-router、rerank 同級的輔助任務，用 Haiku 即可；
      // 租戶鎖定自有 provider 時，provider 內的 pickModel 會自動忽略此覆寫
      model: env.LLM_ROUTER_MODEL,
      maxTokens: 200,
    });
    usageStore.recordLLMUsage(tenantId, result);

    const prompts = parseSuggestion(result.text);
    if (!prompts) {
      logger.warn(
        { tenantId, text: result.text.slice(0, 200) },
        'suggested prompt 驗證未過，不寫入',
      );
      return;
    }

    // 世代防護：await 期間可能有更晚發動的呼叫（含清空）已經完成，此時這次的結果
    // 已過期（可能指向已刪內容，或被更新的生成蓋過），一律放棄寫入
    if (!isLatestGeneration(tenantId, gen)) {
      logger.warn({ tenantId }, 'suggested prompt 生成期間已有更新的呼叫，放棄過期寫入');
      return;
    }

    // setMeta 是整包覆蓋：await 期間 meta 可能已被其他寫入更新（如使用者刪檔），必須重讀
    knowledgeStore.setMeta(tenantId, {
      ...knowledgeStore.getMeta(tenantId),
      suggestedPrompts: prompts,
    });
  } catch (err) {
    logger.warn({ err, tenantId }, 'suggested prompt 生成失敗，不寫入');
  }
}
