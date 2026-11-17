import { useEffect, useState } from "react";
import type { AssistantPersona } from "@hyagent/shared";
import { useUnsavedChanges } from "../../components/unsaved";
import UnsavedBadge from "../../components/UnsavedBadge";
import { api, type Tenant } from "../../api";
import PersonaPreview from "./PersonaPreview";
import KnowledgeRulesSection from "./KnowledgeRulesSection";
import PersonaSection from "./PersonaSection";
import { toPersonaPatch, toRulesPatch, type RulesDraft, type RulesInfo } from "./persona.util";

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
  // 子頁：設定／知識庫規則／預覽。草稿留在這一層，切換子頁不會遺失；預覽只在切過去時才掛載（才開始打 API）
  const [sub, setSub] = useState<"edit" | "rules" | "preview">("edit");

  // 知識庫規則：內建／鎖定規則由 server 提供（語言依租戶預設語言），草稿與已存版本分開記，用來判斷未儲存
  const rulesLocale = tenant.appearance?.defaultLocale === "en" ? "en" : "zh-Hant";
  const [rulesInfo, setRulesInfo] = useState<RulesInfo | null>(null);
  const [rulesDraft, setRulesDraft] = useState<RulesDraft>({ member: null, guest: null });
  const [rulesSaved, setRulesSaved] = useState<RulesDraft>({ member: null, guest: null });
  const [rulesBusy, setRulesBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    Promise.resolve()
      .then(() => api.getKnowledgeRules(tenant.id, rulesLocale))
      .then((info) => {
        if (!alive || !info) return;
        const saved = { member: info.member.custom, guest: info.guest.custom };
        setRulesInfo(info);
        setRulesDraft(saved);
        setRulesSaved(saved);
      })
      .catch(onError);
    return () => {
      alive = false;
    };
    // 只在換租戶或語言時重新載入；onError 每次 render 都是新函式，不列入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenant.id, rulesLocale]);
  const rulesDirty =
    rulesInfo !== null &&
    JSON.stringify(toRulesPatch(rulesDraft, rulesInfo)) !== JSON.stringify(toRulesPatch(rulesSaved, rulesInfo));
  useUnsavedChanges("知識庫規則", rulesDirty);

  async function saveRules() {
    if (!rulesInfo) return;
    setRulesBusy(true);
    try {
      const patch = toRulesPatch(rulesDraft, rulesInfo);
      await api.updateTenant(tenant.id, { knowledgeAnswerRules: patch });
      setRulesDraft(patch);
      setRulesSaved(patch);
      onSaved();
    } catch (e) {
      onError(e);
    } finally {
      setRulesBusy(false);
    }
  }

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

  const head = {
    edit: { title: "AI 角色", dirty, desc: "依使用者是否登入套用不同角色，影響 AI 的口吻與回答方式。平台規則（不得捏造、寫入動作需確認等）不受角色影響。" },
    rules: { title: "知識庫規則", dirty: rulesDirty, desc: "調整知識庫問答的回答規則；防護規則鎖定不可修改，並優先於自訂規則。" },
    preview: { title: "預覽", dirty: false, desc: "AI 實際收到的角色指示與知識庫規則。" },
  }[sub];

  return (
    <div className="persona-tab">
      {/* 子頁籤是頁面最上方的獨立區塊，下面的卡片隨子頁切換內容 */}
      <div className="tabs kb-subtabs" role="tablist" aria-label="AI 角色子頁">
        {([["edit", "設定"], ["rules", "知識庫規則"], ["preview", "預覽"]] as const).map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={sub === key}
            className={`tab${sub === key ? " active" : ""}`} onClick={() => setSub(key)}>
            {label}
          </button>
        ))}
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">{head.title}<UnsavedBadge dirty={head.dirty} /></div>
            <div className="card-desc">{head.desc}</div>
          </div>
        </div>
        <div className="card-body">
          <div hidden={sub !== "edit"}>
            <fieldset disabled={readonly} className="tab-readonly">
              <PersonaSection value={persona} onChange={setPersona} />
              <div className="form-actions">
                <button className="btn btn-primary" onClick={save} disabled={busy || readonly}>
                  {busy ? "儲存中…" : "儲存 AI 角色"}
                </button>
              </div>
            </fieldset>
          </div>
          <div hidden={sub !== "rules"}>
            {rulesInfo ? (
              <KnowledgeRulesSection
                info={rulesInfo}
                value={rulesDraft}
                onChange={setRulesDraft}
                readonly={readonly}
                saveButton={
                  <button className="btn btn-primary" onClick={saveRules} disabled={rulesBusy || readonly}>
                    {rulesBusy ? "儲存中…" : "儲存規則"}
                  </button>
                }
              />
            ) : (
              <p className="field-hint">載入中…</p>
            )}
          </div>
          {sub === "preview" && (
            <PersonaPreview
              tenantId={tenant.id}
              persona={persona}
              rules={rulesInfo ? toRulesPatch(rulesDraft, rulesInfo) : undefined}
              notice={dirty || rulesDirty ? "預覽的是尚未儲存的內容，回到對應的子頁按儲存後才會生效。" : undefined}
            />
          )}
        </div>
      </div>
    </div>
  );
}
