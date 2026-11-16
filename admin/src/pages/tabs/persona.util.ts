/**
 * AI 角色設定的純函式（外觀頁與其測試共用）。
 */
import type { AssistantPersona } from "@hyagent/shared";

/** 送給 PATCH 的角色設定：每一側整包取代；預設角色且沒有任何文字的一側送 null（清除，回到原本行為） */
export type PersonaPatch = {
  member: AssistantPersona["member"] | null;
  guest: AssistantPersona["guest"] | null;
};

export function toPersonaPatch(value: AssistantPersona): PersonaPatch {
  const memberNotes = value.member?.notes?.trim();
  const member =
    value.member && (value.member.preset !== "default" || memberNotes)
      ? { preset: value.member.preset, ...(memberNotes ? { notes: memberNotes } : {}) }
      : null;
  const guestNotes = value.guest?.notes?.trim();
  const guestContact = value.guest?.contact?.trim();
  const guest =
    value.guest && (value.guest.preset !== "default" || guestNotes || guestContact)
      ? {
          preset: value.guest.preset,
          ...(guestNotes ? { notes: guestNotes } : {}),
          ...(guestContact ? { contact: guestContact } : {}),
        }
      : null;
  return { member, guest };
}

/** 知識庫規則草稿：每側 null＝用內建，陣列＝自訂（只含可改規則） */
export type RulesDraft = { member: string[] | null; guest: string[] | null };

/** GET knowledge-rules 的回應：每側的內建可改規則、鎖定規則與已存的自訂 */
export type RulesInfo = Record<"member" | "guest", { defaults: string[]; locked: string[]; custom: string[] | null }>;

/** 存檔用：去掉空白項目；與內建完全相同的一側送 null（未自訂，之後內建更新會跟著更新） */
export function toRulesPatch(draft: RulesDraft, info: RulesInfo): RulesDraft {
  const side = (key: "member" | "guest"): string[] | null => {
    const list = draft[key];
    if (list === null) return null;
    const clean = list.map((t) => t.trim()).filter(Boolean);
    return JSON.stringify(clean) === JSON.stringify(info[key].defaults) ? null : clean;
  };
  return { member: side("member"), guest: side("guest") };
}
