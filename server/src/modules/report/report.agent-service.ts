/**
 * 報告 Agent 服務。
 *
 * sticky=false：與知識庫問答同為旁路服務——啟動報告後不奪走填表流程，
 * 且不動 session 的 values / status。
 *
 * 本服務只負責「抽主題 → 啟動 job → 立刻回覆」；實際彙整在 report.job 背景進行。
 */
import { env } from '@/config/env';
import type { LLMProvider } from '@/lib/llm/types';
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
import { getRunningReportJobForTenant, startReportJob } from './report.job';

const HISTORY_MESSAGES = 6;

/** 模型判定對話中沒有可用主題時輸出的哨兵字串 */
const NO_TOPIC = 'NONE';

const REPORT_KEYWORDS = [
  '報告',
  '彙整',
  '整理一份',
  '整理成',
  '總結',
  '摘要文件',
  'report',
  'summary document',
];

function topicSystem(): string {
  return [
    '你負責從對話中抽出「使用者想產生報告的主題」。',
    '只輸出主題本身，一句話、可獨立理解，不要任何前後綴或說明。',
    '依對話脈絡補齊代名詞與省略的對象；嚴禁加入脈絡中沒有的條件或臆測。',
    `對話中若沒有明確可用的主題，只輸出 ${NO_TOPIC}。`,
  ].join('\n');
}

/**
 * 抽出報告主題。與知識庫問答的指代改寫相反，這裡**不得 fail-open**：
 * 拿一句空泛的話去跑一份報告，會實際支出「1 次大綱 + N 次檢索 + N 次彙整」的成本，
 * 換回一份必定無用的產出。抽不到就回問，讓使用者補一句。
 */
async function resolveTopic(
  session: Session,
  userText: string,
  llm: LLMProvider,
): Promise<string | undefined> {
  const history = priorMessages(session, HISTORY_MESSAGES);
  try {
    const result = await llm.createMessage({
      system: topicSystem(),
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: [
                history.length > 0 ? `對話脈絡：\n${transcriptOf(history)}\n` : '',
                `最新訊息：${userText}`,
              ]
                .filter(Boolean)
                .join('\n'),
            },
          ],
        },
      ],
      model: env.LLM_ROUTER_MODEL, // 主題抽取屬輔助任務，用便宜模型即可
      maxTokens: 128,
    });
    usageStore.recordLLMUsage(session.tenantId, result);
    const topic = (result.text ?? '').replace(/\s+/g, ' ').trim();
    if (topic === '' || topic.toUpperCase() === NO_TOPIC) return undefined;
    return topic;
  } catch (err) {
    logger.warn({ err, sessionId: session.id }, 'report topic extraction failed');
    return undefined;
  }
}

function askTopicReply(locale?: string): string {
  return normalizeLocale(locale) === 'en'
    ? 'What topic should the report cover? Tell me the subject and I will compile it from the knowledge base.'
    : '你想針對什麼主題產生報告？告訴我主題，我就依知識庫的資料彙整一份給你。';
}

function busyReply(locale?: string): string {
  return normalizeLocale(locale) === 'en'
    ? 'A report is already being generated for your organization. Please try again once it finishes.'
    : '目前已有一份報告正在進行中，請等它完成後再試。';
}

function startedReply(topic: string, locale?: string): string {
  return normalizeLocale(locale) === 'en'
    ? `Generating a report on "${topic}" from the knowledge base. I will show the download links here when it is ready.`
    : `正在依知識庫的資料產生「${topic}」的報告，完成後會在這裡提供下載連結。`;
}

export const reportAgentService: AgentService = {
  id: 'report',
  label: '知識庫報告',
  description: '依知識庫檢索結果彙整成一份可下載的報告（Markdown / HTML），附各節來源',
  sticky: false,
  serviceScope: 'service:report',

  intents(): IntentDescriptor[] {
    return [
      {
        id: 'report.generate',
        keywords: REPORT_KEYWORDS,
        description:
          '產生一份可下載、可帶走的報告文件：使用者要的是把某個主題的資料彙整成一份多章節的文件，' +
          '而不是一個問題的答案。只想知道某件事怎麼規定、怎麼申請，屬於知識庫問答（kb.query），不是這個',
        examples: ['幫我整理一份請假規定的報告', '把補助辦法彙整成一份文件'],
      },
    ];
  },

  async handleTurn(
    session: Session,
    userText: string,
    llm: LLMProvider,
  ): Promise<AgentTurnResult> {
    const topic = await resolveTopic(session, userText, llm);

    let result: AgentTurnResult;
    if (!topic) {
      result = { reply: askTopicReply(session.locale) };
    } else if (getRunningReportJobForTenant(session.tenantId)) {
      // 併發限制在對話中是「說明」而非錯誤：拋 409 會讓整個回合失敗、逐字稿留下斷點
      result = { reply: busyReply(session.locale) };
    } else {
      const job = startReportJob({
        tenantId: session.tenantId,
        userId: session.userId,
        topic,
        locale: session.locale,
        llm,
      });
      result = {
        reply: startedReply(topic, session.locale),
        report: { id: job.id, status: 'queued' },
      };
    }

    // 旁路回答：只在逐字稿留紀錄，刻意不觸碰 session.values / session.status
    session.messages.push({ role: 'assistant', content: [{ type: 'text', text: result.reply }] });
    return result;
  },
};
