import { promptAclFingerprint } from './prompt-visibility';
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
import { guestVisibilityScopesOf, currentChunkScopes } from './knowledge.visibility';
// KnowledgeIndexText（不含向量）而非 KnowledgeIndexFile：本模組只讀 text/title/fileId，
// 收窄型別讓呼叫端可以省下整份向量的傳輸；完整索引仍可直接指派進來
import { isSummaryChunk, type ChunkText, type KnowledgeIndexText } from './knowledge-index.types';
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
/**
 * 全文摘要的字數配額。
 *
 * 摘要是入庫時請模型讀完整份檔案產生的 150~250 字鳥瞰（見 knowledge-file.service
 * 的 summarizeText），對「這份文件在講什麼」的訊號密度遠高於任何一段原文片段。
 * 原本它和其他摘錄一樣被 TEXT_CHARS 砍到 150 字、又混在等距抽樣的九段之中——
 * 表格類檔案（如各年度參觀人次的 xlsx）那九段長得幾乎一樣，等於整份素材只有
 * 十分之一有主題訊息，還被砍掉四成。提高上限並獨立成段，讓它不必和原文片段搶版面。
 */
const SUMMARY_CHARS = 400;
/** 回報給管理者的模型輸出擷取長度：夠看出哪裡不合格，又不至於把整段素材倒進錯誤訊息 */
const OUTPUT_ECHO_CHARS = 120;
const MAX_TITLES = 20;
const MAX_TOTAL_CHARS = 2000;
const MAX_ZH_CHARS = 20;
const MAX_EN_WORDS = 12;

/**
 * 生成嘗試次數。
 *
 * 驗證門檻很窄（中文 20 字元以內，又要求具體指向這份知識庫——光是「台北國際電腦展」
 * 這種專有名詞就佔掉 7 個字），模型的輸出長度本來就會在這條線附近擺盪。原本只試兩次，
 * 實際表現是同一份索引「有時成功有時失敗」，而失敗回的是可重試的 generation-failed，
 * 等於把重試的責任丟給管理者手動按按鈕。一次 Haiku 呼叫約兩百個 token，多試兩輪的
 * 成本遠低於讓人重按。
 */
const MAX_GENERATE_ATTEMPTS = 4;

/**
 * 推薦問句的取樣溫度。
 *
 * 不帶此參數時走 provider 預設（Anthropic 為 1.0），對這種「答案空間很窄、又有硬性
 * 長度上限」的任務只會製造無謂的失敗。壓低到 0.4 讓輸出集中在合格區間，但不設 0——
 * 重試時需要模型真的換一句寫法，完全確定性的輸出會讓後續嘗試全部複製第一次的失敗。
 */
const SUGGESTION_TEMPERATURE = 0.4;

/**
 * 剝除 title 的共同前綴（網站來源的站名麵包屑）；剝完為空者丟棄。
 *
 * 前提是「共同前綴是麵包屑，剝掉後每個 title 仍留有自己的部分」。檔案來源不成立：
 * 同一份檔案的 chunk title 全是檔名，只有全文摘要那筆是「<檔名>（全文摘要）」——
 * 共同前綴會等於整個檔名，剝完第一個變空字串被丟棄，主題清單只剩「（全文摘要）」。
 * 模型於是被告知這個知識庫的主題叫「（全文摘要）」，檔名這個唯一的高價值訊號反而消失，
 * 只能靠內容摘錄裡那段全文摘要碰運氣——實測就是檔案來源的推薦詞時好時壞，
 * 而標題豐富的網站來源穩定得多。
 *
 * 判準不是「有沒有 title 被剝空」——網站來源的首頁 title 就是站名本身，剝完也是空的，
 * 但那批剝完仍剩多個有意義的主題，丟掉首頁那筆是對的。判準是「剝完還剩幾個」：
 * 少於兩個就代表這串 title 的差異不足以構成主題清單，原樣返回比剝完更有訊息量。
 */
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

  const stripped = titles
    // 共同前綴可能落在分隔符之前（如剝到「凌網資訊」而留下「 › 智慧閱讀」），一併清掉開頭分隔符
    .map((t) => t.slice(prefixLen).replace(/^[\s›>|/\\\-–—:：]+/, '').trim())
    .filter(Boolean);
  // 剝完不足兩個：前綴吃掉的是標題本身而非麵包屑，原樣返回才保得住訊號（如檔名）
  return stripped.length < 2 ? titles : stripped;
}

