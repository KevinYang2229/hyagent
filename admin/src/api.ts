import type { Definition, TenantAppearance } from '@oa-agent/shared';

export type { Definition };

export interface FormSummary {
  formId: string;
  title: string;
  description: string;
  source: 'base' | 'tenant' | 'override';
  editable: boolean;
}

export interface FormExport {
  formId: string;
  files: Record<string, unknown>;
}

const TOKEN_KEY = 'oa-admin-token';

// dev：留空 → 相對 /api（vite proxy 轉 3000）。
// production：build 時設 VITE_API_BASE=https://<server-domain> 直接打後端（前後端分開部署）。
const API_ORIGIN = (import.meta.env.VITE_API_BASE ?? '').replace(/\/+$/, '');

export const tokenStore = {
  get: (): string | null => sessionStorage.getItem(TOKEN_KEY),
  set: (t: string) => sessionStorage.setItem(TOKEN_KEY, t),
  clear: () => sessionStorage.removeItem(TOKEN_KEY),
};

export interface Tenant {
  id: string;
  name: string;
  allowedOrigins: string[];
  ssoSecret?: string;
  appearance?: TenantAppearance;
  grantedScopes?: string[];
  createdAt: string;
}
export interface ApiKey {
  key: string;
  tenantId: string;
  type: 'publishable' | 'secret';
  createdAt: string;
  revokedAt?: string;
}
export interface WebhookEndpoint {
  id: string;
  tenantId: string;
  url: string;
  secret: string;
  events?: string[];
  createdAt: string;
  disabledAt?: string;
}
export interface Usage {
  conversations: number;
  messages: number;
  submissions: number;
  llmTokens: number;
}
export interface AuditEntry {
  toolId: string;
  userId: string;
  at: string;
  ok: boolean;
  summary: string;
  error?: string;
}

/** 401 時拋出，UI 攔截導回登入 */
export class UnauthorizedError extends Error {}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = tokenStore.get();
  const res = await fetch(`${API_ORIGIN}/api${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 401) {
    tokenStore.clear();
    throw new UnauthorizedError('未授權');
  }
  const json = (await res.json().catch(() => ({}))) as { data?: T; error?: { message?: string } };
  if (!res.ok) throw new Error(json.error?.message ?? `HTTP ${res.status}`);
  return json.data as T;
}

/** 上傳用：body 為 FormData，不可手動設 content-type（讓瀏覽器帶 multipart boundary） */
async function reqUpload<T>(method: string, path: string, formData: FormData): Promise<T> {
  const token = tokenStore.get();
  const res = await fetch(`${API_ORIGIN}/api${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: formData,
  });
  if (res.status === 401) {
    tokenStore.clear();
    throw new UnauthorizedError('未授權');
  }
  const json = (await res.json().catch(() => ({}))) as { data?: T; error?: { message?: string } };
  if (!res.ok) throw new Error(json.error?.message ?? `HTTP ${res.status}`);
  return json.data as T;
}

export interface KnowledgeSource {
  startUrl: string;
  maxPages: number;
  pathPrefix?: string;
  includePatterns?: string[];
  excludePatterns?: string[];
  chunkChars: number;
  embeddingModel: string;
  rerank: boolean;
  updatedAt?: string;
}
export interface KnowledgeFileMeta {
  fileId: string;
  name: string;
  chunks: number;
  ingestedAt: string;
}
export interface KnowledgeMeta {
  status: 'none' | 'ready' | 'failed';
  chunkCount: number;
  generatedAt?: string;
  model?: string;
  source?: string;
  error?: string;
  files?: KnowledgeFileMeta[];
}
export interface IngestJob {
  id: string;
  tenantId: string;
  status: 'queued' | 'crawling' | 'embedding' | 'done' | 'failed';
  pagesCrawled: number;
  chunks: number;
  embedded: number;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}
export interface QueryHit {
  title: string;
  url?: string;
  score: number;
  snippet: string;
}
export interface ScopeDef {
  id: string;
  label: string;
  description: string;
  base: boolean;
}
export interface TenantPolicyView {
  grantedScopes: string[];
  groups: Record<string, string[]>;
  accounts: Record<string, string[]>;
  departments: string[];
  users: { id: string; label: string }[];
  capabilities: ScopeDef[];
}

