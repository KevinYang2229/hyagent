/**
 * Mock 使用者目錄（MVP）：以 userId 對應姓名 / 部門 / 職稱，並提供職務代理人候選名冊。
 * 之後接真實 HR / OA 來源時，只要換這層實作，對外介面不變。
 */
import type { Applicant } from "@hyagent/shared";
import { env } from '@/config/env';
import { tenantStore } from '@/modules/tenant/tenant.store';

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

/** The development directory is available only in the default development tenant. */
function directory(tenantId: string): Array<Applicant & { deputyIds?: string[] }> {
  const configured = tenantStore.getTenant(tenantId)?.userDirectory;
  if (configured !== undefined) return configured;
  if (tenantId !== 'default' || env.NODE_ENV === 'production') return [];
  return Object.entries(DIRECTORY).map(([id, profile]) => ({ id, ...profile, deputyIds: FAVORITES[id] }));
}

export function getApplicant(userId: string, tenantId = 'default'): Applicant {
  const profile = directory(tenantId).find((p) => p.id === userId);
  if (!profile) return { id: userId, name: userId, department: UNKNOWN_DEPARTMENT };
  const { deputyIds: _deputyIds, ...applicant } = profile;
  return { ...applicant };
}

/** Only the built-in development accounts support the development password. */
export function isKnownUser(userId: string): boolean {
  return env.NODE_ENV !== 'production' && Object.prototype.hasOwnProperty.call(DIRECTORY, userId);
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
