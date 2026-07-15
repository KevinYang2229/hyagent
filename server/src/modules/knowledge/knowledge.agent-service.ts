/**
 * Knowledge Agent 服務（RAG）。
 *
 * sticky=false：屬「旁路」服務——回答後不奪走填表流程，且**不動 session 的 values / status**。
 * 檢索：有靜態網站索引時走 staticIndexRetriever（向量檢索），否則退回 stub FAQ（dev/測試）。
 * 作答：只把 top-k 片段交給 LLM 綜合成答案並附來源；整站內容永不進 LLM（省 token）。
 */
import type { LLMProvider } from '@/lib/llm/types';
import { logger } from '@/lib/logger';
import { normalizeLocale } from '@/lib/locale';
import type {
  AgentService,
  AgentTurnResult,
  IntentDescriptor,
} from '@/modules/conversation/agent-service.types';
import type { Session } from '@/modules/conversation/conversation.types';
import { usageStore } from '@/modules/usage/usage.store';
import { rerankChunks } from './rerank';
import { hasStaticIndex, staticIndexRetriever } from './retriever.staticIndex';
import { stubRetriever } from './retriever.stub';
import type { KnowledgeChunk, KnowledgeRetriever } from './retriever.types';

// 重排後交給作答 LLM 的最終片段數
const FINAL_K = 5;

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
      '- Be concise and directly on point; use bullet points when helpful.',
      '- When helpful, cite the source at the end as (Source: title).',
    ].join('\n');
  }
  return [
    '你是公司知識庫問答助理，全程使用繁體中文。',
    '規則：',
    '- 只根據下方「參考資料」回答；資料未提到的部分，明說「資料中未提及」，切勿杜撰。',
    '- 回答精簡、直接切中問題；必要時條列。',
    '- 若有幫助，於句末以（來源：標題）標註引用。',
  ].join('\n');
}

function pickRetriever(tenantId: string): KnowledgeRetriever {
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
    // 兩階段檢索：向量取候選池 → LLM（Haiku）重排出最相關前 K 筆
    const pool = await pickRetriever(session.tenantId).search(session.tenantId, userText);
    const chunks = await rerankChunks(session.tenantId, userText, pool, FINAL_K);

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
                { type: 'text', text: `參考資料：\n${context}\n\n問題：${userText}` },
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
      { sessionId: session.id, hits: chunks.length, retriever: pickRetriever(session.tenantId).name },
      'knowledge answer',
    );
    return { reply };
  },
};
