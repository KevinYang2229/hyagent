import type {
  DirectorySyncView, DirectoryUser, FormSummary, KnowledgeAclReport, KnowledgeMeta, Tenant, TenantPolicyView,
} from '../../api';
import { GENERAL_SERVICES_ROLE_ID } from './permissions.util';

/**
 * 租戶總覽的設定檢查：依導入流程（接入 → 人員 → 內容 → 權限）列出每一步的狀態與下一步。
 * 純函式：資料由 OverviewTab 載入後傳入；某項資料載入失敗時傳 undefined，該項顯示「無法檢查」而不是誤報。
 */

export type CheckStatus = 'ok' | 'todo' | 'warn' | 'unknown';

export interface SetupCheck {
  id: string;
  /** 所屬步驟（與導覽分組同名） */
  step: '接入' | '人員與登入' | '內容與能力' | '權限';
  title: string;
  status: CheckStatus;
  /** 狀態說明；未完成時寫明後果 */
  detail: string;
  /** 前往處理的頁籤 key */
  tab: string;
  /** 額外的網址參數，例如知識庫子頁 { kb: 'access' } */
  query?: Record<string, string>;
  /** 是否為上線必要步驟（計入完成進度）；否則只是提醒 */
  required: boolean;
}

export interface OverviewData {
  tenant: Tenant;
  users?: DirectoryUser[];
  sync?: DirectorySyncView;
  policy?: TenantPolicyView;
  knowledge?: KnowledgeMeta;
  acl?: KnowledgeAclReport;
  forms?: FormSummary[];
}

const UNSPECIFIED = '—';
const unknown = (base: Omit<SetupCheck, 'status' | 'detail'>): SetupCheck => ({ ...base, status: 'unknown', detail: '資料載入失敗，無法檢查。' });

