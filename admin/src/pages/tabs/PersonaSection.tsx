import {
  GUEST_PERSONA_PRESETS,
  MEMBER_PERSONA_PRESETS,
  type AssistantPersona,
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

  return (
    <div className="persona-section" style={{ marginTop: 20 }}>
      <div className="card-title">AI 角色</div>
      <p className="field-hint">
        依使用者是否登入套用不同角色，影響 AI 的口吻與回答方式。平台規則（不得捏造、寫入動作需確認等）不受角色影響。
      </p>

      <div className="field" style={{ marginTop: 12 }}>
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

      <div className="field" style={{ marginTop: 12 }}>
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
        <span className="field-hint">
          {guestHint ? `${guestHint}。` : ""}未登入的使用者都算訪客，訪客的回答不會附知識庫出處。
        </span>
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
    </div>
  );
}
