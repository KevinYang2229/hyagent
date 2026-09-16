/**
 * 知識庫可見性：把「這個人能看到哪些標籤」與「本租戶目前的 ACL 階段」收斂成單一入口。
 *
 * 檢索器不接受外部傳入的 scopes——權限計算只有一份且不接受外部輸入，
 * 才是 fail-closed 守得住的形狀。呼叫端只交出身分（RetrievalPrincipal）。
 *
 * 過濾無條件生效，沒有每租戶開關：曾有 off/shadow/on 三態旗標（Tenant.knowledgeAcl），
 * 預設 off＝完全不過濾，等於安全開關的預設值指向不安全那一邊；shadow 的量測又以
 * file_id 為 key，網站來源的 chunk（file_id 為 NULL）從不進統計，對主力語料是爬取
 * 網站的租戶恆報「零影響」。三態在 4eb0aaf 併為恆 on，此處不再有模式判斷。
 */
import { resolveScopes, resolveGuestScopes } from '@/modules/authz/resolve-scopes';
import { isKbScope } from '@/modules/authz/scope-catalog';
import { knowledgeStore } from './knowledge.store';
import { env } from '@/config/env';
import { connectDb } from '@/lib/db';
import type { RetrievalPrincipal } from './retriever.types';

/**
 * 該 principal 可見的標籤 scope。無任何標籤時回空陣列——
 * SQL 的 `visibility_scopes && '{}'` 恆為 false，fail-closed 由語意自動給予，
 * 不需要額外防守碼。
 */
export function visibilityScopesOf(principal: RetrievalPrincipal): string[] {
  return resolveScopes(principal).filter(isKbScope);
}

/** Guest scopes never inherit a real account with the same ID as the tenant. */
export function guestVisibilityScopesOf(tenantId: string): string[] {
  return resolveGuestScopes(tenantId).filter(isKbScope);
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

/** Read current metadata so cached indexes cannot retain revoked access. */
export function currentChunkScopes(tenantId: string, chunk: { fileId?: string; visibilityScopes?: string[] }): string[] {
  if (chunk.fileId) {
    const file = knowledgeStore.getMeta(tenantId).files?.find((f) => f.fileId === chunk.fileId);
    if (file) return file.visibilityScopes ?? [];
  } else {
    const source = knowledgeStore.getSource(tenantId);
    if (source.visibilityScopes !== undefined) return source.visibilityScopes;
  }
  return chunk.visibilityScopes ?? [];
}

/** Website projections must change immediately, without waiting for re-ingestion. */
export async function setSourceVisibility(tenantId: string, scopes: string[]): Promise<void> {
  if (env.DATA_BACKEND !== 'db') return;
  const db = await connectDb();
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`
      update knowledge_chunks set visibility_scopes = ${scopes}::text[]
      where tenant_id = ${tenantId} and file_id is null`;
    await tx.$executeRaw`
      update knowledge_tables set visibility_scopes = ${scopes}::text[]
      where tenant_id = ${tenantId} and file_id is null`;
  });
}