/**
 * 推薦問句的語料只能取「訪客看得到」的 chunk。
 *
 * refreshSuggestedPrompts 的結果是每租戶單一份、寫進 meta.suggestedPrompts，
 * 而 GET /api/widget/config 不掛 requireAuth——任何拿到 pk_ 的人都讀得到。
 * 未標記（undefined）＝待辦、[]＝明確標成誰都不能看，兩者都不該貢獻語料；
 * 標了非公開標籤（與訪客可見範圍無交集）的 chunk 同樣不該貢獻——即使檔案本身
 * 查不到內容，主題／檔名式樣的句子（如「想了解 2026 年組織調整的適用範圍嗎？」）
 * 本身就是存在性外洩。
 */
export function filterGuestVisibleChunks(chunks: ChunkText[], guestScopes: string[]): ChunkText[] {
  if (guestScopes.length === 0) return [];
  const allowed = new Set(guestScopes);
  return chunks.filter((c) => (c.visibilityScopes ?? []).some((s) => allowed.has(s)));
}

/**
 * 從索引抽出餵給 LLM 的素材：全文摘要 ＋ 等距文字摘錄 ＋（多 title 時）主題清單。
 *
 * 三者的訊號密度差很多，故分成三段各給各的配額，而不是混成一串等權重的條列。
 */
