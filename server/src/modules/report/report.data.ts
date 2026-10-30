/**
 * 數據報告：依主題自動查資料庫，彙整成報告。
 *
 * 只用使用者有權限的 Database Intelligence 唯讀工具（search_schema／get_dataset_details／execute_safe_query），
 * 身分、資料範圍與欄位權限全部沿用 DBI 的政策，報告不會看到使用者在對話中查不到的資料。
 *
 * 報告裡的數字一律取自查詢結果本身：表格與圖表由程式從結果列產生，模型只寫各節的重點說明。
 */
import { randomUUID } from 'node:crypto';
import type { LLMProvider, LLMTool } from '@/lib/llm/types';
import { languageDirective, normalizeLocale } from '@/lib/locale';
import { logger } from '@/lib/logger';
import { untrustedDataRule } from '@/lib/untrusted-content';
import type { Session } from '@/modules/conversation/conversation.types';
import { runToolLoop } from '@/modules/conversation/tool-loop';
import { mcpStore } from '@/modules/mcp/mcp.store';
import { isWriteTool, makeToolContext, toolRegistry, unwrapToolOutput } from '@/modules/tools';
import type { ToolContext } from '@/modules/tools/tool.types';
import type { ChartPoint, ReportSection, SectionChart } from './report.types';

const DATA_TOOL_RE = /^mcp\.[^.]+\.(search_schema|get_dataset_details|execute_safe_query)$/;
const QUERY_TOOL_RE = /\.execute_safe_query$/;
const MAX_ITERATIONS = 16;
const MAX_QUERIES = 6;
/** 報告表格最多列數；DBI 一頁 50 筆，超過的部分在說明中註記 */
const MAX_TABLE_ROWS = 50;
const MAX_CHART_POINTS = 20;
const MAX_GROUPED_SERIES = 4;

/** 一次成功查詢的結果（execute_safe_query 回傳的結構） */
export interface DataQueryResult {
  no: number;
  columns: string[];
  labels: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  hasMore: boolean;
  warnings: string[];
  dataSourceId: string;
  datasets: string[];
}

export interface DataReport {
  title: string;
  sections: ReportSection[];
}

function dataTools(ctx: ToolContext): LLMTool[] {
  return toolRegistry.availableFor(ctx).filter((t) => {
    if (!DATA_TOOL_RE.test(t.name)) return false;
    try {
      return !isWriteTool(toolRegistry.resolve(t.name, ctx));
    } catch {
      return false;
    }
  });
}

/**
 * 使用者可用來產生數據報告的資料庫服務（名稱＋說明），決定報告能否改用資料庫。
 * 空陣列＝沒有可用的資料庫查詢工具。
 */
export async function dataReportSources(tenantId: string, userId: string, locale?: string): Promise<string[]> {
  const ctx = makeToolContext({ tenantId, userId, locale });
  try {
    await toolRegistry.prepare(ctx);
  } catch (err) {
    logger.warn({ err, tenantId }, 'data report tool prepare failed');
    return [];
  }
  const serverIds = new Set(dataTools(ctx).filter((t) => QUERY_TOOL_RE.test(t.name)).map((t) => t.name.split('.')[1]));
  return mcpStore
    .listVisibleTo(tenantId)
    .filter((c) => serverIds.has(c.id))
    .map((c) => `${c.name}：${c.description || '（未提供描述）'}`);
}

function systemPrompt(topic: string, locale?: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return [
    `你負責為一份數據報告收集資料並撰寫重點。${languageDirective(locale)}`,
    `今天日期是 ${today}。報告主題：${topic}`,
    '步驟：',
    '1. 先用 search_schema 找出與主題相關、你有權限查詢的資料集；需要時用 get_dataset_details 看欄位。',
    `2. 規劃 2–${MAX_QUERIES} 個互補的查詢（例如總量、依類別分組的分布、交叉比較），逐一用 execute_safe_query 執行。`,
    '   分組統計優先：select 放一個名稱欄位與一到數個數值欄位，數值欄位填中文 label，並依數值排序。',
    '   每個成功的查詢會回傳 query_no，報告的每一節對應一個查詢；查詢失敗就修正或換別的查詢，不要重複無效呼叫。',
    '3. 全部完成後，最後一則回覆只輸出一個 JSON 物件，不要任何其他文字或 Markdown 圍欄：',
    '   {"title":"報告標題","sections":[{"query_no":1,"heading":"節標題","analysis":"2–4 句重點"}],"summary":"整體結論 2–4 句"}',
    '撰寫規則：',
    '- analysis 與 summary 只能引用查詢結果中出現的數字，不可推算結果以外的數字或臆測原因。',
    '- 表格與圖表由系統依查詢結果產生，analysis 不要重列明細，只點出重點（最多、最少、明顯差異）。',
    '- 查詢結果有 warnings（如結果被截斷、遮罩）時要在該節說明。',
    '- 找不到相關資料集或全部查詢都失敗時，輸出 {"title":"","sections":[],"summary":""}。',
    untrustedDataRule(locale),
  ].join('\n');
}

