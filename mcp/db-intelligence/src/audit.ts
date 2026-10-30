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
