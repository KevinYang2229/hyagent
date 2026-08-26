/**
 * 知識庫可見性：把「這個人能看到哪些標籤」與「本租戶目前的 ACL 階段」收斂成單一入口。
 *
 * 檢索器不接受外部傳入的 scopes——權限計算只有一份且不接受外部輸入，
 * 才是 fail-closed 守得住的形狀。呼叫端只交出身分（RetrievalPrincipal）。
 */
import { resolveScopes } from '@/modules/authz/resolve-scopes';
import { isKbScope } from '@/modules/authz/scope-catalog';
import { env } from '@/config/env';
import { connectDb } from '@/lib/db';
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

/**
 * 設定某檔的可見性標籤，同時更新兩張表的投影。
 *
 * 兩句**必須同一交易且封裝成單一函式**：漏掉 knowledge_tables 就是一道側門，
 * 症狀為「文件鎖起來了，但問它裡面的表格數字還是答得出來」。
 * 不碰 embedding——標籤與向量無關，改標籤不重算、不重爬、不花 token。
 *
 * 真相來源在 KnowledgeFileMeta.visibilityScopes，呼叫端須一併更新（見 admin controller）。
 */
export async function setFileVisibility(
  tenantId: string,
  fileId: string,
  scopes: string[],
): Promise<void> {
  if (env.DATA_BACKEND !== 'db') return;
  const db = await connectDb();
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`
      update knowledge_chunks set visibility_scopes = ${scopes}::text[]
      where tenant_id = ${tenantId} and file_id = ${fileId}`;
    await tx.$executeRaw`
      update knowledge_tables set visibility_scopes = ${scopes}::text[]
      where tenant_id = ${tenantId} and file_id = ${fileId}`;
  });
}
