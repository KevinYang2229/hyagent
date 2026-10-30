import type { ScopeDef, SkillBundle, TenantPolicyView } from '../../api';
import { formatDepartment, UNKNOWN_DEPARTMENT } from '../../components/department.util';

/**
 * 權限頁（只有角色）的純邏輯：能力分類、相依規則、缺漏檢查、個人有效權限。
 * 與後端 resolve-scopes 的聯集模型一致：個人權限 = 套用給所有人的角色 ∪ 所屬部門的角色 ∪ 直接指派的角色。
 */

export type CapabilityCategory = 'service' | 'form' | 'kb' | 'external';

export const CATEGORY_LABELS: Record<CapabilityCategory, string> = {
  service: '服務',
  form: '表單',
  kb: '知識庫標籤',
  external: '外部能力',
};

export const FORM_SERVICE = 'service:form';
export const KNOWLEDGE_SERVICE = 'service:knowledge';
export const REPORT_SERVICE = 'service:report';

const isForm = (id: string) => id.startsWith('form:');
export const isKb = (id: string) => id.startsWith('kb:');
export const isMcp = (id: string) => id.startsWith('mcp:');
/** mcp:<server>:<role> 是該服務內的角色，需要同時有 mcp:<server> 才用得到 */
const isMcpRole = (id: string) => isMcp(id) && id.split(':').length > 2;
const mcpServerOf = (id: string) => id.split(':').slice(0, 2).join(':');
const usesKnowledge = (scopes: string[]) => scopes.includes(KNOWLEDGE_SERVICE) || scopes.includes(REPORT_SERVICE);

export function categoryOf(id: string): CapabilityCategory {
  if (id.startsWith('service:')) return 'service';
  if (isForm(id)) return 'form';
  if (isKb(id)) return 'kb';
  return 'external';
}

export function groupCapabilities(capabilities: ScopeDef[]): { key: CapabilityCategory; label: string; items: ScopeDef[] }[] {
  return (Object.keys(CATEGORY_LABELS) as CapabilityCategory[]).map((key) => ({
    key,
    label: CATEGORY_LABELS[key],
    items: capabilities.filter((s) => categoryOf(s.id) === key),
  }));
}

/** 能力的顯示名稱；已不存在的能力（例如表單被刪）退回顯示 id */
export function capabilityLabel(capabilities: ScopeDef[], id: string): string {
  return capabilities.find((c) => c.id === id)?.label ?? id;
}

/**
 * 勾選／取消一項能力，並自動處理相依：
 * - 勾表單 → 補上「填表申請」；勾知識庫標籤 → 補上「知識庫問答」；勾服務內角色 → 補上該服務
 * - 取消「填表申請」→ 一併取消表單；取消服務 → 一併取消其角色；
 *   「知識庫問答」與「報告」都沒了 → 一併取消知識庫標籤
 * 回傳的 notice 讓畫面告訴管理者「系統替你多做了什麼」，不默默改。
 */
export function toggleCapability(scopes: string[], id: string, capabilities: ScopeDef[]): { scopes: string[]; notice?: string } {
  const label = (x: string) => capabilityLabel(capabilities, x);
  if (!scopes.includes(id)) {
    const next = [...scopes, id];
    if (isForm(id) && !next.includes(FORM_SERVICE)) {
      return { scopes: [...next, FORM_SERVICE], notice: `已一併開啟「${label(FORM_SERVICE)}」，表單需要它才能使用。` };
    }
    if (isKb(id) && !usesKnowledge(next)) {
      return { scopes: [...next, KNOWLEDGE_SERVICE], notice: `已一併開啟「${label(KNOWLEDGE_SERVICE)}」，知識庫標籤需要它才查得到文件。` };
    }
    if (isMcpRole(id) && !next.includes(mcpServerOf(id))) {
      const server = mcpServerOf(id);
      return { scopes: [...next, server], notice: `已一併開啟「${label(server)}」，服務內的角色需要它才能使用。` };
    }
    return { scopes: next };
  }
  let next = scopes.filter((s) => s !== id);
  let removed: string[] = [];
  if (id === FORM_SERVICE) removed = next.filter(isForm);
  else if (isMcp(id) && !isMcpRole(id)) removed = next.filter((s) => isMcpRole(s) && mcpServerOf(s) === id);
  else if ((id === KNOWLEDGE_SERVICE || id === REPORT_SERVICE) && !usesKnowledge(next)) removed = next.filter(isKb);
  if (removed.length === 0) return { scopes: next };
  next = next.filter((s) => !removed.includes(s));
  return { scopes: next, notice: `已一併取消 ${removed.map((s) => `「${label(s)}」`).join('、')}，少了「${label(id)}」就無法使用。` };
}

