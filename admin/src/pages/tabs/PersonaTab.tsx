import { useState } from "react";
import type { AssistantPersona } from "@hyagent/shared";
import { useUnsavedChanges } from "../../components/unsaved";
import UnsavedBadge from "../../components/UnsavedBadge";
import { api, type Tenant } from "../../api";
import PersonaPreview from "./PersonaPreview";
import PersonaSection from "./PersonaSection";
import { toPersonaPatch } from "./persona.util";

/**
 * AI 角色頁籤：員工／訪客分開設定 AI 的角色與口吻。
 * 獨立於外觀頁並有自己的權限（persona）：改 AI 的說話方式比改外觀敏感，要能分開授權。
 */
export default function PersonaTab({
  tenant,
  onSaved,
  onError,
  readonly = false,
}: {
  tenant: Tenant;
  onSaved: () => void;
  onError: (e: unknown) => void;
  readonly?: boolean;
}) {
  const [persona, setPersona] = useState<AssistantPersona>(tenant.assistantPersona ?? {});
  const [busy, setBusy] = useState(false);

  // 以「實際會送出的 patch」比較：預設角色＋空白文字與從未設定視為相同
  const dirty =
    JSON.stringify(toPersonaPatch(persona)) !== JSON.stringify(toPersonaPatch(tenant.assistantPersona ?? {}));
  useUnsavedChanges("AI 角色", dirty);

  async function save() {
    setBusy(true);
    try {
      await api.updateTenant(tenant.id, { assistantPersona: toPersonaPatch(persona) });
      onSaved();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">AI 角色<UnsavedBadge dirty={dirty} /></div>
          <div className="card-desc">
            依使用者是否登入套用不同角色，影響 AI 的口吻與回答方式。平台規則（不得捏造、寫入動作需確認等）不受角色影響。
          </div>
        </div>
      </div>
      <div className="card-body">
        <fieldset disabled={readonly} className="tab-readonly">
          <PersonaSection value={persona} onChange={setPersona} />
          <div className="form-actions">
            <button className="btn btn-primary" onClick={save} disabled={busy || readonly}>
              {busy ? "儲存中…" : "儲存 AI 角色"}
            </button>
          </div>
        </fieldset>
        {/* 預覽放在 fieldset 外：唯讀時也能切換語言、看預覽 */}
        <PersonaPreview tenantId={tenant.id} persona={persona} />
      </div>
    </div>
  );
}