export function setupChecks(d: OverviewData): SetupCheck[] {
  const checks: SetupCheck[] = [];

  // ---- 接入 ----
  checks.push(d.tenant.allowedOrigins.length > 0
    ? { id: 'origins', step: '接入', title: '允許嵌入來源', status: 'ok', detail: `已設定 ${d.tenant.allowedOrigins.length} 個網域。`, tab: 'settings', required: true }
    : { id: 'origins', step: '接入', title: '允許嵌入來源', status: 'todo', detail: '尚未設定，聊天視窗無法嵌入任何網站。', tab: 'settings', required: true });

  // ---- 人員與登入 ----
  checks.push((d.tenant.activeKeyCount ?? 0) > 0
    ? { id: 'sso-key', step: '人員與登入', title: '自動登入公鑰', status: 'ok', detail: `有 ${d.tenant.activeKeyCount} 把有效公鑰。`, tab: 'sso', required: true }
    : { id: 'sso-key', step: '人員與登入', title: '自動登入公鑰', status: 'todo', detail: '沒有有效的簽章公鑰，員工無法透過自動登入進入。', tab: 'sso', required: true });

  const peopleBase = { id: 'directory', step: '人員與登入' as const, title: '人員來源', tab: 'users', required: true };
  if (!d.users || !d.sync) checks.push(unknown(peopleBase));
  else if (d.users.length > 0) checks.push({ ...peopleBase, status: 'ok', detail: `使用者目錄有 ${d.users.length} 位。` });
  else if (d.sync.ssoAutoProvision || d.sync.directorySyncEnabled) {
    checks.push({ ...peopleBase, status: 'ok', detail: '已開啟自動建檔／OA 同步，人員會在登入或同步後出現。' });
  } else {
    checks.push({ ...peopleBase, status: 'todo', detail: '目錄沒有人員，也沒有開啟自動建檔或 OA 同步，無法依部門授權。' });
  }

  if (d.users) {
    const noDept = d.users.filter((u) => !u.department || u.department === UNSPECIFIED).length;
    if (noDept > 0) {
      checks.push({ id: 'no-dept', step: '人員與登入', title: '未指定部門', status: 'warn', detail: `${noDept} 位未指定部門，目前與網站訪客同權限。`, tab: 'users', required: false });
    }
  }

  // ---- 內容與能力 ----
  const contentBase = { id: 'content', step: '內容與能力' as const, title: '知識或表單', tab: 'knowledge', required: true };
  if (!d.knowledge || !d.forms) checks.push(unknown(contentBase));
  else if (d.knowledge.status === 'ready' || d.forms.length > 0) {
    const parts = [d.knowledge.status === 'ready' ? `知識庫 ${d.knowledge.chunkCount} 個段落` : '', d.forms.length ? `${d.forms.length} 份表單` : ''].filter(Boolean);
    checks.push({ ...contentBase, status: 'ok', detail: `已有${parts.join('、')}。` });
  } else {
    checks.push({ ...contentBase, status: 'todo', detail: d.knowledge.status === 'failed' ? '知識庫索引建立失敗，也沒有表單。' : '尚未建立知識庫索引或表單，員工沒有內容可用。' });
  }

  if (d.acl) {
    if (d.acl.unlabeled.length > 0) {
      checks.push({ id: 'kb-unlabeled', step: '內容與能力', title: '檔案可見範圍', status: 'warn', detail: `${d.acl.unlabeled.length} 份檔案尚未設定標籤，目前無人可查詢。`, tab: 'knowledge', query: { kb: 'access' }, required: false });
    }
    if (d.acl.source.configured && d.acl.source.unlabeled) {
      checks.push({ id: 'kb-website', step: '內容與能力', title: '網站可查詢對象', status: 'warn', detail: '網站來源尚未設定可查詢對象，目前無人可查詢。', tab: 'knowledge', query: { kb: 'sources' }, required: false });
    }
  }

  // ---- 權限 ----
  const permBase = { id: 'roles', step: '權限' as const, title: '開放能力給員工', tab: 'permissions', required: true };
  if (!d.policy) checks.push(unknown(permBase));
  else {
    const p = d.policy;
    const applied = (id: string) => p.tenantBundles.includes(id) || p.memberBundles.includes(id)
      || Object.values(p.groupBundles).some((ids) => ids.includes(id)) || Object.values(p.accountBundles).some((ids) => ids.includes(id));
    const active = p.bundles.filter((b) => applied(b.id) && b.scopes.length > 0);
    checks.push(active.length > 0
      ? { ...permBase, status: 'ok', detail: `${active.length} 個角色已套用。` }
      : { ...permBase, status: 'todo', detail: '沒有任何角色套用給人，員工登入後沒有可用的服務。可在權限頁開啟「通用服務」。' });

    const general = p.bundles.find((b) => b.id === GENERAL_SERVICES_ROLE_ID);
    if (general && !p.memberBundles.includes(GENERAL_SERVICES_ROLE_ID)) {
      checks.push({ id: 'general', step: '權限', title: '通用服務', status: 'warn', detail: '通用服務群組尚未開啟；若員工都需要這些服務，可一鍵開啟。', tab: 'permissions', required: false });
    }
    // 開給所有人（含網站訪客）的能力：公開聊天視窗的訪客也能用，最容易被忽略
    const guestScopes = [...new Set(p.bundles.filter((b) => p.tenantBundles.includes(b.id)).flatMap((b) => b.scopes))];
    if (guestScopes.length > 0) {
      const label = (id: string) => p.capabilities.find((c) => c.id === id)?.label ?? id;
      const names = guestScopes.map(label);
      const shown = names.length > 4 ? `${names.slice(0, 4).join('、')} 等 ${names.length} 項` : names.join('、');
      checks.push({ id: 'guest-open', step: '權限', title: '開放給網站訪客的能力', status: 'warn', detail: `公開聊天視窗的訪客也能使用：${shown}。若只想給員工，請改用「通用服務」或指定部門。`, tab: 'permissions', required: false });
    }
    const idle = p.bundles.filter((b) => !applied(b.id) && b.id !== GENERAL_SERVICES_ROLE_ID);
    if (idle.length > 0) {
      checks.push({ id: 'idle-roles', step: '權限', title: '未套用的角色', status: 'warn', detail: `${idle.length} 個角色沒有套用給任何人，目前不會生效。`, tab: 'permissions', required: false });
    }
    if (p.convertedRoleIds.length > 0) {
      checks.push({ id: 'legacy', step: '權限', title: '舊版權限設定', status: 'warn', detail: '舊版權限已換算成角色但尚未儲存，請到權限頁確認後儲存。', tab: 'permissions', required: false });
    }
  }

  return checks;
}

/** 必要步驟的完成數 */
export function setupProgress(checks: SetupCheck[]): { done: number; total: number } {
  const required = checks.filter((c) => c.required);
  return { done: required.filter((c) => c.status === 'ok').length, total: required.length };
}