export function sampleIndexForSuggestion(idx: KnowledgeIndexText): string {
  if (idx.chunks.length === 0) return '';

  // 全文摘要獨立成段：它是整份檔案的鳥瞰，不該和原文片段一起參加等距抽樣。
  // 等距抽樣的最後一筆恆為 index n-1，而摘要就排在最後，不排除就會重複出現一次
  // ——第二次還被 TEXT_CHARS 砍成半句，佔掉十段摘錄裡的一格。
  const summaries = idx.chunks
    .filter(isSummaryChunk)
    .map((c) => c.text.trim().slice(0, SUMMARY_CHARS))
    .filter(Boolean);
  // 摘要已另段呈現，原文摘錄只從非摘要 chunk 取；全空時退回全部，避免只有摘要的索引取不到素材
  const bodyChunks = idx.chunks.filter((c) => !isSummaryChunk(c));
  const chunks = bodyChunks.length > 0 ? bodyChunks : idx.chunks;

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
  // 摘要放最前面：MAX_TOTAL_CHARS 的裁切是從尾端砍，訊號最強的一段不能排在會被砍掉的位置
  if (summaries.length > 0) parts.push(`文件摘要：\n${summaries.join('\n\n')}`);
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
 * 生成一句的結果。失敗帶最後一次的不合格原因與模型當時的輸出。
 *
 * 先前只回 undefined，呼叫端一路降級成「推薦詞生成失敗，請稍後再試」——而 server
 * 其實逐次都知道確切原因（「繁體中文超過 20 個字元（實際 26 個）」之類），只寫進 log。
 * 管理者在後台看不到，只能重按或來問開發者，而這正是 e248c43 當初要解決的那個問題，
 * 當時只修到外層的四條失敗路徑，沒有往下修到「生成失敗」本身的原因。
 */
type GenerateOutcome =
  | { ok: true; prompts: SuggestedPrompts }
  | { ok: false; reason: string; output: string };

/**
 * 呼叫 LLM 生成一句並驗證；驗證未過時把原因回饋給模型再試，最多 MAX_GENERATE_ATTEMPTS 次。
 * 全部不過時回報最後一次的原因與輸出。
 */
async function generateOne(tenantId: string, material: string): Promise<GenerateOutcome> {
  let text = material;
  for (let attempt = 1; attempt <= MAX_GENERATE_ATTEMPTS; attempt++) {
    const result = await getLLMProvider(tenantStore.getTenant(tenantId)?.llmConfig).createMessage({
      system: SUGGESTION_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      // 與 intent-router、rerank 同級的輔助任務，用 Haiku 即可；
      // 租戶鎖定自有 provider 時，provider 內的 pickModel 會自動忽略此覆寫
      model: env.LLM_ROUTER_MODEL,
      maxTokens: 200,
      temperature: SUGGESTION_TEMPERATURE,
    });
    usageStore.recordLLMUsage(tenantId, result);

    const parsed = parseSuggestion(result.text);
    if (parsed.ok) return { ok: true, prompts: parsed.prompts };

    const output = result.text.trim().slice(0, OUTPUT_ECHO_CHARS);
    logger.warn(
      { tenantId, attempt, maxAttempts: MAX_GENERATE_ATTEMPTS, reason: parsed.reason, text: output },
      'suggested prompt 驗證未過',
    );
    if (attempt === MAX_GENERATE_ATTEMPTS) return { ok: false, reason: parsed.reason, output };
    text = `${material}\n\n上一次的輸出不合格：${parsed.reason}。請重新輸出。`;
  }
  // 迴圈必定在 MAX_GENERATE_ATTEMPTS 回合內 return；此行只為滿足型別檢查
  return { ok: false, reason: '未取得合格輸出', output: '' };
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
    const fingerprint = promptAclFingerprint(tenantId);
    const bySource = splitChunksBySource(idx.chunks);
    const current = knowledgeStore.getMeta(tenantId).suggestedPrompts ?? {};
    // 推薦問句經免登入的 GET /api/widget/config 送給任何拿到 pk_ 的訪客，
    // 一律只用訪客看得到的 chunk 當語料——見 filterGuestVisibleChunks 註解。
    const guestScopes = guestVisibilityScopesOf(tenantId);

    // 逐格決定該格「generated」的新內容；兩格併發，彼此不影響。
    // 這裡只決定 generated，manual 留給 await 之後重讀 meta 時才決定，見下方函式註解。
    const entries = await Promise.all(
      SOURCE_KEYS.map(async (key: SourceKey) => {
        const original = current[key] ?? {};
        const slot = knowledgeStore.getMeta(tenantId).generatedPromptAcl?.[key] === fingerprint
          ? original : { manual: original.manual };
        // 手動鎖定：整格跳過，不呼叫 LLM（生成了也用不到）——沿用舊的 generated 即可
        if (slot.manual) return [key, slot.generated] as const;
        const rawChunks = bySource[key];
        const chunks = filterGuestVisibleChunks(rawChunks.map((c) => ({ ...c, visibilityScopes: currentChunkScopes(tenantId, c) })), guestScopes);
        // 該來源已無「訪客看得到」的內容：清掉 generated，不留指向已隱藏內容的句子
        // ——包含「有內容但全部未標記／非公開」與「本來就沒內容」兩種情況。
        if (chunks.length === 0) return [key, undefined] as const;
        const material = sampleIndexForSuggestion({ ...idx, chunks });
        // 抽樣素材為空（chunks 皆空白）：不視為錯誤，維持原樣
        if (!material) return [key, slot.generated] as const;
        const outcome = await generateOne(tenantId, material);
        // 生成失敗：沿用舊的，不因這次失敗而清空。此路徑由索引異動自動觸發、無人在等，
        // 失敗原因留在 log 即可；需要據實回報的是管理者手動按的 regenerateSlot。
        return [key, outcome.ok ? outcome.prompts : slot.generated] as const;
      }),
    );

    // 世代防護：await 期間若有更晚發動的呼叫（含清空）已完成，這批結果已過期
    if (!isLatestGeneration(tenantId, gen) || fingerprint !== promptAclFingerprint(tenantId)) {
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
      generatedPromptAcl: Object.fromEntries(entries.filter(([, generated]) => generated).map(([key]) => [key, fingerprint])),
    });
    return hasAny ? next : undefined;
  } catch (err) {
    logger.warn({ err, tenantId }, 'suggested prompt 生成失敗，不寫入');
    return undefined;
  }
}

