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