function asStrings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function toResult(no: number, data: unknown): DataQueryResult | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const d = data as Record<string, unknown>;
  const columns = asStrings(d.columns);
  if (columns.length === 0 || !Array.isArray(d.rows)) return undefined;
  const labels = asStrings(d.column_labels);
  const basis = (d.basis ?? {}) as Record<string, unknown>;
  return {
    no,
    columns,
    labels: columns.map((c, i) => labels[i] || c),
    rows: d.rows.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object'),
    rowCount: typeof d.row_count === 'number' ? d.row_count : d.rows.length,
    truncated: d.truncated === true,
    hasMore: typeof d.next_cursor === 'string',
    warnings: asStrings(d.warnings),
    dataSourceId: typeof basis.data_source_id === 'string' ? basis.data_source_id : '',
    datasets: asStrings(basis.datasets),
  };
}

/** 取出模型最後回覆中的 JSON 物件；容忍前後多餘文字與 ``` 圍欄 */
export function parseReportPlan(text: string): { title: string; sections: { no: number; heading: string; analysis: string }[]; summary: string } | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const raw = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const sections = Array.isArray(raw.sections) ? raw.sections : [];
    return {
      title: typeof raw.title === 'string' ? raw.title.trim() : '',
      summary: typeof raw.summary === 'string' ? raw.summary.trim() : '',
      sections: sections.flatMap((s) => {
        const r = (s ?? {}) as Record<string, unknown>;
        const no = Number(r.query_no);
        if (!Number.isInteger(no)) return [];
        return [{ no, heading: typeof r.heading === 'string' ? r.heading.trim() : '', analysis: typeof r.analysis === 'string' ? r.analysis.trim() : '' }];
      }),
    };
  } catch {
    return undefined;
  }
}

function numeric(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  // PostgreSQL 的 COUNT／NUMERIC 以字串回傳
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  return undefined;
}

function display(v: unknown): string {
  if (v === null || v === undefined || v === '') return '–';
  return String(v);
}

/**
 * 依結果形狀自動產生圖表：恰好一個名稱欄位＋一到數個數值欄位，且列數適中時才畫。
 * 數字取自完整的查詢結果，標成 complete。
 */
export function autoChart(r: DataQueryResult, heading: string): SectionChart | undefined {
  if (r.rows.length < 2 || r.rows.length > MAX_CHART_POINTS) return undefined;
  const isNumericCol = (c: string) => r.rows.every((row) => row[c] === null || numeric(row[c]) !== undefined);
  const numCols = r.columns.filter(isNumericCol);
  const labelCols = r.columns.filter((c) => !numCols.includes(c));
  if (labelCols.length !== 1 || numCols.length === 0 || numCols.length > MAX_GROUPED_SERIES) return undefined;
  const label = labelCols[0];
  const labelOf = (c: string) => r.labels[r.columns.indexOf(c)];
  const points: ChartPoint[] = r.rows.map((row) => {
    const values = numCols.map((c) => numeric(row[c]) ?? 0);
    return { label: display(row[label]), value: values[0], ...(numCols.length > 1 ? { values } : {}) };
  });
  return {
    kind: numCols.length > 1 ? 'grouped' : 'bar',
    title: heading,
    ...(numCols.length === 1 ? { unit: labelOf(numCols[0]) } : { series: numCols.map(labelOf) }),
    points,
    complete: !r.hasMore && !r.truncated,
    sourceLabel: sourceLabel(r),
    totalRows: r.rowCount,
  };
}

function sourceLabel(r: DataQueryResult): string {
  return r.datasets.length ? `${r.dataSourceId}（${r.datasets.join('、')}）` : r.dataSourceId;
}

const cellText = (v: unknown) => display(v).replace(/\|/g, '\\|').replace(/\s+/g, ' ');

/** 查詢結果轉成 Markdown 表格，附上筆數與截斷說明 */
export function resultTable(r: DataQueryResult, locale?: string): string {
  const rows = r.rows.slice(0, MAX_TABLE_ROWS);
  const en = normalizeLocale(locale) === 'en';
  const lines = [
    `| ${r.labels.map(cellText).join(' | ')} |`,
    `| ${r.columns.map((c) => (r.rows.every((row) => row[c] === null || numeric(row[c]) !== undefined) ? '---:' : '---')).join(' | ')} |`,
    ...rows.map((row) => `| ${r.columns.map((c) => cellText(row[c])).join(' | ')} |`),
  ];
  const shown = rows.length;
  const total = r.rowCount;
  const note = en
    ? `Source: ${sourceLabel(r)}; ${shown < total || r.hasMore || r.truncated ? `showing the first ${shown} rows` : `${total} rows`}.`
    : `資料來源：${sourceLabel(r)}；${shown < total || r.hasMore || r.truncated ? `僅列出前 ${shown} 筆` : `共 ${total} 筆`}。`;
  return [...lines, '', `_${note}_`].join('\n');
}

