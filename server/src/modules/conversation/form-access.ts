import { resolveScopes } from '@/modules/authz/resolve-scopes';
import { formScopeId } from '@/modules/authz/scope-catalog';
import { AppError } from '@/utils/app-error';

export function assertFormAccess(tenantId: string, userId: string, formId: string): void {
  const scopes = new Set(resolveScopes({ tenantId, userId }));
  if (!formId || !scopes.has('service:form') || !scopes.has(formScopeId(formId))) {
    throw AppError.forbidden('無權使用此表單');
  }
}
