import { useState } from "react";
import {
  GUEST_PERSONA_PRESETS,
  MEMBER_PERSONA_PRESETS,
  PERSONA_SERVICES,
  type AssistantPersona,
  type PersonaPresetMeta,
  type PersonaServiceKey,
  type GuestPersonaPresetId,
  type MemberPersonaPresetId,
} from "@hyagent/shared";

const NOTES_MAX = 500;
const CONTACT_MAX = 200;

export default function PersonaSection({
  value,
  onChange,
}: {
  value: AssistantPersona;
  onChange: (next: AssistantPersona) => void;
}) {
  const member = value.member ?? { preset: "default" as MemberPersonaPresetId };
  const guest = value.guest ?? { preset: "default" as GuestPersonaPresetId };
  const memberHint = MEMBER_PERSONA_PRESETS.find((p) => p.id === member.preset)?.hint;
  const guestHint = GUEST_PERSONA_PRESETS.find((p) => p.id === guest.preset)?.hint;

  const setMember = (patch: Partial<NonNullable<AssistantPersona["member"]>>) =>
    onChange({ ...value, member: { ...member, ...patch } });
  const setGuest = (patch: Partial<NonNullable<AssistantPersona["guest"]>>) =>
    onChange({ ...value, guest: { ...guest, ...patch } });
  // 員工／訪客切換顯示：一次只設定一側，兩側的草稿都在 value 裡，切換不會遺失
  const [side, setSide] = useState<"member" | "guest">("member");

  return (
    <div className="persona-section">
      <div className="seg-group" role="group" aria-label="角色對象">
        {([["member", "登入員工"], ["guest", "網站訪客"]] as const).map(([key, label]) => (
          <button key={key} type="button" aria-pressed={side === key}
            className={`btn btn-sm ${side === key ? "btn-primary" : "btn-ghost"}`} onClick={() => setSide(key)}>
            {label}
          </button>
        ))}
      </div>
      <p className="field-hint persona-side-hint">
        {side === "member" ? "已登入的公司員工。" : "未登入的使用者都算訪客；訪客的回答不會附知識庫出處。"}
      </p>

      {side === "member" && (<>
      <div className="field">
        <label className="field-label" htmlFor="persona-member-preset">登入員工的角色</label>
        <select
          id="persona-member-preset"
          className="input"
          value={member.preset}
          onChange={(e) => setMember({ preset: e.target.value as MemberPersonaPresetId })}
        >
          {MEMBER_PERSONA_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
        {memberHint && <span className="field-hint">{memberHint}</span>}
      </div>
      <div className="field">
        <label className="field-label" htmlFor="persona-member-notes">登入員工的補充說明</label>
        <textarea
          id="persona-member-notes"
          className="input"
          rows={3}
          maxLength={NOTES_MAX}
          value={member.notes ?? ""}
          onChange={(e) => setMember({ notes: e.target.value })}
          placeholder="例如：公司名稱、稱呼方式、避免使用的字詞"
        />
        <span className="field-hint">{(member.notes ?? "").length}/{NOTES_MAX}</span>
      </div>

      <ServiceOverrides
        sideLabel="登入員工"
        presets={MEMBER_PERSONA_PRESETS}
        basePreset={member.preset}
        services={member.services}
        onChange={(services) => setMember({ services })}
      />
      </>)}

      {side === "guest" && (<>
      <div className="field">
        <label className="field-label" htmlFor="persona-guest-preset">網站訪客的角色</label>
        <select
          id="persona-guest-preset"
          className="input"
          value={guest.preset}
          onChange={(e) => setGuest({ preset: e.target.value as GuestPersonaPresetId })}
        >
          {GUEST_PERSONA_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
        {guestHint && <span className="field-hint">{guestHint}</span>}
      </div>
      <div className="field">
        <label className="field-label" htmlFor="persona-guest-notes">網站訪客的補充說明</label>
        <textarea
          id="persona-guest-notes"
          className="input"
          rows={3}
          maxLength={NOTES_MAX}
          value={guest.notes ?? ""}
          onChange={(e) => setGuest({ notes: e.target.value })}
        />
        <span className="field-hint">{(guest.notes ?? "").length}/{NOTES_MAX}</span>
      </div>
      <div className="field">
        <label className="field-label" htmlFor="persona-guest-contact">網站訪客的聯絡管道</label>
        <input
          id="persona-guest-contact"
          className="input"
          maxLength={CONTACT_MAX}
          value={guest.contact ?? ""}
          onChange={(e) => setGuest({ contact: e.target.value })}
          placeholder="例如：客服專線 02-1234-5678（週一至週五 9:00–18:00）"
        />
        <span className="field-hint">AI 答不出來時，會引導訪客透過這個管道聯絡。</span>
      </div>
      <ServiceOverrides
        sideLabel="網站訪客"
        presets={GUEST_PERSONA_PRESETS}
        basePreset={guest.preset}
        services={guest.services}
        onChange={(services) => setGuest({ services })}
      />
      </>)}
    </div>
  );
}

/** 依功能覆寫角色：每個功能一個下拉，第一項「沿用」＝跟著該側的角色走 */
function ServiceOverrides<T extends string>({
  sideLabel,
  presets,
  basePreset,
  services,
  onChange,
}: {
  sideLabel: string;
  presets: readonly PersonaPresetMeta<T>[];
  basePreset: T;
  services?: Partial<Record<PersonaServiceKey, T>>;
  onChange: (next: Partial<Record<PersonaServiceKey, T>>) => void;
}) {
  const baseLabel = presets.find((p) => p.id === basePreset)?.label ?? basePreset;
  const set = (key: PersonaServiceKey, v: string) => {
    const next = { ...services };
    if (v) next[key] = v as T;
    else delete next[key];
    onChange(next);
  };
  return (
    <div className="field persona-overrides">
      <div className="field-label">{sideLabel}・依功能覆寫（預設沿用上面的角色）</div>
      <div className="persona-overrides-grid">
        {PERSONA_SERVICES.map(({ key, label }) => (
          <label key={key} className="persona-override">
            <span>{label}</span>
            <select
              className="input"
              aria-label={`${sideLabel}・${label}的角色`}
              value={services?.[key] ?? ""}
              onChange={(e) => set(key, e.target.value)}
            >
              <option value="">{`沿用（${baseLabel}）`}</option>
              {presets.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </label>
        ))}
      </div>
    </div>
  );
}
