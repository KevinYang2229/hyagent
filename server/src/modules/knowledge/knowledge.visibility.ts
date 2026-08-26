/**
 * 知識庫可見性：把「這個人能看到哪些標籤」與「本租戶目前的 ACL 階段」收斂成單一入口。
 *
 * 檢索器不接受外部傳入的 scopes——權限計算只有一份且不接受外部輸入，
 * 才是 fail-closed 守得住的形狀。呼叫端只交出身分（RetrievalPrincipal）。
 */
import { resolveScopes } from '@/modules/authz/resolve-scopes';
import { isKbScope } from '@/modules/authz/scope-catalog';
import { tenantStore } from '@/modules/tenant/tenant.store';
import type { RetrievalPrincipal } from './retriever.types';

/** 該租戶目前的 ACL 階段；未設＝off（遷移預設，行為與導入前相同） */
export function aclModeOf(tenantId: string): 'off' | 'shadow' | 'on' {
  return tenantStore.getTenant(tenantId)?.knowledgeAcl ?? 'off';
}

/**
 * 該 principal 可見的標籤 scope。無任何標籤時回空陣列——
 * SQL 的 `visibility_scopes && '{}'` 恆為 false，fail-closed 由語意自動給予，
 * 不需要額外防守碼。
 */
export function visibilityScopesOf(principal: RetrievalPrincipal): string[] {
  return resolveScopes(principal).filter(isKbScope);
}
