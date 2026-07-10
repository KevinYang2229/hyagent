/**
 * Mock 使用者目錄（MVP）：以 userId 對應姓名 / 部門 / 職稱，並提供職務代理人候選名冊。
 * 之後接真實 HR / OA 來源時，只要換這層實作，對外介面不變。
 */
import type { Applicant } from "@oa-agent/shared";

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

/** 取申請人 profile；未知帳號回退為「以 userId 當顯示名、部門未知」 */
export function getApplicant(userId: string): Applicant {
  const profile = DIRECTORY[userId];
  return profile
    ? { id: userId, ...profile }
    : { id: userId, name: userId, department: "—" };
}

/** 是否為目錄中的已知帳號（登入時用，未知帳號不可登入） */
export function isKnownUser(userId: string): boolean {
  return Object.prototype.hasOwnProperty.call(DIRECTORY, userId);
}

/** 已知帳號清單（登入頁提示用） */
export function listUserIds(): string[] {
  return Object.keys(DIRECTORY);
}

/** 目錄中出現過的部門清單（去重）；admin 權限設定的部門來源。 */
export function listDepartments(): string[] {
  const set = new Set<string>();
  for (const p of Object.values(DIRECTORY)) if (p.department) set.add(p.department);
  for (const p of PEOPLE) if (p.department) set.add(p.department);
  return [...set];
}

/**
 * 查詢可擔任職務代理人的候選名冊。
 *
 * 候選人「一律來自使用者的『我的最愛』」——可被推薦／指定的代理人只能是最愛內的人員。
 * department 為選填：在「我的最愛」之內再依部門名稱（模糊比對）篩選；省略則回全部最愛。
 */
export function listDeputyCandidates(opts: {
  requesterId: string;
  department?: string;
}): Applicant[] {
  const { requesterId, department } = opts;
  const favIds = FAVORITES[requesterId] ?? [];
  let pool = PEOPLE.filter((p) => favIds.includes(p.id));

  const dept = department?.trim();
  if (dept) {
    pool = pool.filter((p) => p.department.includes(dept) || dept.includes(p.department));
  }
  return pool;
}
