/**
 * Knowledge Agent 服務（RAG）。
 *
 * sticky=false：屬「旁路」服務——回答後不奪走填表流程，且**不動 session 的 values / status**。
 * 檢索：依 DATA_BACKEND 選 pgvector 或靜態索引檔（見 pickRetriever），皆無索引時退回 stub FAQ（dev/測試）。
 * 作答：只把 top-k 片段交給 LLM 綜合成答案並附來源；整站內容永不進 LLM（省 token）。
 */
import { env } from '@/config/env';
import type { LLMMessage, LLMProvider } from '@/lib/llm/types';
import { logger } from '@/lib/logger';
import { normalizeLocale } from '@/lib/locale';
import { priorMessages, transcriptOf } from '@/modules/conversation/history';
import type {
  AgentService,
  AgentTurnResult,
  IntentDescriptor,
} from '@/modules/conversation/agent-service.types';
import type { Session } from '@/modules/conversation/conversation.types';
import { usageStore } from '@/modules/usage/usage.store';
import { rerankChunks } from './rerank';
import { hasPgvectorIndex, pgvectorRetriever } from './retriever.pgvector';
import { hasStaticIndex, staticIndexRetriever } from './retriever.staticIndex';
import { stubRetriever } from './retriever.stub';
import type { KnowledgeChunk, KnowledgeRetriever } from './retriever.types';

// 重排後交給作答 LLM 的最終片段數
const FINAL_K = 5;

/**
 * 帶入脈絡的歷史訊息數上限（約 3 輪問答）。
 * 夠解「那他們的完成日期呢」這類指代，又讓 input 大小有界——長對話不必要求使用者重開。
 */
const HISTORY_MESSAGES = 6;

/**
 * 指代改寫：把「那他們的完成日期呢」補成可獨立檢索的完整問句。
 *
 * 必須發生在檢索之前。檢索是拿問句本身去比對向量，指代句撈回來的是不相干的片段，
 * 讓模型帶著錯的參考資料作答，比誠實回答「查無資料」更糟。
 * 改寫失敗一律退回原句（fail-open），不讓這一步成為問答的單點故障。
 */
async function resolveQuery(
  session: Session,
  userText: string,
  llm: LLMProvider,
  history: LLMMessage[],
): Promise<string> {
  if (history.length === 0) return userText;
  try {
    const result = await llm.createMessage({
      system: [
        '你是查詢改寫器。依對話脈絡，把使用者最新的問題改寫成一句「可獨立理解」的完整問句。',
        '只補齊代名詞與省略的主詞／對象；嚴禁加入脈絡中沒有的條件、時間或臆測。',
        '最新問題本身已完整時，原句輸出。只輸出改寫後的問句，不要任何前後綴或說明。',
      ].join('\n'),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: `對話脈絡：\n${transcriptOf(history)}\n\n最新問題：${userText}` },
          ],
        },
      ],
      model: env.LLM_ROUTER_MODEL, // 指代改寫屬輔助任務，用便宜模型即可（同意圖分類器）
      maxTokens: 128,
    });
    usageStore.recordLLMUsage(session.tenantId, result);
    const rewritten = (result.text ?? '').replace(/\s+/g, ' ').trim();
    return rewritten || userText;
  } catch (err) {
    logger.warn({ err, sessionId: session.id }, 'query rewrite failed; falling back to raw text');
    return userText;
  }
}

const KB_KEYWORDS = [
  '規定',
  '政策',
  '辦法',
  '制度',
  '規章',
  'FAQ',
  '怎麼算',
  '如何申請',
  '資格',
  '條件',
  '說明',
  '產品',
  '方案',
  '服務',
  '介紹',
];

// 依 session locale 產生知識庫作答的 system prompt（英文 UI → 英文作答）。
function kbAnswerSystem(locale?: string): string {
  if (normalizeLocale(locale) === 'en') {
    return [
      'You are the company knowledge-base assistant. Respond entirely in English.',
      'Rules:',
      '- Answer ONLY from the "Reference" material below; for anything not covered, say "Not mentioned in the materials." Never fabricate.',
      '- "Previous conversation", if present, is only for resolving what the question refers to — never use it as a source of answers.',
      '- Be concise and directly on point; use bullet points when helpful.',
      '- When helpful, cite the source at the end as (Source: title).',
    ].join('\n');
  }
  return [
    '你是公司知識庫問答助理，全程使用繁體中文。',
    '規則：',
    '- 只根據下方「參考資料」回答；資料未提到的部分，明說「資料中未提及」，切勿杜撰。',
    '- 「先前對話」若有，僅用於理解本次問題在指涉什麼，不得作為答案來源。',
    '- 回答精簡、直接切中問題；必要時條列。',
    '- 若有幫助，於句末以（來源：標題）標註引用。',
  ].join('\n');
}

