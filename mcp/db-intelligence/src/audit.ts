/**
 * 稽核事件（規格書 6.1 query_audits、11 Observability）：成功、拒絕、錯誤都記。
 * 不存結果資料與比較值，只存 plan_hash；要追查時以 request_id 對應。
 */
import { createHash } from 'node:crypto';

export interface AuditEvent {
  request_id: string;
  /** 模型帶的關聯 ID（不可信，只作對照） */
  client_request_id?: string;
  tenant_id: string;
  principal_id: string;
  tool: string;
  source_id?: string;
  plan_hash?: string;
  policy_version: string;
  catalog_version?: number;
  policy_ids?: string[];
  datasets?: string[];
  /** 查詢用到的機密／限制欄位（dataset.column）；只記欄位名，不記值 */
  sensitive_columns?: string[];
  status: 'success' | 'denied' | 'invalid' | 'error';
  reason_code?: string;
  /** 拒絕或錯誤的說明（給管理員查原因；不含資料值） */
  reason_detail?: string;
  /** 模型送出的 Query Plan 結構：保留資料表、欄位、運算子，比較值與其他內容一律遮蔽（見 redactPlan） */
  plan_summary?: unknown;
  row_count?: number;
  truncated?: boolean;
  duration_ms: number;
  db_time_ms?: number;
  created_at: string;
}

export interface AuditSink {
  write(e: AuditEvent): void | Promise<void>;
}

export class MemoryAuditSink implements AuditSink {
  readonly events: AuditEvent[] = [];

  write(e: AuditEvent): void {
    this.events.push(e);
  }
}

/** 一行一筆 JSON 到 stdout，交給部署環境的 log 收集 */
export class ConsoleAuditSink implements AuditSink {
  write(e: AuditEvent): void {
    console.log(JSON.stringify({ type: 'dbi_audit', ...e }));
  }
}

/** 最近 N 筆留在記憶體供管理 API 查詢（長期保存交給 stdout 的 log 收集） */
export class RingAuditSink implements AuditSink {
  private readonly events: AuditEvent[] = [];

  constructor(private readonly max = 5000) {}

  write(e: AuditEvent): void {
    this.events.push(e);
    if (this.events.length > this.max) this.events.splice(0, this.events.length - this.max);
  }

  query(filter: { requestId?: string; tenantId?: string; status?: AuditEvent['status']; limit?: number }): AuditEvent[] {
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
    const out: AuditEvent[] = [];
    for (let i = this.events.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.events[i];
      if (filter.requestId && e.request_id !== filter.requestId) continue;
      if (filter.tenantId && e.tenant_id !== filter.tenantId) continue;
      if (filter.status && e.status !== filter.status) continue;
      out.push(e);
    }
    return out;
  }
}

export function multiAuditSink(...sinks: AuditSink[]): AuditSink {
  return {
    async write(e) {
      await Promise.all(sinks.map((s) => s.write(e)));
    },
  };
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v as object)
        .sort()
        .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

export function planHash(plan: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(plan) ?? null)).digest('hex').slice(0, 32);
}

/** 結構性的鍵：值是 Catalog 名稱或固定選項，保留（截斷）以便追查模型怎麼組查詢 */
const STRUCTURAL_KEYS = new Set(['version', 'data_source_id', 'dataset', 'field', 'op', 'agg', 'alias', 'direction', 'type', 'relationship_id']);
const MAX_TEXT = 64;
const MAX_DEPTH = 6;
const MAX_ITEMS = 30;
const MAX_SUMMARY_CHARS = 4000;

function describeValue(v: unknown): string {
  if (Array.isArray(v)) return `<${v.length} 個值>`;
  if (typeof v === 'string') return '<文字>';
  if (typeof v === 'number') return '<數字>';
  if (typeof v === 'boolean') return '<布林>';
  if (v === null) return '<null>';
  return '<其他>';
}

function redact(v: unknown, key: string | undefined, depth: number): unknown {
  if (key === 'value') return describeValue(v);
  if (depth > MAX_DEPTH) return '…';
  if (Array.isArray(v)) {
    const items = v.slice(0, MAX_ITEMS).map((x) => redact(x, undefined, depth + 1));
    return v.length > MAX_ITEMS ? [...items, `…另 ${v.length - MAX_ITEMS} 項`] : items;
  }
  if (v && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>).slice(0, MAX_ITEMS);
    return Object.fromEntries(entries.map(([k, x]) => [k.slice(0, MAX_TEXT), redact(x, k, depth + 1)]));
  }
  if (key === 'limit' && typeof v === 'number') return v;
  if (key !== undefined && STRUCTURAL_KEYS.has(key) && typeof v === 'string') return v.length > MAX_TEXT ? `${v.slice(0, MAX_TEXT)}…` : v;
  return v === undefined ? undefined : '?';
}

/**
 * Query Plan 的稽核摘要：只保留結構（資料表、欄位、運算子、聚合、排序、筆數），比較值只記型別，
 * 其他任何文字或數字一律以 ? 取代。模型送來的內容不可信、格式也可能完全錯誤，所以採白名單，不假設結構。
 */
export function redactPlan(plan: unknown): unknown {
  const out = redact(plan, undefined, 0);
  const text = JSON.stringify(out) ?? 'null';
  return text.length > MAX_SUMMARY_CHARS ? { truncated: true, preview: `${text.slice(0, MAX_SUMMARY_CHARS)}…` } : out;
}