/**
 * 單格重生的結果。失敗一律帶原因：這支函式有四條互不相干的失敗路徑，其中
 * no-visible-chunks 重試永遠不會成功（要去標可見性），generation-failed 則值得重試。
 * 先前一律回 undefined，呼叫端只能給同一句「請稍後再試」，把「這裡永遠不會好」
 * 誤導成「再按一次看看」——正式環境實際踩過，管理者重匯知識庫數次仍卡住。
 */
export type RegenerateOutcome =
  | { ok: true; prompts: SuggestedPrompts }
  /** detail：generation-failed 專用的具體原因（哪一條驗證沒過、模型當時輸出什麼） */
  | { ok: false; reason: RegenerateFailure; detail?: string };

export type RegenerateFailure =
  /** ACL 過濾後語料為空：該來源有內容，但沒有一顆是訪客看得到的 */
  | 'no-visible-chunks'
  /** 抽樣素材為空白（chunk 文字都是空字串） */
  | 'blank-material'
  /** LLM 呼叫失敗或輸出不合格 */
  | 'generation-failed'
  /** 生成期間有更晚的呼叫完成，本次結果已過期 */
  | 'superseded';

/**
 * 只重新生成指定來源那一格（後台按鈕用）。
 *
 * 與 refreshSuggestedPrompts 的差別：不理會 manual 鎖定——按鈕的語意是「重生自動句」，
 * 手動值仍蓋在它上面，直到管理者按恢復自動。該來源無內容時回失敗原因由呼叫端擋。
 *
 * 語料同樣要過濾：這格結果一樣是寫進 meta.suggestedPrompts、經免登入的
 * GET /api/widget/config 送給任何拿到 pk_ 的訪客，過濾規則與 refreshSuggestedPrompts
 * 完全一致——只用訪客看得到的 chunk 當語料，見 filterGuestVisibleChunks 註解。
 */
export async function regenerateSlot(
  tenantId: string,
  source: SourceKey,
  idx: KnowledgeIndexText,
): Promise<RegenerateOutcome> {
  const gen = beginGeneration(tenantId);
  try {
    const fingerprint = promptAclFingerprint(tenantId);
    const rawChunks = splitChunksBySource(idx.chunks)[source];
    const guestScopes = guestVisibilityScopesOf(tenantId);
    const chunks = filterGuestVisibleChunks(rawChunks.map((c) => ({ ...c, visibilityScopes: currentChunkScopes(tenantId, c) })), guestScopes);
    // 呼叫端已先擋掉「該來源根本沒有 chunk」，走到這裡為空只可能是 ACL 濾掉了全部
    if (chunks.length === 0) return { ok: false, reason: 'no-visible-chunks' };
    const material = sampleIndexForSuggestion({ ...idx, chunks });
    if (!material) return { ok: false, reason: 'blank-material' };

    const outcome = await generateOne(tenantId, material);
    if (!outcome.ok) {
      return {
        ok: false,
        reason: 'generation-failed',
        detail: `模型連續 ${MAX_GENERATE_ATTEMPTS} 次輸出不合格。最後一次：${outcome.reason}`
          + (outcome.output ? `（模型輸出：${outcome.output}）` : ''),
      };
    }
    const generated = outcome.prompts;
    if (!isLatestGeneration(tenantId, gen) || fingerprint !== promptAclFingerprint(tenantId)) {
      logger.warn({ tenantId }, 'suggested prompt 單格重生期間已有更新的呼叫，放棄過期寫入');
      return { ok: false, reason: 'superseded' };
    }

    const meta = knowledgeStore.getMeta(tenantId);
    const slots = { ...(meta.suggestedPrompts ?? {}) };
    slots[source] = { ...(slots[source] ?? {}), generated };
    knowledgeStore.setMeta(tenantId, { ...meta, suggestedPrompts: slots, generatedPromptAcl: { ...meta.generatedPromptAcl, [source]: fingerprint } });
    return { ok: true, prompts: generated };
  } catch (err) {
    logger.warn({ err, tenantId, source }, 'suggested prompt 單格重生失敗');
    return { ok: false, reason: 'generation-failed' };
  }
}
