/**
 * 後台路由規則表：決定租戶管理者能不能呼叫某個 adminRouter 路由。
 *
 * - pattern 相對於 adminRouter；`:name` 比對一段，結尾 `/**` 比對零到多段。
 * - 由上往下比對，第一個符合的規則生效；沒列到的路由落到最後的兜底（super）。
 * - 比對跟 Express 一樣寬鬆：字面段落不分大小寫、結尾 `/` 先去掉；params 先 decode。
 * - HEAD 視同 GET。
 */
import type {
  AdminTabKey as SharedAdminTabKey,
  AdminTabLevel,
  AdminTabPermissions,
} from '@hyagent/shared';

// Server 執行期不直接 import @hyagent/shared（部署映像僅帶編譯後的 server/dist，
// 見 form/field-links.ts），所以分頁清單與 tabLevel 在此另存一份；只用 import type 取型別。
export const ADMIN_TAB_KEYS = [
  'settings',
  'ai',
  'sso',
  'users',
  'directorySync',
  'knowledge',
  'forms',
  'permissions',
  'appearance',
  'webhook',
  'usage',
  'feedback',
  'reports',
  'audit',
] as const;

export type AdminTabKey = (typeof ADMIN_TAB_KEYS)[number];

// 編譯期檢查：與 shared 的 AdminTabKey 雙向相同，任一邊漏改就會讓 tsc 失敗
type Assert<T extends true> = T;
export type AdminTabKeysInSync = Assert<
  [AdminTabKey] extends [SharedAdminTabKey]
    ? [SharedAdminTabKey] extends [AdminTabKey] ? true : false
    : false
>;

export function tabLevel(p: AdminTabPermissions, tab: AdminTabKey): AdminTabLevel {
  return p[tab] ?? 'hidden';
}

export type RouteAccess =
  | { kind: 'public' }
  | { kind: 'super' }
  | { kind: 'self' }
  | { kind: 'tenant' }
  | { kind: 'tab'; tab: AdminTabKey; alsoReadableBy?: AdminTabKey[] }
  | { kind: 'tenantPatch' };

export interface RouteRule {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | '*';
  pattern: string;
  access: RouteAccess;
}

const tab = (t: AdminTabKey, alsoReadableBy?: AdminTabKey[]): RouteAccess =>
  alsoReadableBy ? { kind: 'tab', tab: t, alsoReadableBy } : { kind: 'tab', tab: t };

export const ADMIN_ROUTE_RULES: RouteRule[] = [
  { method: 'POST', pattern: '/auth/login', access: { kind: 'public' } },
  { method: 'GET', pattern: '/me', access: { kind: 'self' } },
  { method: 'PUT', pattern: '/me/password', access: { kind: 'self' } },
  { method: '*', pattern: '/tenants/:id/admin-accounts/**', access: { kind: 'super' } },
  { method: 'GET', pattern: '/tenants/:id', access: { kind: 'tenant' } },
  { method: 'PATCH', pattern: '/tenants/:id', access: { kind: 'tenantPatch' } },
  { method: 'POST', pattern: '/tenants/:id/keys', access: tab('settings') },
  { method: '*', pattern: '/tenants/:id/llm-config', access: tab('ai') },
  { method: '*', pattern: '/tenants/:id/assertion-keys/**', access: tab('sso') },
  { method: '*', pattern: '/tenants/:id/assertion-settings', access: tab('sso') },
  { method: '*', pattern: '/tenants/:id/sessions/**', access: tab('sso') },
  { method: '*', pattern: '/tenants/:id/users/**', access: tab('users') },
  { method: '*', pattern: '/tenants/:id/departments/**', access: tab('users') },
  { method: '*', pattern: '/tenants/:id/directory-sync/**', access: tab('directorySync', ['users']) },
  { method: '*', pattern: '/tenants/:id/knowledge/**', access: tab('knowledge') },
  { method: '*', pattern: '/tenants/:id/forms/**', access: tab('forms') },
  { method: '*', pattern: '/tenants/:id/policy', access: tab('permissions', ['knowledge']) },
  { method: '*', pattern: '/tenants/:id/webhooks/**', access: tab('webhook') },
  { method: 'GET', pattern: '/tenants/:id/usage', access: tab('usage') },
  { method: '*', pattern: '/tenants/:id/feedback/**', access: tab('feedback') },
  { method: '*', pattern: '/tenants/:id/reports/**', access: tab('reports') },
  { method: 'GET', pattern: '/tenants/:id/audit', access: tab('audit') },
  // 兜底：/tenants 列表與建立、刪除租戶、/skills、/scopes、/mcp-servers/**、/db-intelligence/**、/audit，
  // 以及所有沒列到的路由，只有超級管理者能用
  { method: '*', pattern: '/**', access: { kind: 'super' } },
];

