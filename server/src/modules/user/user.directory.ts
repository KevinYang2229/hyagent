/**
 * Mock 使用者目錄（MVP）：以 userId 對應姓名 / 部門 / 職稱，並提供職務代理人候選名冊。
 * 之後接真實 HR / OA 來源時，只要換這層實作，對外介面不變。
 */
import type { Applicant } from "@hyagent/shared";
import { env } from '@/config/env';
import { currentSsoIdentity } from '@/lib/sso-identity.context';
import { tenantStore } from '@/modules/tenant/tenant.store';
import type { DirectoryEntry, Tenant } from '@/modules/tenant/tenant.types';

const DIRECTORY: Record<string, Omit<Applicant, "id">> = {
  kevin: { name: "Kevin Yang", department: "行銷部", title: "技術經理", region: "台北", email: "kevin@example.com" },
  hyweb: { name: "Eason Hsieh", department: "行銷部", title: "處長", region: "新竹", email: "hyweb@example.com" },
};

/**
 * 同事名冊（id 為工號），作為「我的最愛」的解析來源。
 * 之後接真實 HR 名錄時替換此來源即可。
 */
const PEOPLE: Applicant[] = [
  { id: "HYW018", name: "林佩蓉", department: "行銷部", title: "專員" },
  { id: "HYW042", name: "陳冠廷", department: "行銷部", title: "副理" },
  { id: "HYW067", name: "王思涵", department: "行銷部", title: "專員" },
  { id: "HYW103", name: "張哲瑋", department: "資訊部", title: "工程師" },
  { id: "HYW118", name: "李宛庭", department: "資訊部", title: "工程師" },
  { id: "HYW205", name: "黃郁文", department: "人資部", title: "專員" },
  { id: "HYW210", name: "周敏華", department: "人資部", title: "副理" },
  { id: "HYW301", name: "吳建宏", department: "業務部", title: "業務" },
  { id: "HYW312", name: "蔡依玲", department: "業務部", title: "業務" },
];

/** 「我的最愛」常用代理人：登入 userId → 工號清單（mock；之後接真實偏好設定來源） */
const FAVORITES: Record<string, string[]> = {
  kevin: ["HYW018", "HYW103", "HYW205"],
  hyweb: ["HYW042", "HYW210"],
};

/**
 * 未建檔帳號的部門。宿主經 SSO 簽發的訪客 sub 不在本目錄中，一律落在此桶；
 * 員工尚未建檔時同樣如此——最小權限，方向正確。
 * scopePolicy.groups 以部門字串為 key，故此值即公開 widget 的權限掛鉤點。
 */
export const UNKNOWN_DEPARTMENT = '—';

/**
 * 「已登入但沒有部門」帳號的權限桶。目錄裡這類帳號的部門仍存成 UNKNOWN_DEPARTMENT（'—'），
 * 只在權限解析時改用此鍵——讓網站訪客（'—'）與已登入員工不再共用同一組角色。
 * 值刻意不像部門名稱，不會與真實部門或 SSO deptName 撞名。
 */
export const UNASSIGNED_MEMBER_DEPARTMENT = '__unassigned__';

/** 免登入訪客 Session 的 sub 前綴（guest-session 由伺服器隨機產生，呼叫端無法指定） */
export const GUEST_SUB_PREFIX = 'guest_';

/**
 * 是否為訪客身分：沒有 userId（公開 widget），或伺服器產生的免登入訪客 sub。
 * 訪客只取得「所有人」與網站訪客桶的權限，不算「登入員工」——權限解析一律以此判斷，不要各自比對字串。
 */
export function isGuestPrincipal(userId: string): boolean {
  return !userId || userId.startsWith(GUEST_SUB_PREFIX);
}

/** 登入帳號在權限上的部門鍵：沒有部門時落在 UNASSIGNED_MEMBER_DEPARTMENT，而不是訪客桶 */
export function memberPermissionDepartment(department: string): string {
  return department === UNKNOWN_DEPARTMENT ? UNASSIGNED_MEMBER_DEPARTMENT : department;
}