export const api = {
  login: (password: string) => req<{ token: string }>('POST', '/admin/auth/login', { password }),

  listTenants: () => req<Tenant[]>('GET', '/admin/tenants'),
  createTenant: (input: { name: string; allowedOrigins?: string[]; ssoSecret?: string }) =>
    req<{ tenant: Tenant; publishableKey: string }>('POST', '/admin/tenants', input),
  updateTenant: (
    id: string,
    patch: Partial<Pick<Tenant, 'name' | 'allowedOrigins' | 'ssoSecret' | 'appearance'>>,
  ) => req<Tenant>('PATCH', `/admin/tenants/${id}`, patch),
  deleteTenant: (id: string) => req<{ id: string }>('DELETE', `/admin/tenants/${id}`),
  listScopes: () => req<ScopeDef[]>('GET', '/admin/scopes'),
  getTenantPolicy: (id: string) => req<TenantPolicyView>('GET', `/admin/tenants/${id}/policy`),
  putTenantPolicy: (
    id: string,
    body: { grantedScopes: string[]; groups: Record<string, string[]>; accounts: Record<string, string[]> },
  ) => req<TenantPolicyView>('PUT', `/admin/tenants/${id}/policy`, body),

  createKey: (id: string, type: 'publishable' | 'secret') =>
    req<ApiKey>('POST', `/admin/tenants/${id}/keys`, { type }),

  listWebhooks: (id: string) => req<WebhookEndpoint[]>('GET', `/admin/tenants/${id}/webhooks`),
  createWebhook: (id: string, input: { url: string; secret?: string }) =>
    req<WebhookEndpoint>('POST', `/admin/tenants/${id}/webhooks`, input),
  toggleWebhook: (id: string, webhookId: string, disabled: boolean) =>
    req<WebhookEndpoint>('PATCH', `/admin/tenants/${id}/webhooks/${webhookId}`, { disabled }),
  deleteWebhook: (id: string, webhookId: string) =>
    req<{ id: string }>('DELETE', `/admin/tenants/${id}/webhooks/${webhookId}`),

  getUsage: (id: string) => req<Usage>('GET', `/admin/tenants/${id}/usage`),
  getTenantAudit: (id: string) => req<AuditEntry[]>('GET', `/admin/tenants/${id}/audit`),

  // ---- Form Designer ----
  listForms: (id: string) => req<FormSummary[]>('GET', `/admin/tenants/${id}/forms`),
  getForm: (id: string, formId: string) =>
    req<Definition>('GET', `/admin/tenants/${id}/forms/${formId}`),
  createForm: (id: string, def: Definition) =>
    req<Definition>('POST', `/admin/tenants/${id}/forms`, def),
  updateForm: (id: string, formId: string, def: Definition) =>
    req<Definition>('PUT', `/admin/tenants/${id}/forms/${formId}`, def),
  deleteForm: (id: string, formId: string) =>
    req<{ formId: string }>('DELETE', `/admin/tenants/${id}/forms/${formId}`),
  exportForm: (id: string, formId: string) =>
    req<FormExport>('GET', `/admin/tenants/${id}/forms/${formId}/export`),

  // ---- 知識庫 RAG ----
  getKnowledge: (id: string) =>
    req<{ source: KnowledgeSource; meta: KnowledgeMeta; runningJob: IngestJob | null }>(
      'GET',
      `/admin/tenants/${id}/knowledge`,
    ),
  saveKnowledgeSource: (id: string, src: Omit<KnowledgeSource, 'updatedAt'>) =>
    req<KnowledgeSource>('PUT', `/admin/tenants/${id}/knowledge/source`, src),
  startKnowledgeIngest: (id: string, body?: Partial<KnowledgeSource>) =>
    req<{ jobId: string; status: string }>('POST', `/admin/tenants/${id}/knowledge/ingest`, body ?? {}),
  getKnowledgeJob: (id: string, jobId: string) =>
    req<IngestJob>('GET', `/admin/tenants/${id}/knowledge/jobs/${jobId}`),
  knowledgeQueryTest: (id: string, question: string) =>
    req<{ hits: QueryHit[] }>('POST', `/admin/tenants/${id}/knowledge/query-test`, { question }),
  deleteKnowledge: (id: string) =>
    req<{ ok: boolean }>('DELETE', `/admin/tenants/${id}/knowledge`),
  uploadKnowledgeFile: (id: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return reqUpload<KnowledgeFileMeta>('POST', `/admin/tenants/${id}/knowledge/files`, form);
  },
  deleteKnowledgeFile: (id: string, fileId: string) =>
    req<{ fileId: string }>('DELETE', `/admin/tenants/${id}/knowledge/files/${fileId}`),
};