/**
 * 缺漏檢查：開了服務卻沒有內容、或選了內容卻少了服務。
 * 用在個人（所有角色的聯集）時是準確的；用在單一角色時只是提醒，其他角色可能已補足。
 */
export function capabilityGaps(scopes: string[], capabilities: ScopeDef[]): string[] {
  const label = (x: string) => capabilityLabel(capabilities, x);
  const gaps: string[] = [];
  const hasForms = capabilities.some((c) => isForm(c.id));
  if (scopes.includes(FORM_SERVICE) && hasForms && !scopes.some(isForm)) {
    gaps.push(`已開通「${label(FORM_SERVICE)}」，但沒有選任何表單，沒有表單可填。`);
  }
  if (!scopes.includes(FORM_SERVICE) && scopes.some(isForm)) {
    gaps.push(`選了表單，但沒有開通「${label(FORM_SERVICE)}」，表單無法使用。`);
  }
  if (usesKnowledge(scopes) && capabilities.some((c) => isKb(c.id)) && !scopes.some(isKb)) {
    gaps.push('已開通知識庫相關服務，但沒有選任何知識庫標籤：只查得到開放給所有人的網站內容，查不到檔案。');
  }
  if (!usesKnowledge(scopes) && scopes.some(isKb)) {
    gaps.push(`選了知識庫標籤，但沒有開通「${label(KNOWLEDGE_SERVICE)}」或「${label(REPORT_SERVICE)}」，標籤用不到。`);
  }
  for (const role of scopes.filter(isMcpRole)) {
    if (!scopes.includes(mcpServerOf(role))) gaps.push(`選了「${label(role)}」，但沒有開通「${label(mcpServerOf(role))}」，無法使用。`);
  }
  return gaps;
}

/** 套用給所有人＝連網站訪客一起開放，知識庫標籤與外部服務不可（與後端一致） */
export function everyoneBlockedScopes(scopes: string[]): string[] {
  return scopes.filter((s) => isKb(s) || isMcp(s));
}

/** 一個角色在編輯器裡的完整樣貌：能力＋套用對象 */
export interface RoleDraft {
  id: string;
  name: string;
  description?: string;
  scopes: string[];
  everyone: boolean;
  departments: string[];
  accounts: string[];
}

type RolePolicy = Pick<TenantPolicyView, 'bundles' | 'groupBundles' | 'accountBundles' | 'tenantBundles'>;

const keysHolding = (map: Record<string, string[]>, roleId: string) =>
  Object.keys(map).filter((k) => (map[k] ?? []).includes(roleId));

export function roleDraftOf(policy: RolePolicy, role: SkillBundle): RoleDraft {
  return {
    id: role.id,
    name: role.name,
    ...(role.description ? { description: role.description } : {}),
    scopes: [...role.scopes],
    everyone: policy.tenantBundles.includes(role.id),
    departments: keysHolding(policy.groupBundles, role.id),
    accounts: keysHolding(policy.accountBundles, role.id),
  };
}

/** 把編輯完的角色寫回政策：定義與三種套用對象一次更新 */
export function applyRoleDraft<P extends RolePolicy>(policy: P, draft: RoleDraft): P {
  const role: SkillBundle = {
    id: draft.id,
    name: draft.name.trim(),
    ...(draft.description?.trim() ? { description: draft.description.trim() } : {}),
    scopes: draft.scopes,
  };
  const exists = policy.bundles.some((b) => b.id === draft.id);
  const reassign = (map: Record<string, string[]>, targets: string[]) => {
    const next: Record<string, string[]> = {};
    for (const key of new Set([...Object.keys(map), ...targets])) {
      const others = (map[key] ?? []).filter((id) => id !== draft.id);
      next[key] = targets.includes(key) ? [...others, draft.id] : others;
    }
    return next;
  };
  return {
    ...policy,
    bundles: exists ? policy.bundles.map((b) => (b.id === draft.id ? role : b)) : [...policy.bundles, role],
    tenantBundles: draft.everyone
      ? [...new Set([...policy.tenantBundles, draft.id])]
      : policy.tenantBundles.filter((id) => id !== draft.id),
    groupBundles: reassign(policy.groupBundles, draft.departments),
    accountBundles: reassign(policy.accountBundles, draft.accounts),
  };
}

export function removeRole<P extends RolePolicy>(policy: P, roleId: string): P {
  const strip = (map: Record<string, string[]>) =>
    Object.fromEntries(Object.entries(map).map(([k, v]) => [k, v.filter((id) => id !== roleId)]));
  return {
    ...policy,
    bundles: policy.bundles.filter((b) => b.id !== roleId),
    tenantBundles: policy.tenantBundles.filter((id) => id !== roleId),
    groupBundles: strip(policy.groupBundles),
    accountBundles: strip(policy.accountBundles),
  };
}

