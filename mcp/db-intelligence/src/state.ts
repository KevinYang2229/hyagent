/**
 * 執行期設定（資料來源、存取政策、使用者目錄）：由管理 API 修改，存在客戶端（與 Catalog 同一處），
 * 不回傳 HyAgent 平台保存。首次啟動以 DBI_CONFIG 設定檔為種子。每次寫入整份重驗（configSchema）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { configSchema, type DbiConfig } from './config';
import type { AccessPolicy, DataSource, PolicySet, PrincipalDirectory } from './contracts/policy';

export class StateError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'CONFLICT' | 'BAD_REQUEST',
    message: string,
  ) {
    super(message);
    this.name = 'StateError';
  }
}

export const DATA_SOURCE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export class DbiState {
  private state: DbiConfig;

  constructor(
    initial: DbiConfig,
    private readonly persist: (s: DbiConfig) => void = () => undefined,
  ) {
    this.state = configSchema.parse(initial);
  }

  dataSources(): DataSource[] {
    return this.state.dataSources;
  }

  policies(): PolicySet {
    return this.state.policies;
  }

  principals(): PrincipalDirectory {
    return this.state.principals;
  }

  /** dryRun：只驗證不寫入（管理 API 的試算） */
  private commit(next: DbiConfig, dryRun = false): void {
    const parsed = configSchema.safeParse(next);
    if (!parsed.success) throw new StateError('BAD_REQUEST', parsed.error.issues[0].message);
    if (dryRun) return;
    this.persist(parsed.data);
    this.state = parsed.data;
  }

  /** 政策有變就換版本：結果快取綁政策版本，舊結果隨之失效 */
  private nextPolicyVersion(): string {
    return new Date().toISOString();
  }

  upsertDataSource(ds: DataSource): DataSource {
    if (!DATA_SOURCE_ID_RE.test(ds.id)) throw new StateError('BAD_REQUEST', '資料來源 ID 只能用英數、底線與連字號');
    const prev = this.state.dataSources.find((d) => d.id === ds.id);
    if (prev && prev.tenantId !== ds.tenantId) throw new StateError('CONFLICT', '資料來源不能改綁其他租戶，請刪除後重建');
    this.commit({ ...this.state, dataSources: [...this.state.dataSources.filter((d) => d.id !== ds.id), ds] });
    return ds;
  }

  removeDataSource(id: string): void {
    if (!this.state.dataSources.some((d) => d.id === id)) throw new StateError('NOT_FOUND', `資料來源不存在：${id}`);
    if (this.state.policies.policies.some((p) => p.dataSourceId === id)) throw new StateError('CONFLICT', '仍有存取政策使用此資料來源，請先移除');
    this.commit({ ...this.state, dataSources: this.state.dataSources.filter((d) => d.id !== id) });
  }

  tenantPolicies(tenantId: string): { version: string; policies: AccessPolicy[] } {
    return { version: this.state.policies.version, policies: this.state.policies.policies.filter((p) => p.tenantId === tenantId) };
  }

  /** 整包取代某租戶的政策（其他租戶不動）；dryRun 只驗證，回傳不含預設值補齊以外的變更 */
  setTenantPolicies(tenantId: string, policies: AccessPolicy[], opts: { dryRun?: boolean } = {}): { version: string; policies: AccessPolicy[] } {
    const foreign = policies.find((p) => p.tenantId !== tenantId);
    if (foreign) throw new StateError('BAD_REQUEST', `政策 ${foreign.id} 的 tenantId 與路徑不符`);
    const ids = new Set<string>();
    for (const p of policies) {
      if (ids.has(p.id)) throw new StateError('BAD_REQUEST', `政策 ID 重複：${p.id}`);
      ids.add(p.id);
    }
    const others = this.state.policies.policies.filter((p) => p.tenantId !== tenantId);
    if (others.some((p) => ids.has(p.id))) throw new StateError('CONFLICT', '政策 ID 已被其他租戶使用');
    const version = this.nextPolicyVersion();
    this.commit({ ...this.state, policies: { version, policies: [...others, ...policies] } }, opts.dryRun);
    return opts.dryRun ? { version: this.state.policies.version, policies } : this.tenantPolicies(tenantId);
  }

  tenantPrincipals(tenantId: string): PrincipalDirectory[string] {
    return this.state.principals[tenantId] ?? {};
  }

  setTenantPrincipals(tenantId: string, dir: PrincipalDirectory[string]): PrincipalDirectory[string] {
    this.commit({ ...this.state, principals: { ...this.state.principals, [tenantId]: dir } });
    return this.tenantPrincipals(tenantId);
  }
}

/** 檔案保存：tmp + rename 原子寫入；檔案不存在時用種子設定 */
export function fileState(file: string, seed: () => DbiConfig): DbiState {
  const initial = existsSync(file) ? configSchema.parse(JSON.parse(readFileSync(file, 'utf8'))) : seed();
  const persist = (s: DbiConfig) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, `${JSON.stringify(s, null, 2)}\n`);
    renameSync(`${file}.tmp`, file);
  };
  if (!existsSync(file)) persist(configSchema.parse(initial));
  return new DbiState(initial, persist);
}
