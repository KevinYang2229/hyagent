/**
 * 一次性遷移：把租戶的 disabledServices/disabledForms（opt-out）反轉為 grantedScopes（opt-in），
 * 保留既有行為。以 scopesMigrated 旗標確保只跑一次——事後管理者的授予調整不會被復原。
 */
import { SERVICE_SCOPE_IDS, formScopeId } from './scope-catalog';
import { listDefinitions } from '@/modules/form/form.registry';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { UNASSIGNED_MEMBER_DEPARTMENT, UNKNOWN_DEPARTMENT } from '@/modules/user/user.directory';
import { scopePolicy } from './scope-policy';

/** 建租戶用：標準服務 + 該租戶內建表單全部授予。 */
export function defaultGrantedScopes(tenantId: string): string[] {
  const forms = listDefinitions(tenantId).map((d) => formScopeId(d.formId));
  return [...SERVICE_SCOPE_IDS, ...forms];
}

export function migrateTenantScopes(): void {
  for (const t of tenantStore.listTenants()) {
    if (t.scopesMigrated) continue;
    const disabledSvc = new Set(t.disabledServices ?? []);
    const disabledForm = new Set(t.disabledForms ?? []);
    const services = [...SERVICE_SCOPE_IDS].filter((s) => !disabledSvc.has(s.replace('service:', '')));
    const forms = listDefinitions(t.id)
      .map((d) => d.formId)
      .filter((id) => !disabledForm.has(id))
      .map(formScopeId);
    const merged = [...new Set([...(t.grantedScopes ?? []), ...services, ...forms])];
    tenantStore.updateTenant(t.id, { grantedScopes: merged, scopesMigrated: true });
  }
}

/**
 * 一次性遷移：把訪客桶（'—'）的部門授權複製給「未指定部門」桶（UNASSIGNED_MEMBER_DEPARTMENT）。
 *
 * 以前「未指定部門的登入帳號」與網站訪客共用 '—'；拆開後若不複製，這些帳號會突然失去原本經由
 * '—' 取得的角色。複製後兩邊權限與遷移前完全相同，管理者再各自調整。
 * 新桶已有設定時不覆寫；以 unassignedDepartmentMigrated 旗標確保只跑一次。
 */
export function migrateUnassignedDepartment(): void {
  for (const t of tenantStore.listTenants()) {
    if (t.unassignedDepartmentMigrated) continue;
    const policy = scopePolicy.getPolicy(t.id);
    const groups = { ...policy.groups };
    const groupBundles = { ...(policy.groupBundles ?? {}) };
    let changed = false;
    if ((groups[UNKNOWN_DEPARTMENT] ?? []).length > 0 && groups[UNASSIGNED_MEMBER_DEPARTMENT] === undefined) {
      groups[UNASSIGNED_MEMBER_DEPARTMENT] = [...groups[UNKNOWN_DEPARTMENT]];
      changed = true;
    }
    if ((groupBundles[UNKNOWN_DEPARTMENT] ?? []).length > 0 && groupBundles[UNASSIGNED_MEMBER_DEPARTMENT] === undefined) {
      groupBundles[UNASSIGNED_MEMBER_DEPARTMENT] = [...groupBundles[UNKNOWN_DEPARTMENT]];
      changed = true;
    }
    if (changed) scopePolicy.setPolicy(t.id, { ...policy, groups, groupBundles });
    tenantStore.updateTenant(t.id, { unassignedDepartmentMigrated: true });
  }
}