/** PATCH /tenants/:id 各欄位歸屬的分頁；`super` 表示只有超級管理者能改。 */
export const TENANT_PATCH_FIELDS: Record<string, AdminTabKey | 'super'> = {
  name: 'settings',
  allowedOrigins: 'settings',
  guestAccess: 'settings',
  egressPolicy: 'settings',
  appearance: 'appearance',
  quotaMonthlyLlmTokens: 'super',
};

const TAB_LABELS: Record<AdminTabKey, string> = {
  settings: '基本設定',
  ai: 'AI 設定',
  sso: '單一登入',
  users: '使用者',
  directorySync: '目錄同步',
  knowledge: '知識庫',
  forms: '表單',
  permissions: '權限',
  appearance: '外觀',
  webhook: 'Webhook',
  usage: '用量',
  feedback: '回饋',
  reports: '報告',
  audit: '稽核',
};

interface CompiledRule {
  rule: RouteRule;
  regex: RegExp;
  names: string[];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compile(rule: RouteRule): CompiledRule {
  const names: string[] = [];
  let pattern = rule.pattern;
  let tail = '';
  if (pattern.endsWith('/**')) {
    pattern = pattern.slice(0, -3);
    tail = '(?:/.*)?';
  }
  const body = pattern
    .split('/')
    .filter((seg) => seg !== '')
    .map((seg) => {
      if (seg.startsWith(':')) {
        names.push(seg.slice(1));
        return '/([^/]+)';
      }
      return `/${escapeRegex(seg)}`;
    })
    .join('');
  return { rule, regex: new RegExp(`^${body}${tail}$`, 'i'), names };
}

const COMPILED: CompiledRule[] = ADMIN_ROUTE_RULES.map(compile);

export function findRouteRule(
  method: string,
  path: string,
): { rule: RouteRule; params: Record<string, string> } | null {
  let m = method.toUpperCase();
  if (m === 'HEAD') m = 'GET';
  const normalized = path.length > 1 ? path.replace(/\/+$/, '') : path;
  for (const c of COMPILED) {
    if (c.rule.method !== '*' && c.rule.method !== m) continue;
    const match = c.regex.exec(normalized);
    if (!match) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < c.names.length; i += 1) {
      try {
        params[c.names[i]] = decodeURIComponent(match[i + 1]);
      } catch {
        ok = false; // 壞的 encoding 視為不符合
        break;
      }
    }
    if (ok) return { rule: c.rule, params };
  }
  return null;
}

type Decision = { allow: true } | { allow: false; reason: string };

const deny = (reason: string): Decision => ({ allow: false, reason });

export function decideTenantAdmin(input: {
  method: string;
  path: string;
  body: unknown;
  tenantId: string;
  permissions: AdminTabPermissions;
}): Decision {
  const found = findRouteRule(input.method, input.path);
  if (!found || found.rule.access.kind === 'super') return deny('只有超級管理者能執行這項操作');
  const { access } = found.rule;
  if (access.kind === 'public' || access.kind === 'self') return { allow: true };

  if (found.params.id !== input.tenantId) return deny('只能管理自己的租戶');
  if (access.kind === 'tenant') return { allow: true };

  const { permissions } = input;
  if (access.kind === 'tab') {
    const isRead = ['GET', 'HEAD'].includes(input.method.toUpperCase());
    if (isRead) {
      const readable = [access.tab, ...(access.alsoReadableBy ?? [])].some(
        (t) => tabLevel(permissions, t) !== 'hidden',
      );
      return readable ? { allow: true } : deny(`沒有『${TAB_LABELS[access.tab]}』的檢視權限`);
    }
    return tabLevel(permissions, access.tab) === 'write'
      ? { allow: true }
      : deny(`沒有『${TAB_LABELS[access.tab]}』的編輯權限`);
  }

  // tenantPatch：每個欄位都要有對應分頁的編輯權限
  const body = input.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return deny('請求內容格式不正確');
  }
  const keys = Object.keys(body);
  if (keys.length === 0) return deny('沒有可修改的欄位');
  for (const key of keys) {
    const owner = Object.prototype.hasOwnProperty.call(TENANT_PATCH_FIELDS, key)
      ? TENANT_PATCH_FIELDS[key]
      : undefined;
    if (owner === undefined) return deny(`不能修改欄位「${key}」`);
    if (owner === 'super') return deny('只有超級管理者能修改月度 token 配額');
    if (tabLevel(permissions, owner) !== 'write') return deny(`沒有『${TAB_LABELS[owner]}』的編輯權限`);
  }
  return { allow: true };
}
