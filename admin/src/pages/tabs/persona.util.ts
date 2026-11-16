/**
 * AI 角色頁籤的純函式（角色設定、知識庫規則；元件與測試共用）。
 */
import type { AssistantPersona } from "@hyagent/shared";

/** 送給 PATCH 的角色設定：每一側整包取代；預設角色且沒有任何文字的一側送 null（清除，回到原本行為） */
export type PersonaPatch = {
  member: AssistantPersona["member"] | null;
  guest: AssistantPersona["guest"] | null;
};

/** 依功能覆寫表：去掉空值；一個都沒有時回 undefined（不送） */
function cleanServices<T extends string>(services?: Partial<Record<string, T>>): Partial<Record<string, T>> | undefined {
  if (!services) return undefined;
  const entries = Object.entries(services).filter(([, v]) => !!v);
  return entries.length ? (Object.fromEntries(entries) as Partial<Record<string, T>>) : undefined;
}

export function toPersonaPatch(value: AssistantPersona): PersonaPatch {
  const memberNotes = value.member?.notes?.trim();
  const memberServices = cleanServices(value.member?.services);
  const member =
    value.member && (value.member.preset !== "default" || memberNotes || memberServices)
      ? {
          preset: value.member.preset,
          ...(memberNotes ? { notes: memberNotes } : {}),
          ...(memberServices ? { services: memberServices } : {}),
        }
      : null;
  const guestNotes = value.guest?.notes?.trim();
  const guestContact = value.guest?.contact?.trim();
  const guestServices = cleanServices(value.guest?.services);
  const guest =
    value.guest && (value.guest.preset !== "default" || guestNotes || guestContact || guestServices)
      ? {
          preset: value.guest.preset,
          ...(guestNotes ? { notes: guestNotes } : {}),
          ...(guestContact ? { contact: guestContact } : {}),
          ...(guestServices ? { services: guestServices } : {}),
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