/** 角色套用對象的摘要文字 */
export function targetSummary(draft: Pick<RoleDraft, 'everyone' | 'departments' | 'accounts'>, accountLabel: (id: string) => string): string {
  if (draft.everyone) return '所有人（含網站訪客）';
  const names = [...draft.departments.map(formatDepartment), ...draft.accounts.map(accountLabel)];
  if (names.length === 0) return '';
  return names.length > 4 ? `${names.slice(0, 4).join('、')} 等 ${names.length} 個` : names.join('、');
}

/** 權限頁可選的部門：目錄裡的部門，加上已無成員但仍套用了角色的部門 */
export function policyDepartments(policy: Pick<TenantPolicyView, 'departments' | 'groupBundles'>): string[] {
  const withRoles = Object.keys(policy.groupBundles).filter((k) => policy.groupBundles[k].length > 0);
  return [...new Set([...policy.departments, ...withRoles])];
}

/** 可檢視的人：目錄成員、訪客，以及目錄外但有直接指派的帳號（例如 SSO 使用者） */
export interface Person { kind: 'user' | 'guest'; id: string; label: string; department: string; inDirectory: boolean }

export function peopleOf(policy: Pick<TenantPolicyView, 'users' | 'accountBundles'>): Person[] {
  const listed = policy.users.map((u) => ({
    kind: 'user' as const, id: u.id, label: u.label, department: u.department ?? UNKNOWN_DEPARTMENT, inDirectory: true,
  }));
  const extra = Object.keys(policy.accountBundles)
    .filter((id) => policy.accountBundles[id].length > 0 && !policy.users.some((u) => u.id === id))
    .map((id) => ({ kind: 'user' as const, id, label: id, department: UNKNOWN_DEPARTMENT, inDirectory: false }));
  return [...listed, ...extra, { kind: 'guest', id: '', label: '網站訪客', department: UNKNOWN_DEPARTMENT, inDirectory: false }];
}

/** 某人取得某角色的途徑 */
export type RoleSource = { via: 'everyone' } | { via: 'department'; department: string } | { via: 'direct' };

/** 某人目前擁有的角色與途徑（同一角色可能同時從多個途徑取得） */
export function rolesOf(policy: RolePolicy, person: Person): { role: SkillBundle; sources: RoleSource[] }[] {
  return policy.bundles
    .map((role) => {
      const sources: RoleSource[] = [];
      if (policy.tenantBundles.includes(role.id)) sources.push({ via: 'everyone' });
      if ((policy.groupBundles[person.department] ?? []).includes(role.id)) sources.push({ via: 'department', department: person.department });
      if (person.kind === 'user' && (policy.accountBundles[person.id] ?? []).includes(role.id)) sources.push({ via: 'direct' });
      return { role, sources };
    })
    .filter((r) => r.sources.length > 0);
}

/**
 * 某人的有效能力與來源角色。套用給所有人的角色裡若有知識庫標籤或外部服務，
 * 後端不會生效（resolve-scopes 會濾掉），這裡同步排除，避免畫面說有、實際沒有。
 */
export function effectiveCapabilities(policy: RolePolicy, person: Person): { scope: string; roles: string[] }[] {
  const byScope = new Map<string, string[]>();
  for (const { role, sources } of rolesOf(policy, person)) {
    const onlyEveryone = sources.every((s) => s.via === 'everyone');
    for (const scope of role.scopes) {
      if (onlyEveryone && (isKb(scope) || isMcp(scope))) continue;
      byScope.set(scope, [...(byScope.get(scope) ?? []), role.name]);
    }
  }
  return [...byScope].map(([scope, roles]) => ({ scope, roles }));
}

/** 權限頁會送出的欄位；用來比對是否有未儲存變更 */
type EditablePolicy = Pick<TenantPolicyView, 'bundles' | 'groupBundles' | 'accountBundles' | 'tenantBundles'>;

/** 清單順序與空陣列不影響授權結果，正規化後再比，避免「勾了又取消」被誤判為有變更 */
function normalize(p: EditablePolicy): string {
  const map = (m: Record<string, string[]>) =>
    Object.fromEntries(
      Object.entries(m)
        .filter(([, v]) => v.length > 0)
        .map(([k, v]) => [k, [...v].sort()] as const)
        .sort(([a], [b]) => a.localeCompare(b)),
    );
  return JSON.stringify({
    bundles: p.bundles.map((b) => ({ ...b, scopes: [...b.scopes].sort() })),
    groupBundles: map(p.groupBundles),
    accountBundles: map(p.accountBundles),
    tenantBundles: [...p.tenantBundles].sort(),
  });
}

export function policyChanged(a: EditablePolicy, b: EditablePolicy): boolean {
  return normalize(a) !== normalize(b);
}
