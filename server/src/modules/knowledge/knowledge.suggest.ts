/**
 * 依索引內容生成 widget 開場推薦問句，依來源（網站／檔案）分兩格獨立生成。
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
import { aclModeOf, guestVisibilityScopesOf } from './knowledge.visibility';
// KnowledgeIndexText（不含向量）而非 KnowledgeIndexFile：本模組只讀 text/title/fileId，
// 收窄型別讓呼叫端可以省下整份向量的傳輸；完整索引仍可直接指派進來
import type { ChunkText, KnowledgeIndexText } from './knowledge-index.types';
import { knowledgeStore } from './knowledge.store';
import type { SuggestedPrompts } from './knowledge.store';
import {
  SOURCE_KEYS,
  splitChunksBySource,
  type PromptSlot,
  type SourceKey,
  type SuggestedPromptSlots,
} from './prompt-slots';

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

/**
 * 推薦問句的語料只能取「訪客看得到」的 chunk。
 *
 * refreshSuggestedPrompts 的結果是每租戶單一份、寫進 meta.suggestedPrompts，
 * 而 GET /api/widget/config 不掛 requireAuth——任何拿到 pk_ 的人都讀得到。
 * 未標記（undefined）＝待辦、[]＝明確標成誰都不能看，兩者都不該貢獻語料；
 * 標了非公開標籤（與訪客可見範圍無交集）的 chunk 同樣不該貢獻——即使檔案本身
 * 查不到內容，主題／檔名式樣的句子（如「想了解 2026 年組織調整的適用範圍嗎？」）
 * 本身就是存在性外洩。acl=off 時沿用導入前行為（不過濾，因為那時所有內容本來就
 * 該對所有人一視同仁）；shadow 也要過濾——這裡外洩的是另一個管道（開場推薦問句），
 * 不是「shadow 不影響使用者」原則要保護的主要問答路徑。
 */
export function filterGuestVisibleChunks(chunks: ChunkText[], guestScopes: string[]): ChunkText[] {
  if (guestScopes.length === 0) return [];
  const allowed = new Set(guestScopes);
  return chunks.filter((c) => (c.visibilityScopes ?? []).some((s) => allowed.has(s)));
}