/** The development directory is available only in the default development tenant. */
function directory(tenantId: string): DirectoryEntry[] {
  const configured = tenantStore.getTenant(tenantId)?.userDirectory;
  if (configured !== undefined) return configured;
  if (tenantId !== 'default' || env.NODE_ENV === 'production') return [];
  return Object.entries(DIRECTORY).map(([id, profile]) => ({ id, ...profile, deputyIds: FAVORITES[id] }));
}

/**
 * 由本次請求的 SSO 身分組出使用者資料（規格 §4.2.3 的 `hyagent:profile`）。
 *
 * 只認三個約定鍵：`companyName` → 公司、`deptName` → 部門、`jobPostName` → 職稱。規格說
 * HyAgent 對自訂 claims「不做語意解讀」，那是指**驗章**階段——驗的時候確實只看型別與大小。
 * 到了這裡是顯示與授權階段，總得決定哪個欄位是部門；選這三個鍵是因為規格 §4.2.3 自己就把
 * 它們列為既有 SSO 欄位的落點。其餘欄位（deptId、companyId…）原樣留在 Session 裡不解讀。
 *
 * ⚠️ 部門會成為知識庫 scopePolicy.groups 的比對值，等於租戶可用自家私鑰宣告旗下使用者
 * 的權限群組。這是刻意的：租戶本來就是自家人員資料的權威來源，且 Assertion 由它的私鑰
 * 簽出。真要收斂就在後台為該租戶建人員目錄——那份優先於本函式。
 */
function applicantFromSso(userId: string, tenantId: string): Applicant | undefined {
  const identity = currentSsoIdentity(userId, tenantId);
  if (!identity) return undefined;
  const claims = identity.profile ?? {};
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined;
  const name = text(identity.name);
  const department = text(claims.deptName);
  const title = text(claims.jobPostName);
  const company = text(claims.companyName);
  // 全都沒有＝這張 Assertion 只帶了 sub，沒有比 userId 更好的資料可用
  if (!name && !department && !title && !company) return undefined;
  return {
    id: userId,
    name: name ?? userId,
    department: department ?? UNKNOWN_DEPARTMENT,
    ...(title ? { title } : {}),
    ...(company ? { company } : {}),
  };
}

/**
 * 取使用者資料。來源優先序：
 *
 *   1. 該租戶在 HyAgent 的人員目錄。目錄項目有三種來源（DirectoryEntry.origin / syncedAt）：
 *      - 後台手動維護（origin 'manual' 或沒有 origin 的舊資料），且只有它帶得出代理人名冊（deputyIds）與地區；
 *      - 登入自動建立（origin 'sso'，租戶開 ssoAutoProvision）：首次登入時由 Assertion 寫入，
 *        尚未收到 webhook 前，後續登入會以 Assertion 更新；
 *      - OA webhook 同步（origin 'sync'，或已有 syncedAt）：一旦收到 webhook 就以它為準，
 *        登入不再更新。後台是否唯讀跟著負責的開關走（見 isFieldLocked）。
 *   2. 本次請求 SSO Assertion 帶進來的身分——租戶沒建目錄（或這位還沒建檔）時採用。
 *      這是 Widget SSO 的常態：整合方不必把員工資料同步給我們；未開自動建立時就一直走這條。
 *   3. 都沒有 → 以 userId 充當姓名、部門落在 UNKNOWN_DEPARTMENT（最小權限）。
 *
 * 例外：登入自動建立的項目，在 ssoAutoProvision 關閉後已沒有人會更新，繼續讀它會讓換了部門的人
 * 留著舊部門的權限。所以關閉後「本人」回到開啟前的行為（第 2 條），憑證只帶 sub 才退回目錄項目；
 * 查別人時沒有對方的憑證（currentSsoIdentity 只認本人），仍回目錄項目。
 */
