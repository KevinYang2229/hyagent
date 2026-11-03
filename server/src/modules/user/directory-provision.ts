/**
 * SSO 登入後，在背景建立或更新該員工的目錄項目（只在租戶開啟 ssoAutoProvision 時）。
 *
 * 最高原則：登入的成敗、回應與速度都不取決於這裡。所以：
 * - exchange 只排程（setImmediate），不 await；
 * - 排程出去的工作捕捉所有例外，連記錄日誌失敗也吞掉，不可能變成未處理例外；
 * - 日誌只帶 tenantId 與簡短原因，絕不含 sub、姓名或任何 claims。
 */
import { z } from 'zod';
import type { AssertionClaims } from '@/lib/assertion';
import { logger } from '@/lib/logger';
import { tenantStore } from '@/modules/tenant/tenant.store';
import type { DirectoryEntry } from '@/modules/tenant/tenant.types';
import { isStorableText } from '@/modules/user/directory-text';
import { UNKNOWN_DEPARTMENT } from '@/modules/user/user.directory';

/** 與 user.admin.ts 的 profile 一致：id 與各文字欄位上限 200 字元、目錄上限 10,000 人。 */
const MAX_FIELD_LENGTH = 200;
const MAX_DIRECTORY_USERS = 10_000;
const emailSchema = z.string().email();

function warn(tenantId: string, reason: string): void {
  logger.warn({ tenantId, reason }, 'sso directory provision skipped');
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= MAX_FIELD_LENGTH && isStorableText(trimmed) ? trimmed : undefined;
}

/** 欄位對應與 applicantFromSso 相同：name、hyagent:profile.deptName/jobPostName/companyName，另加頂層 email。 */
function entryFields(claims: AssertionClaims) {
  const raw = claims['hyagent:profile'];
  const profile = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const email = text(claims.email);
  const title = text(profile.jobPostName);
  const company = text(profile.companyName);
  return {
    name: text(claims.name) ?? claims.sub,
    department: text(profile.deptName) ?? UNKNOWN_DEPARTMENT,
    ...(title ? { title } : {}),
    ...(company ? { company } : {}),
    ...(email && emailSchema.safeParse(email).success ? { email } : {}),
  };
}

const COMPARED = ['name', 'department', 'title', 'company', 'email'] as const;

/**
 * 同步執行，可能拋錯（由 scheduleSsoProvision 捕捉）。
 * 從讀取租戶到 updateTenant 之間沒有 await，所以併發的兩次呼叫不會互相覆蓋。
 */
export function provisionFromClaims(tenantId: string, claims: AssertionClaims): void {
  const tenant = tenantStore.getTenant(tenantId);
  // 開關在執行當下再檢查一次：排程之後管理員可能已關掉
  if (!tenant || tenant.ssoAutoProvision !== true) return;

  const sub = claims.sub;
  if (typeof sub !== 'string' || !sub || sub.length > MAX_FIELD_LENGTH || sub !== sub.trim() || !isStorableText(sub)) {
    warn(tenantId, 'invalid_sub');
    return;
  }

  const users = tenant.userDirectory ?? [];
  const current = users.find((u) => u.id === sub);
  const fields = entryFields(claims);

  if (!current) {
    // 刪除紀錄不早於這張憑證的簽發時間：視為人已被刪除，不讓舊憑證讓他復活
    const deletedAt = tenant.directoryTombstones?.[sub];
    if (deletedAt !== undefined) {
      const deletedMs = Date.parse(deletedAt);
      if (!(deletedMs < claims.iat * 1000)) return;
    }
    if (users.length >= MAX_DIRECTORY_USERS) {
      warn(tenantId, 'directory_full');
      return;
    }
    tenantStore.updateTenant(tenantId, { userDirectory: [...users, { id: sub, ...fields, origin: 'sso' }] });
    return;
  }

  // 只有登入自己建立、且沒被 OA 同步接手的項目才由登入維護
  if (current.origin !== 'sso' || current.syncedAt !== undefined) return;
  if (COMPARED.every((key) => current[key] === (fields as Partial<DirectoryEntry>)[key])) return;

  // 憑證是完整資料：沒帶的 title／company／email 清除；deputyIds、region 保留
  const { title: _t, company: _c, email: _e, ...kept } = current;
  tenantStore.updateTenant(tenantId, {
    userDirectory: users.map((u) => (u === current ? { ...kept, ...fields } : u)),
  });
}

/** 登入路徑呼叫這個：下一個 tick 才執行，任何失敗都只記警告。 */
export function scheduleSsoProvision(tenantId: string, claims: AssertionClaims): void {
  setImmediate(() => {
    try {
      provisionFromClaims(tenantId, claims);
    } catch {
      try {
        warn(tenantId, 'provision_failed');
      } catch {
        // 連日誌都失敗也不能影響任何事
      }
    }
  });
}