/** 從索引抽出餵給 LLM 的素材：等距文字摘錄 ＋（多 title 時）主題清單 */
export function sampleIndexForSuggestion(idx: KnowledgeIndexText): string {
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

/** 驗證結果：不合格時帶原因，供重試時回饋給模型 */
export type ParseResult =
  | { ok: true; prompts: SuggestedPrompts }
  | { ok: false; reason: string };

/** 驗證 LLM 輸出；任一項不合即整筆丟棄並回報原因 */
export function parseSuggestion(text: string): ParseResult {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { ok: false, reason: '不是合法 JSON，輸出必須只有一個 JSON 物件' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return { ok: false, reason: '不是合法 JSON，輸出必須只有一個 JSON 物件' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, reason: '不是合法 JSON 物件' };
  }

  const obj = parsed as Record<string, unknown>;
  const zh = typeof obj['zh-Hant'] === 'string' ? obj['zh-Hant'].trim() : '';
  const en = typeof obj.en === 'string' ? obj.en.trim() : '';
  if (!zh || !en) return { ok: false, reason: 'zh-Hant 與 en 兩個欄位都必須有值' };
  if (zh.length > MAX_ZH_CHARS) {
    return { ok: false, reason: `繁體中文超過 ${MAX_ZH_CHARS} 個字元（實際 ${zh.length} 個），請縮短` };
  }
  if (en.split(/\s+/).length > MAX_EN_WORDS) {
    return { ok: false, reason: `英文超過 ${MAX_EN_WORDS} 個單字，請縮短` };
  }

  return { ok: true, prompts: { 'zh-Hant': zh, en } };
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
 * 呼叫 LLM 生成一句並驗證；驗證未過時把原因回饋給模型再試一次。
 * 兩次都不過回 undefined（該格不寫入）。
 */
async function generateOne(tenantId: string, material: string): Promise<SuggestedPrompts | undefined> {
  let text = material;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await getLLMProvider(tenantStore.getTenant(tenantId)?.llmConfig).createMessage({
      system: SUGGESTION_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      // 與 intent-router、rerank 同級的輔助任務，用 Haiku 即可；
      // 租戶鎖定自有 provider 時，provider 內的 pickModel 會自動忽略此覆寫
      model: env.LLM_ROUTER_MODEL,
      maxTokens: 200,
    });
    usageStore.recordLLMUsage(tenantId, result);

    const parsed = parseSuggestion(result.text);
    if (parsed.ok) return parsed.prompts;

    logger.warn(
      { tenantId, attempt, reason: parsed.reason, text: result.text.slice(0, 200) },
      'suggested prompt 驗證未過',
    );
    if (attempt === 2) return undefined;
    text = `${material}\n\n上一次的輸出不合格：${parsed.reason}。請重新輸出。`;
  }
  return undefined;
}

/**
 * 重新生成某租戶的推薦問句並寫回 meta，依來源分兩格各自獨立生成。
 *
 * 永不 reject：索引異動端一律以 `void refreshSuggestedPrompts(...)` 觸發，
 * 任何失敗（含 store 讀寫拋錯）都不得影響索引本身的狀態，故整個函式體都在
 * try/catch 保護內。
 *
 * 回傳「這次實際寫入的格位」，沒寫入則為 undefined。後台的手動重新生成需要據此
 * 分辨成功與失敗——只看 meta 分不出來：失敗時 meta 會留著上一次的舊句，
 * 看起來就像剛生成成功。
 *
 * manual 的寫回一律以「動作完成當刻」的最新值為準，不沿用 await 前讀到的快照：
 * 這支函式的兩次 LLM 呼叫本身就要等（秒級），若寫回時還照 await 前那份舊快照組出
 * 整包覆蓋，管理者剛好在這段等待期間用 setSuggestionManual 設定或清除 manual，
 * 結果會被這裡晚到的寫入悄悄蓋掉——PUT 當下回 200、讀回也正確，數秒後才消失，
 * 且完全不觸發世代防護（manual 寫入不遞增世代）。本函式的權責只有 generated：
 * 有新生成結果就用新的，生成略過或失敗就沿用舊的；manual 永遠交給寫回那一刻的
 * 最新 meta 決定，即使該來源同時被判定內容已清空（generated 因此清除）也一樣。
 */
export async function refreshSuggestedPrompts(
  tenantId: string,
  idx: KnowledgeIndexText,
): Promise<SuggestedPromptSlots | undefined> {
  const gen = beginGeneration(tenantId);

  try {
    const bySource = splitChunksBySource(idx.chunks);
    const current = knowledgeStore.getMeta(tenantId).suggestedPrompts ?? {};
    // 推薦問句經免登入的 GET /api/widget/config 送給任何拿到 pk_ 的訪客；acl=off 沿用
    // 導入前行為（不過濾），off 以外（含 shadow）一律只用訪客看得到的 chunk 當語料——
    // 見 filterGuestVisibleChunks 註解。
    const mode = aclModeOf(tenantId);
    const guestScopes = mode === 'off' ? [] : guestVisibilityScopesOf(tenantId);

    // 逐格決定該格「generated」的新內容；兩格併發，彼此不影響。
    // 這裡只決定 generated，manual 留給 await 之後重讀 meta 時才決定，見下方函式註解。
    const entries = await Promise.all(
      SOURCE_KEYS.map(async (key: SourceKey) => {
        const slot = current[key] ?? {};
        // 手動鎖定：整格跳過，不呼叫 LLM（生成了也用不到）——沿用舊的 generated 即可
        if (slot.manual) return [key, slot.generated] as const;
        const rawChunks = bySource[key];
        const chunks = mode === 'off' ? rawChunks : filterGuestVisibleChunks(rawChunks, guestScopes);
        // 該來源已無「訪客看得到」的內容：清掉 generated，不留指向已隱藏內容的句子
        // ——包含「有內容但全部未標記／非公開」與「本來就沒內容」兩種情況。
        if (chunks.length === 0) return [key, undefined] as const;
        const material = sampleIndexForSuggestion({ ...idx, chunks });
        // 抽樣素材為空（chunks 皆空白）：不視為錯誤，維持原樣
        if (!material) return [key, slot.generated] as const;
        const generated = await generateOne(tenantId, material);
        // 生成失敗（undefined）：沿用舊的，不因這次失敗而清空
        return [key, generated ?? slot.generated] as const;
      }),
    );

    // 世代防護：await 期間若有更晚發動的呼叫（含清空）已完成，這批結果已過期
    if (!isLatestGeneration(tenantId, gen)) {
      logger.warn({ tenantId }, 'suggested prompt 生成期間已有更新的呼叫，放棄過期寫入');
      return undefined;
    }

    // setMeta 是整包覆蓋：await 期間 meta 可能已被其他寫入更新（如使用者刪檔、
    // 或管理者剛設定的 manual），必須重讀。manual 一律取這份最新值，不用 await 前的 current。
    const latestMeta = knowledgeStore.getMeta(tenantId);
    const latestSlots = latestMeta.suggestedPrompts ?? {};

    const next: SuggestedPromptSlots = {};
    for (const [key, generated] of entries) {
      const manual = latestSlots[key]?.manual;
      const slot: PromptSlot = {};
      if (generated) slot.generated = generated;
      if (manual) slot.manual = manual;
      if (slot.generated || slot.manual) next[key] = slot;
    }
    const hasAny = SOURCE_KEYS.some((k) => next[k]);
    knowledgeStore.setMeta(tenantId, {
      ...latestMeta,
      suggestedPrompts: hasAny ? next : undefined,
    });
    return hasAny ? next : undefined;
  } catch (err) {
    logger.warn({ err, tenantId }, 'suggested prompt 生成失敗，不寫入');
    return undefined;
  }
}

/**
 * 只重新生成指定來源那一格（後台按鈕用）。
 *
 * 與 refreshSuggestedPrompts 的差別：不理會 manual 鎖定——按鈕的語意是「重生自動句」，
 * 手動值仍蓋在它上面，直到管理者按恢復自動。該來源無內容時回 undefined 由呼叫端擋。
 */
export async function regenerateSlot(
  tenantId: string,
  source: SourceKey,
  idx: KnowledgeIndexText,
): Promise<SuggestedPrompts | undefined> {
  const gen = beginGeneration(tenantId);
  try {
    const chunks = splitChunksBySource(idx.chunks)[source];
    if (chunks.length === 0) return undefined;
    const material = sampleIndexForSuggestion({ ...idx, chunks });
    if (!material) return undefined;

    const generated = await generateOne(tenantId, material);
    if (!generated) return undefined;
    if (!isLatestGeneration(tenantId, gen)) {
      logger.warn({ tenantId }, 'suggested prompt 單格重生期間已有更新的呼叫，放棄過期寫入');
      return undefined;
    }

    const meta = knowledgeStore.getMeta(tenantId);
    const slots = { ...(meta.suggestedPrompts ?? {}) };
    slots[source] = { ...(slots[source] ?? {}), generated };
    knowledgeStore.setMeta(tenantId, { ...meta, suggestedPrompts: slots });
    return generated;
  } catch (err) {
    logger.warn({ err, tenantId, source }, 'suggested prompt 單格重生失敗');
    return undefined;
  }
}
