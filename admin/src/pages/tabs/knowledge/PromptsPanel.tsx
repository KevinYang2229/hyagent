import { useState } from "react";
import { useToast } from "@hyagent/ui";
import {
  api,
  type CustomSuggestedPrompt,
  type KnowledgeMeta,
  type PromptSource,
  type SuggestedPromptText,
} from "../../../api";
import { MANUAL_PROMPT_MAX_ZH_CHARS } from "../knowledgeAcl.util";
import { useConfirm } from "../../../components/confirm";
import { useUnsavedChanges } from "../../../components/unsaved";

/**
 * 「開場推薦詞」子頁：各來源的自動／手動推薦詞，以及自訂提示詞。
 * 推薦詞資料屬於索引 meta，由外層持有；這裡只透過 onMetaChange 回寫。
 */
export default function PromptsPanel({ tenantId, meta, onMetaChange, onError }: {
  tenantId: string;
  meta: KnowledgeMeta;
  onMetaChange: (update: (meta: KnowledgeMeta) => KnowledgeMeta) => void;
  onError: (e: unknown) => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [regenerating, setRegenerating] = useState<PromptSource | null>(null); // 手動重新生成開場推薦詞中的來源
  // 手動編輯中的來源與草稿（null = 沒有在編輯）
  const [editingSource, setEditingSource] = useState<PromptSource | null>(null);
  const [manualDraft, setManualDraft] = useState<SuggestedPromptText>({ "zh-Hant": "", en: "" });
  const [customDraft, setCustomDraft] = useState<{ id?: string; source: PromptSource; text: SuggestedPromptText } | null>(null);
  const [savingCustom, setSavingCustom] = useState(false);
  const [savingManual, setSavingManual] = useState(false);
  const manualOriginal = editingSource ? meta.suggestedPrompts?.[editingSource]?.manual ?? { "zh-Hant": "", en: "" } : null;
  useUnsavedChanges("知識庫：手動推薦詞", !!manualOriginal && (manualDraft["zh-Hant"] !== manualOriginal["zh-Hant"] || manualDraft.en !== manualOriginal.en));
  const customOriginal = customDraft?.id ? (meta.customSuggestedPrompts ?? []).find((p) => p.id === customDraft.id) : undefined;
  useUnsavedChanges(customDraft?.id ? "知識庫：編輯自訂提示詞" : "知識庫：新增自訂提示詞", !!customDraft && (customOriginal
    ? customDraft.source !== customOriginal.source || customDraft.text["zh-Hant"] !== customOriginal.text["zh-Hant"] || customDraft.text.en !== customOriginal.text.en
    : !!(customDraft.text["zh-Hant"].trim() || customDraft.text.en.trim())));

  const setSlot = (source: PromptSource, slot: NonNullable<KnowledgeMeta["suggestedPrompts"]>[PromptSource]) =>
    onMetaChange((m) => ({ ...m, suggestedPrompts: { ...m.suggestedPrompts, [source]: slot } }));

  /**
   * 重新生成某來源的開場推薦詞：平時由索引異動自動觸發，這裡是補救入口
   * （索引建立於此功能上線前、或當時生成失敗的租戶，否則要重爬才生得出來）。
   */
  const regenerateSuggestion = async (source: PromptSource) => {
    setRegenerating(source);
    try {
      const { slot } = await api.refreshKnowledgeSuggestion(tenantId, source);
      setSlot(source, slot);
      toast.success("已重新生成開場推薦詞");
    } catch (e) {
      onError(e);
    } finally {
      setRegenerating(null);
    }
  };

  /** 儲存手動推薦詞：儲存成功後關閉編輯區並帶回最新的 slot */
  const saveManual = async (source: PromptSource) => {
    setSavingManual(true);
    try {
      const { slot } = await api.setKnowledgeSuggestionManual(tenantId, source, manualDraft);
      setSlot(source, slot);
      setEditingSource(null);
      toast.success("已儲存手動推薦詞");
    } catch (e) {
      onError(e);
    } finally {
      setSavingManual(false);
    }
  };

  /** 清除手動推薦詞，恢復顯示自動生成的句子 */
  const clearManual = async (source: PromptSource) => {
    try {
      const { slot } = await api.setKnowledgeSuggestionManual(tenantId, source, null);
      setSlot(source, slot);
      toast.success("已恢復自動生成");
    } catch (e) {
      onError(e);
    }
  };

  const saveCustomPrompt = async () => {
    if (!customDraft || !customDraft.text["zh-Hant"].trim()) return;
    setSavingCustom(true);
    try {
      const body = { source: customDraft.source, text: customDraft.text };
      const saved = customDraft.id
        ? await api.updateCustomSuggestion(tenantId, customDraft.id, body)
        : await api.createCustomSuggestion(tenantId, body);
      onMetaChange((current) => ({ ...current, customSuggestedPrompts: customDraft.id
        ? (current.customSuggestedPrompts ?? []).map((prompt) => prompt.id === saved.id ? saved : prompt)
        : [...(current.customSuggestedPrompts ?? []), saved] }));
      setCustomDraft(null);
      toast.success("已儲存自訂提示詞");
    } catch (e) { onError(e); } finally { setSavingCustom(false); }
  };

  const deleteCustomPrompt = async (prompt: CustomSuggestedPrompt) => {
    if (!(await confirm({ title: `刪除提示詞「${prompt.text["zh-Hant"]}」？`, message: "刪除後聊天視窗不再顯示這個開場提示詞。" }))) return;
    setSavingCustom(true);
    try {
      await api.deleteCustomSuggestion(tenantId, prompt.id);
      onMetaChange((current) => ({ ...current, customSuggestedPrompts: (current.customSuggestedPrompts ?? []).filter((item) => item.id !== prompt.id) }));
      if (customDraft?.id === prompt.id) setCustomDraft(null);
      toast.success("已刪除自訂提示詞");
    } catch (e) { onError(e); } finally { setSavingCustom(false); }
  };

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">開場推薦詞</div>
          <div className="card-desc">聊天視窗開場顯示的推薦問句。網站、檔案來源各一個，可手動改寫或另外新增。</div>
        </div>
      </div>
      <div className="card-body">
        {meta.status === "ready" ? (
          <>
            {/* 開場推薦詞：widget 的推薦 chip 依來源各一顆，未生成就不會有 chip */}
            {(["website", "file"] as const).map((source) => {
              const slot = meta.suggestedPrompts?.[source];
              const effective = slot?.manual ?? slot?.generated;
              // chunkCountBySource 是後補欄位，舊租戶的 meta 可能沒有；
              // 「欄位缺席」代表未知，要退回總數 meta.chunkCount，不能當成 0
              // （否則舊租戶的重新生成入口會永遠被鎖住）。只有明確拿到 0 才 disable。
              const count = meta.chunkCountBySource
                ? meta.chunkCountBySource[source]
                : meta.chunkCount;
              return (
                <section className="kb-suggestion" key={source} aria-label={source === "website" ? "網站開場推薦詞" : "檔案開場推薦詞"}>
                  <div className="kb-suggestion-heading">
                    <h3>{source === "website" ? "網站來源" : "檔案來源"}推薦詞</h3>
                    <span className="kb-label-chip">{slot?.manual ? "手動設定" : "自動生成"}</span>
                  </div>
                  {effective ? (
                    <div className="kb-suggestion-copy">
                      <p lang="zh-Hant">{effective["zh-Hant"]}</p>
                      <p lang="en">{effective.en || "英文尚未填寫"}</p>
                    </div>
                  ) : <p className="kb-suggestion-empty">尚未生成，聊天視窗暫不顯示此推薦詞。</p>}
                  <div className="kb-suggestion-actions">
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => regenerateSuggestion(source)}
                    disabled={regenerating !== null || count === 0}
                  >
                    {regenerating === source ? "生成中…" : "重新生成"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      setEditingSource(source);
                      setManualDraft(slot?.manual ?? { "zh-Hant": "", en: "" });
                    }}
                    disabled={editingSource !== null && editingSource !== source}
                  >
                    編輯
                  </button>
                  {slot?.manual && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => clearManual(source)}
                      >
                      恢復自動
                    </button>
                  )}
                  </div>
                  {editingSource === source && (
                    <div className="form-grid" style={{ marginBlockStart: 8 }}>
                      <div className="field">
                        <label className="field-label">
                          繁體中文（必填，{MANUAL_PROMPT_MAX_ZH_CHARS} 字以內）
                        </label>
                        <input
                          className="input"
                          value={manualDraft["zh-Hant"]}
                          onChange={(e) =>
                            setManualDraft((d) => ({ ...d, "zh-Hant": e.target.value }))
                          }
                          maxLength={MANUAL_PROMPT_MAX_ZH_CHARS}
                        />
                      </div>
                      <div className="field">
                        <label className="field-label">英文（選填，留空則英文介面不顯示）</label>
                        <input
                          className="input"
                          value={manualDraft.en}
                          onChange={(e) => setManualDraft((d) => ({ ...d, en: e.target.value }))}
                        />
                      </div>
                      <div className="row-actions">
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          onClick={() => saveManual(source)}
                          disabled={savingManual || !manualDraft["zh-Hant"].trim()}
                        >
                          儲存
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => setEditingSource(null)}
                        >
                          取消
                        </button>
                      </div>
                    </div>
                  )}
                </section>
              );
            })}
          </>
        ) : (
          <p className="row-sub">尚未建立索引，推薦詞會在「來源與檔案」完成解析後自動生成。</p>
        )}
        <section className="kb-suggestion" aria-label="自訂開場提示詞">
          <div className="kb-suggestion-heading"><h3>自訂開場提示詞</h3><span className="row-sub">{meta.customSuggestedPrompts?.length ?? 0} 個</span></div>
          <p className="kb-suggestion-empty">預設保留網站、檔案各一個推薦詞，也可額外新增。自訂內容不會被自動生成覆蓋；對應來源有訪客可查詢的內容時，才會顯示在前台。</p>
          {(meta.customSuggestedPrompts ?? []).map((prompt) => (
            <div className="kb-custom-prompt" key={prompt.id}>
              <span className="kb-label-chip">{prompt.source === "website" ? "網站來源" : "檔案來源"} · 自訂</span>
              <div className="kb-suggestion-copy"><p lang="zh-Hant">{prompt.text["zh-Hant"]}</p><p lang="en">{prompt.text.en || "英文未填，英文介面不顯示"}</p></div>
              <div className="kb-suggestion-actions">
                <button type="button" className="btn btn-sm" disabled={savingCustom || customDraft !== null} onClick={() => setCustomDraft({ ...prompt, text: { ...prompt.text } })}>編輯</button>
                <button type="button" className="btn btn-danger btn-sm" disabled={savingCustom} onClick={() => deleteCustomPrompt(prompt)}>刪除</button>
              </div>
            </div>
          ))}
          {customDraft ? (
            <form className="kb-file-editor" onSubmit={(event) => { event.preventDefault(); void saveCustomPrompt(); }}>
              <div className="row-title">{customDraft.id ? "編輯提示詞" : "新增提示詞"}</div>
              <label className="field"><span className="field-label">對應來源</span>
                <select className="select" disabled={savingCustom} value={customDraft.source} onChange={(event) => setCustomDraft({ ...customDraft, source: event.target.value as PromptSource })}>
                  <option value="website">網站</option><option value="file">檔案</option>
                </select>
              </label>
              <label className="field"><span className="field-label">繁體中文（必填，{MANUAL_PROMPT_MAX_ZH_CHARS} 字以內）</span>
                <input className="input" required maxLength={MANUAL_PROMPT_MAX_ZH_CHARS} disabled={savingCustom} value={customDraft.text["zh-Hant"]}
                  onChange={(event) => setCustomDraft({ ...customDraft, text: { ...customDraft.text, "zh-Hant": event.target.value } })} />
              </label>
              <label className="field"><span className="field-label">英文（選填，留空則英文介面不顯示）</span>
                <input className="input" maxLength={200} disabled={savingCustom} value={customDraft.text.en}
                  onChange={(event) => setCustomDraft({ ...customDraft, text: { ...customDraft.text, en: event.target.value } })} />
              </label>
              <div className="kb-file-actions">
                <button type="submit" className="btn btn-primary btn-sm" disabled={savingCustom || !customDraft.text["zh-Hant"].trim()}>{savingCustom ? "儲存中…" : "儲存提示詞"}</button>
                <button type="button" className="btn btn-sm" disabled={savingCustom} onClick={() => setCustomDraft(null)}>取消</button>
              </div>
            </form>
          ) : <div className="kb-suggestion-actions"><button type="button" className="btn btn-sm" disabled={savingCustom}
            onClick={() => setCustomDraft({ source: "website", text: { "zh-Hant": "", en: "" } })}>＋ 新增提示詞</button></div>}
        </section>
      </div>
    </div>
  );
}