export function getApplicant(userId: string, tenantId = 'default'): Applicant {
  const profile = directory(tenantId).find((p) => p.id === userId);
  if (!profile) {
    return applicantFromSso(userId, tenantId) ?? { id: userId, name: userId, department: UNKNOWN_DEPARTMENT };
  }
  if (profile.origin === 'sso' && profile.syncedAt === undefined && tenantStore.getTenant(tenantId)?.ssoAutoProvision !== true) {
    const fromLogin = applicantFromSso(userId, tenantId);
    if (fromLogin) return fromLogin;
  }
  const { deputyIds: _deputyIds, origin: _origin, syncedAt: _syncedAt, ...applicant } = profile;
  return { ...applicant };
}

/**
 * 可用帳密登入的帳號＝該租戶「當下生效」的目錄。
 *
 * 後台設定過人員目錄就以設定值為準（production 也算數）；沒設定才落到內建的開發名錄，
 * 而那份名錄只有非 production 的 default 租戶提供。換句話說，正式環境要開帳密登入
 * （AUTH_PASSWORD_LOGIN=on）必須先把該租戶的人員目錄建起來，不會因為開了開關就讓
 * 寫在 repo 裡的 mock 帳號能登入，也不會讓沒建目錄的租戶憑空多出可登入帳號。
 */
export function isKnownUser(userId: string, tenantId = 'default'): boolean {
  return directory(tenantId).some((p) => p.id === userId);
}

/**
 * 基本資料（姓名、部門等）目前是否由外部來源維護、後台不可手動改。
 * 鎖定跟著負責的開關走：開關關閉後沒有人會再更新這筆資料，再鎖就沒有人改得動了。
 */
export function isFieldLocked(
  entry: DirectoryEntry,
  tenant: Pick<Tenant, 'ssoAutoProvision' | 'directorySyncEnabled'>,
): boolean {
  if (entry.syncedAt !== undefined || entry.origin === 'sync') return tenant.directorySyncEnabled === true;
  if (entry.origin === 'sso') return tenant.ssoAutoProvision === true;
  return false;
}

/**
 * 可用帳密登入：在目錄內，且不是 SSO／同步建立的帳號（沒有 origin 的舊資料視同手動）。
 * SSO／同步帳號沒有人設定過密碼，若放行等於共用開發密碼就能登入任何一位同事。
 */
export function isPasswordLoginUser(userId: string, tenantId = 'default'): boolean {
  const entry = directory(tenantId).find((p) => p.id === userId);
  return entry !== undefined && (entry.origin === undefined || entry.origin === 'manual');
}

export function listUserIds(tenantId = 'default'): string[] {
  return directory(tenantId).map((p) => p.id);
}

export function listDepartments(tenantId = 'default'): string[] {
  const people = directory(tenantId);
  const mock = tenantId === 'default' && env.NODE_ENV !== 'production' && tenantStore.getTenant(tenantId)?.userDirectory === undefined;
  return [...new Set([...people, ...(mock ? PEOPLE : [])].map((p) => p.department).filter((d): d is string => Boolean(d)))];
}

export function listDeputyCandidates(opts: {
  tenantId?: string;
  requesterId: string;
  department?: string;
}): Applicant[] {
  const { tenantId = 'default', requesterId, department } = opts;
  const users = directory(tenantId);
  const favIds = users.find((p) => p.id === requesterId)?.deputyIds ?? [];
  const mock = tenantId === 'default' && env.NODE_ENV !== 'production' && tenantStore.getTenant(tenantId)?.userDirectory === undefined;
  return (mock ? PEOPLE : users)
    .filter((p) => favIds.includes(p.id))
    .filter((p) => !department || (p.department ?? '').includes(department))
    .map((p) => ({ id: p.id, name: p.name, department: p.department, title: p.title }));
}