function sectionOf(r: DataQueryResult, heading: string, analysis: string, locale?: string): ReportSection {
  const warnings = r.warnings.length ? `\n\n> ${r.warnings.join('；')}` : '';
  const chart = autoChart(r, heading);
  return {
    heading,
    query: '',
    body: `${analysis}${warnings}\n\n${resultTable(r, locale)}`.trim(),
    sources: [{ title: sourceLabel(r) }],
    hits: Math.max(r.rows.length, 1),
    ...(chart ? { charts: [chart] } : {}),
  };
}

export interface DataReportParams {
  tenantId: string;
  userId: string;
  topic: string;
  locale?: string;
  llm: LLMProvider;
}

export async function buildDataReport(params: DataReportParams): Promise<DataReport> {
  const ctx = makeToolContext({ tenantId: params.tenantId, userId: params.userId, locale: params.locale });
  await toolRegistry.prepare(ctx);
  const tools = dataTools(ctx);
  if (!tools.some((t) => QUERY_TOOL_RE.test(t.name))) return { title: '', sections: [] };

  const { llmTools, idByLlmName } = expose(tools);
  const results: DataQueryResult[] = [];
  // 背景工作沒有對話 session：用一次性的逐字稿跑共用 tool-loop，不寫回任何使用者對話
  const scratch: Session = {
    id: `report-data-${randomUUID()}`,
    tenantId: params.tenantId,
    userId: params.userId,
    formId: '',
    values: {},
    status: 'collecting',
    locale: params.locale,
    messages: [{ role: 'user', content: [{ type: 'text', text: params.topic }] }],
    createdAt: new Date().toISOString(),
  } as Session;

  const reply = await runToolLoop(params.llm, scratch, {
    system: systemPrompt(params.topic, params.locale),
    tools: llmTools,
    maxIterations: MAX_ITERATIONS,
    dispatchTool: async (name, input) => {
      const realId = idByLlmName.get(name);
      if (!realId) return JSON.stringify({ ok: false, error: `工具不可用：${name}` });
      const isQuery = QUERY_TOOL_RE.test(realId);
      if (isQuery && results.length >= MAX_QUERIES) {
        return JSON.stringify({ ok: false, error: `最多 ${MAX_QUERIES} 個查詢，請直接輸出報告 JSON` });
      }
      try {
        const { data } = unwrapToolOutput(await toolRegistry.invoke(realId, input, ctx));
        if (!isQuery) return JSON.stringify({ ok: true, result: data });
        const r = toResult(results.length + 1, data);
        if (!r) return JSON.stringify({ ok: true, result: data });
        results.push(r);
        return JSON.stringify({ ok: true, query_no: r.no, result: data });
      } catch (err) {
        return JSON.stringify({ ok: false, error: (err as Error).message });
      }
    },
  });

  if (results.length === 0) return { title: '', sections: [] };
  const plan = parseReportPlan(reply);
  const en = normalizeLocale(params.locale) === 'en';
  const byNo = new Map(results.map((r) => [r.no, r]));
  const used = new Set<number>();
  const sections: ReportSection[] = [];
  for (const s of plan?.sections ?? []) {
    const r = byNo.get(s.no);
    if (!r || used.has(s.no)) continue;
    used.add(s.no);
    sections.push(sectionOf(r, s.heading || (en ? `Query ${s.no}` : `查詢 ${s.no}`), s.analysis, params.locale));
  }
  // 模型沒交代的查詢照樣列出：數字是查到的事實，不因摘要失敗而遺失
  for (const r of results) {
    if (!used.has(r.no)) sections.push(sectionOf(r, en ? `Query ${r.no}` : `查詢 ${r.no}`, '', params.locale));
  }
  if (plan?.summary) {
    sections.push({ heading: en ? 'Summary' : '總結', query: '', body: plan.summary, sources: [], hits: 1 });
  }
  if (!plan) logger.warn({ tenantId: params.tenantId }, 'data report plan unparsable; sections fall back to raw results');
  return { title: plan?.title || params.topic, sections };
}

const LLM_TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function expose(tools: LLMTool[]): { llmTools: LLMTool[]; idByLlmName: Map<string, string> } {
  const idByLlmName = new Map<string, string>();
  const llmTools: LLMTool[] = [];
  for (const t of tools) {
    const llmName = t.name.replace(/\./g, '_');
    if (!LLM_TOOL_NAME_RE.test(llmName) || idByLlmName.has(llmName)) continue;
    idByLlmName.set(llmName, t.name);
    llmTools.push({ ...t, name: llmName });
  }
  return { llmTools, idByLlmName };
}
