/**
 * 一次性遷移：把租戶的 disabledServices/disabledForms（opt-out）反轉為 grantedScopes（opt-in），
 * 保留既有行為。以 scopesMigrated 旗標確保只跑一次——事後管理者的授予調整不會被復原。
 */
import { SERVICE_SCOPE_IDS, formScopeId } from './scope-catalog';
import { listDefinitions } from '@/modules/form/form.registry';
import { tenantStore } from '@/modules/tenant/tenant.store';

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