/**
 * 依持久化後端挑檢索器：db 走 pgvector、file 走靜態索引檔；
 * 兩者都沒有索引時退回 stub FAQ（dev/測試）。
 */
async function pickRetriever(tenantId: string): Promise<KnowledgeRetriever> {
  if (env.DATA_BACKEND === 'db') {
    return (await hasPgvectorIndex(tenantId)) ? pgvectorRetriever : stubRetriever;
  }
  return hasStaticIndex(tenantId) ? staticIndexRetriever : stubRetriever;
}

/** 片段找到但 LLM 失敗時的降級：直接列出片段（best-effort，不中斷對話） */
function fallbackReply(chunks: KnowledgeChunk[], locale?: string): string {
  const prefix =
    normalizeLocale(locale) === 'en' ? 'Based on available information:' : '依現有資料：';
  return [prefix, ...chunks.map((c) => `・${c.title}：${c.content}`)].join('\n');
}

export const knowledgeAgentService: AgentService = {
  id: 'knowledge',
  label: '知識庫問答',
  description: '依租戶知識庫（RAG 檢索 + 重排）回答規章制度與常見問題，附來源出處',
  sticky: false,
  serviceScope: 'service:knowledge',

  intents(): IntentDescriptor[] {
    return [
      {
        id: 'kb.query',
        keywords: KB_KEYWORDS,
        description:
          '查詢公司相關資訊（規章制度、產品/方案/服務介紹、公司簡介、聯絡方式、假別/報銷規定、FAQ），以及知識庫收錄文件的內容（主題不限，如上傳文件的專業知識）——任何「想知道答案」的問題',
      },
    ];
  },

  async handleTurn(
    session: Session,
    userText: string,
    llm: LLMProvider,
  ): Promise<AgentTurnResult> {
    // 指代改寫要在檢索之前：檢索與重排都以「可獨立理解的完整問句」為準，
    // 否則「那他們的完成日期呢」拿去比對向量只會撈回不相干的片段
    const history = priorMessages(session, HISTORY_MESSAGES);
    const query = await resolveQuery(session, userText, llm, history);

    // 兩階段檢索：向量取候選池 → LLM（Haiku）重排出最相關前 K 筆
    const retriever = await pickRetriever(session.tenantId);
    const pool = await retriever.search(session.tenantId, query);
    const chunks = await rerankChunks(session.tenantId, query, pool, FINAL_K);

    let reply: string;
    if (chunks.length === 0) {
      reply =
        normalizeLocale(session.locale) === 'en'
          ? 'No relevant information found in the knowledge base. Try rephrasing, or contact the relevant desk.'
          : '目前知識庫查無相關資料，建議換個問法或洽詢對應窗口。';
    } else {
      // 只把 top-k 片段交給 LLM 綜合作答（附來源），整站內容不進 LLM
      const context = chunks
        .map((c, i) => `[${i + 1}] ${c.title}${c.url ? `（${c.url}）` : ''}\n${c.content}`)
        .join('\n\n');
      try {
        const result = await llm.createMessage({
          system: kbAnswerSystem(session.locale),
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: [
                    // 脈絡只用來理解問題在指什麼；答案仍只能出自參考資料（system prompt 已明訂）
                    history.length > 0 ? `先前對話（僅供理解問題脈絡）：\n${transcriptOf(history)}\n` : '',
                    `參考資料：\n${context}`,
                    `\n問題：${userText}`,
                  ]
                    .filter(Boolean)
                    .join('\n'),
                },
              ],
            },
          ],
          cache: true,
          maxTokens: 512,
        });
        usageStore.recordLLMUsage(session.tenantId, result);
        reply = result.text || fallbackReply(chunks, session.locale);
      } catch (err) {
        logger.warn({ err, sessionId: session.id }, 'knowledge synthesis failed');
        reply = fallbackReply(chunks, session.locale);
      }
    }

    // 旁路回答：只在逐字稿留紀錄，刻意不觸碰 session.values / session.status
    session.messages.push({ role: 'assistant', content: [{ type: 'text', text: reply }] });
    logger.info(
      { sessionId: session.id, hits: chunks.length, retriever: retriever.name },
      'knowledge answer',
    );
    return { reply };
  },
};
