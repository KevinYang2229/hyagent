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
import { dataReportSources } from './report.data';
import { getRunningReportJobForTenant, startReportJob, type ReportSource } from './report.job';

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
  '數據報告',
  '統計報告',
];

/** 主題前綴：報告的資料來源（只在使用者有資料庫可查時要求模型標註） */
const SOURCE_PREFIX: Record<string, ReportSource> = { 'DB:': 'database', 'KB:': 'knowledge' };

function topicSystem(dataSources: string[]): string {
  const lines = [
    '你負責從對話中抽出「使用者想產生報告的主題」。',
    '只輸出主題本身，一句話、可獨立理解，不要任何前後綴或說明。',
    '依對話脈絡補齊代名詞與省略的對象；嚴禁加入脈絡中沒有的條件或臆測。',
    `對話中若沒有明確可用的主題，只輸出 ${NO_TOPIC}。`,
  ];
  if (dataSources.length === 0) return lines.join('\n');
  return [
    ...lines.slice(0, 1),
    '另外判斷報告的資料來源，並在主題前加上前綴：',
    '- 「DB:」：主題要的是業務數據（人數、筆數、統計、分布、排名、比較等），或要把剛才查詢的數據整理成報告。可查詢的資料庫：',
    ...dataSources.map((s) => `  - ${s}`),
    '- 「KB:」：主題是規章、辦法、文件內容等文字資料。',
    '輸出格式：前綴加主題，例如「DB: 各部門在職人數分析」。',
    ...lines.slice(2),
  ].join('\n');
}

/** 解析「DB: 主題」；沒有前綴視為知識庫 */
export function parseTopic(text: string): { topic: string; source: ReportSource } | undefined {
  let topic = text.replace(/\s+/g, ' ').trim();
  let source: ReportSource = 'knowledge';
  for (const [prefix, s] of Object.entries(SOURCE_PREFIX)) {
    if (topic.toUpperCase().startsWith(prefix)) {
      topic = topic.slice(prefix.length).trim();
      source = s;
      break;
    }
  }
  if (topic === '' || topic.toUpperCase() === NO_TOPIC) return undefined;
  return { topic, source };
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
): Promise<{ topic: string; source: ReportSource } | undefined> {
  const history = priorMessages(session, HISTORY_MESSAGES);
  const dataSources = await dataReportSources(session.tenantId, session.userId, session.locale);
  try {
    const result = await llm.createMessage({
      system: topicSystem(dataSources),
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
    const parsed = parseTopic(result.text ?? '');
    // 沒有資料庫可查時，模型即使標了 DB 也只能走知識庫
    return parsed && dataSources.length === 0 ? { ...parsed, source: 'knowledge' } : parsed;
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

function startedReply(topic: string, source: ReportSource, locale?: string): string {
  const en = normalizeLocale(locale) === 'en';
  if (source === 'database') {
    return en
      ? `Querying the database and generating a data report on "${topic}". I will show the download links here when it is ready.`
      : `正在查詢資料庫並產生「${topic}」的數據報告，完成後會在這裡提供下載連結。`;
  }
  return en
    ? `Generating a report on "${topic}" from the knowledge base. I will show the download links here when it is ready.`
    : `正在依知識庫的資料產生「${topic}」的報告，完成後會在這裡提供下載連結。`;
}

export const reportAgentService: AgentService = {
  id: 'report',
  label: '報告',
  description: '依知識庫檢索結果，或依主題自動查詢資料庫的數據，彙整成一份可下載的報告（Markdown / HTML / PDF），附各節來源',
  sticky: false,
  serviceScope: 'service:report',

  intents(): IntentDescriptor[] {
    return [
      {
        id: 'report.generate',
        keywords: REPORT_KEYWORDS,
        description:
          '產生一份可下載、可帶走的報告文件：使用者要的是把某個主題的資料（知識庫文件或資料庫數據）彙整成一份多章節的文件，' +
          '或把查詢結果匯出成報告，而不是一個問題的答案。只想知道某件事怎麼規定、怎麼申請，屬於知識庫問答（kb.query）；' +
          '只想查一個數字或一張清單，屬於資料查詢，都不是這個',
        examples: ['幫我整理一份請假規定的報告', '把補助辦法彙整成一份文件', '產生各部門人力配置的數據報告', '把剛才的查詢結果整理成報告'],
      },
    ];
  },

  async handleTurn(
    session: Session,
    userText: string,
    llm: LLMProvider,
  ): Promise<AgentTurnResult> {
    // 已有任務進行中就不必抽主題：省一次 LLM 與工具清單準備，回覆也不會因等待而落後於任務狀態
    const request = getRunningReportJobForTenant(session.tenantId)
      ? null
      : await resolveTopic(session, userText, llm);

    let result: AgentTurnResult;
    if (request === null || (request && getRunningReportJobForTenant(session.tenantId))) {
      // 併發限制在對話中是「說明」而非錯誤：拋 409 會讓整個回合失敗、逐字稿留下斷點
      result = { reply: busyReply(session.locale) };
    } else if (!request) {
      result = { reply: askTopicReply(session.locale) };
    } else {
      // 這裡與上面 getRunningReportJobForTenant 的檢查之間沒有 await，Node 單執行緒
      // run-to-completion 保證兩者間不會插入另一個併發呼叫，故此處不會撞上 startReportJob
      // 內部同樣的併發檢查而拋出 AppError.conflict——目前不包 try/catch 是安全的。
      // 但這是對「job 狀態只存在單一行程記憶體」的脆弱假設：若日後 job 狀態改為跨行程共享
      // （如外部佇列／多副本部署），這個保證就不成立，屆時必須在此包 try/catch 接住
      // AppError.conflict 並降級為 busyReply，否則會讓例外原樣炸穿整個對話回合。
      const job = startReportJob({
        tenantId: session.tenantId,
        userId: session.userId,
        topic: request.topic,
        locale: session.locale,
        llm,
        source: request.source,
      });
      result = {
        reply: startedReply(request.topic, request.source, session.locale),
        report: { id: job.id, status: 'queued' },
      };
    }

    // 旁路回答：只在逐字稿留紀錄，刻意不觸碰 session.values / session.status
    session.messages.push({ role: 'assistant', content: [{ type: 'text', text: result.reply }] });
    return result;
  },
};
