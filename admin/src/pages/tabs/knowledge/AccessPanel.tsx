import { useState } from "react";
import { Link } from "react-router-dom";
import { useToast } from "@hyagent/ui";
import { api, type KnowledgeAclReport, type KnowledgeFileMeta, type KnowledgeLabel } from "../../../api";
import CollapsibleList from "../../../components/CollapsibleList";
import AccessLogCard from "./AccessLogCard";
import {
  countFilesWithLabel,
  guestCorpusState,
  isValidLabelId,
  labelNameFor,
  sourceNeedsAclWarning,
} from "../knowledgeAcl.util";
import { useConfirm } from '../../../components/confirm';
import { useUnsavedChanges } from '../../../components/unsaved';

/**
 * 「可見範圍與標籤」子頁：誰可以查詢這些知識（訪客可見範圍、待設定檔案、網站狀態）與可見性標籤管理。
 * 開啟某份檔案的標籤編輯要到「來源與檔案」子頁，透過 onEditFile 交給外層切換。
 */
export default function AccessPanel({ tenantId, aclReport, labels, files, onEditFile, onReload, onReloadAcl, onError }: {
  tenantId: string;
  aclReport: KnowledgeAclReport;
  labels: KnowledgeLabel[];
  /** 刪除標籤前要先算出受影響的檔案數 */
  files: KnowledgeFileMeta[];
  onEditFile: (fileId: string) => void;
  /** 重新載入索引與 ACL（刪除標籤會改動檔案的可見性） */
  onReload: () => Promise<void>;
  /** 只重新載入標籤與 ACL 盤點 */
  onReloadAcl: () => Promise<void>;
  onError: (e: unknown) => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [newLabelId, setNewLabelId] = useState("");
  const [newLabelName, setNewLabelName] = useState("");
  const [addingLabel, setAddingLabel] = useState(false);
  const [editingLabelId, setEditingLabelId] = useState<string | null>(null);
  const [editLabelName, setEditLabelName] = useState("");
  const [savingLabel, setSavingLabel] = useState(false);
  useUnsavedChanges('知識庫：新增標籤', newLabelId.trim() !== '' || newLabelName.trim() !== '');
  const renamingLabel = labels.find((l) => l.id === editingLabelId);
  useUnsavedChanges(`知識庫：標籤「${renamingLabel?.label ?? ''}」改名`, !!renamingLabel && editLabelName.trim() !== renamingLabel.label);

  const addLabel = async () => {
    const id = newLabelId.trim();
    const label = newLabelName.trim();
    if (!id || !label) return;
    if (!isValidLabelId(id)) {
      toast.error("標籤 id 只允許小寫英數與連字號");
      return;
    }
    setAddingLabel(true);
    try {
      await api.createKnowledgeLabel(tenantId, { id, label });
      setNewLabelId("");
      setNewLabelName("");
      await onReloadAcl();
      toast.success("已新增標籤");
    } catch (e) {
      onError(e);
    } finally {
      setAddingLabel(false);
    }
  };

  const startEditLabel = (l: KnowledgeLabel) => {
    setEditingLabelId(l.id);
    setEditLabelName(l.label);
  };

  const renameLabel = async (labelId: string) => {
    const label = editLabelName.trim();
    if (!label) return;
    setSavingLabel(true);
    try {
      await api.updateKnowledgeLabel(tenantId, labelId, label);
      setEditingLabelId(null);
      await onReloadAcl();
      toast.success("已更新標籤名稱");
    } catch (e) {
      onError(e);
    } finally {
      setSavingLabel(false);
    }
  };

  /**
   * 刪除標籤前用目前已載入的檔案清單自行算出 affectedFiles——DELETE API 要刪除完成
   * 後才回報這個數字，此時使用者已經按下確認，來不及反悔；確認對話框必須在動手前
   * 就給出準確數字，數字才有意義。
   */
  const removeLabel = async (l: KnowledgeLabel) => {
    const affected = countFilesWithLabel(files, l.id);
    const ok = await confirm({
      title: `刪除標籤「${l.label}」（${l.id}）？`,
      message: affected > 0
        ? `${affected} 份文件目前套用此標籤，刪除後這些文件將回到未標記狀態（無人可見）。角色中的此標籤授權也會一併移除。`
        : "目前沒有文件套用此標籤；角色中的此標籤授權會一併移除。",
    });
    if (!ok) return;
    try {
      const { affectedFiles } = await api.deleteKnowledgeLabel(tenantId, l.id);
      await onReload();
      toast.success(
        affectedFiles > 0
          ? `已刪除標籤，${affectedFiles} 份文件回到未標記狀態`
          : "已刪除標籤",
      );
    } catch (e) {
      onError(e);
    }
  };

  return (
    <div className="settings-stack">
      <section className="card" style={{ gridColumn: "1 / -1" }} aria-label="知識庫可見範圍">
        <div className="card-head">
          <div>
            <div className="card-title">誰可以查詢這些知識？</div>
            <div className="card-desc">
              網站依「可查詢對象」設定開放；檔案與進階標籤模式需要先選標籤，再到「權限」把標籤加進角色。
            </div>
          </div>
          <Link className="btn btn-sm" to="?tab=permissions">設定角色</Link>
        </div>
        <div className="card-body">
          <div className="row-title">網站訪客</div>
          <p className="row-sub">以下只顯示訪客的可見範圍；其他使用者請到「測試查詢」指定身分驗證。</p>
          <div className="kb-label-chips">
            <span className={`kb-label-chip${guestCorpusState(aclReport.guest) === "ok" ? "" : " kb-label-chip--warn"}`}>
              {guestCorpusState(aclReport.guest) === "ok" ? "有可查詢的內容" : "目前無法查詢任何內容"}
            </span>
            <span className="kb-label-chip">網站：{aclReport.guest.source ? "可查詢" : "無可查詢內容"}</span>
            <span className="kb-label-chip">可查詢檔案：{aclReport.guest.files} 份</span>
          </div>
          <div className="row-sub">
            訪客可見範圍：<CollapsibleList items={aclReport.guest.scopes} render={(scope) => labelNameFor(labels, scope)} empty="尚未授權" />
          </div>
          {guestCorpusState(aclReport.guest) === "no-grant" && (
            <p className="row-sub">下一步：要開放網站，請將「網站可查詢對象」設為「所有人」；要開放檔案或進階標籤來源，請到「權限」把標籤加進套用給「{aclReport.guest.department}」部門的角色。</p>
          )}
          {guestCorpusState(aclReport.guest) === "no-corpus" && (
            <p className="row-sub">下一步：替要開放的網站或檔案，選擇上方任一已授權標籤。目前沒有符合標籤的內容。</p>
          )}
          <p className="row-sub">公開聊天視窗與自動開場推薦詞會使用訪客可見的內容。</p>
          <hr style={{ border: 0, borderTop: "1px solid var(--border-color)", marginBlock: 16 }} />
          <details className="kb-acl-details">
            <summary>待設定標籤的檔案：{aclReport.unlabeled.length} 份</summary>
          <p className="row-sub">這些檔案尚未設定可見範圍，目前無人可查詢。網站狀態另列於下方。</p>
          <ul className="list">
            {aclReport.unlabeled.map((f) => (
              <li key={f.fileId} className="row">
                <div className="row-main"><div className="row-title">{f.name}</div></div>
                <button type="button" className="btn btn-sm" onClick={() => onEditFile(f.fileId)}>設定標籤</button>
              </li>
            ))}
            {aclReport.unlabeled.length === 0 && <li className="kb-acl-empty">沒有待設定的檔案；是否可查詢仍取決於部門授權。</li>}
          </ul>
          </details>
          <p className="row-sub">
            網站：{!aclReport.source.configured ? "尚未設定網站" : aclReport.source.audience?.mode === "public" ? "所有人可查詢（包含訪客）"
              : aclReport.source.audience?.mode === "departments" ? `僅限 ${(aclReport.source.audience.departments ?? []).join("、")} 查詢`
              : aclReport.source.audience?.mode === "disabled" ? "暫不開放"
              : sourceNeedsAclWarning(aclReport.source)
              ? "尚未設定標籤，目前無人可查詢。請在「建立知識來源」選擇標籤並儲存網站設定。"
              : aclReport.source.explicitlyEmpty ? "已設為不開放，目前無人可查詢。"
              : "已設定標籤，可查詢對象依部門授權決定。"}
          </p>
          <details className="kb-acl-details">
            <summary>已設為不開放的檔案：{aclReport.explicitlyEmpty.length} 份</summary>
            <p className="row-sub">這些檔案的標籤已被清空，目前無人可查詢；與尚未設定的待辦分開列出。</p>
            <ul className="list">
              {aclReport.explicitlyEmpty.map((f) => (
                <li key={f.fileId} className="row"><div className="row-main"><div className="row-title">{f.name}</div></div></li>
              ))}
              {aclReport.explicitlyEmpty.length === 0 && <li className="kb-acl-empty">沒有設為不開放的檔案。</li>}
            </ul>
          </details>
        </div>
      </section>
      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">可見性標籤</div>
            <div className="card-desc">
              先替文件選擇標籤，再到「權限」把標籤加進角色。未設定標籤時無人可查詢。
            </div>
          </div>
        </div>
        <div className="card-body">
          <div className="form-grid">
            <div className="field">
              <label className="field-label">標籤 id</label>
              <input
                className="input"
                value={newLabelId}
                onChange={(e) => setNewLabelId(e.target.value)}
                placeholder="例：hr"
                disabled={addingLabel}
              />
              <span className="field-hint">小寫英數與連字號，建立後不可改</span>
            </div>
            <div className="field">
              <label className="field-label">顯示名稱</label>
              <input
                className="input"
                value={newLabelName}
                onChange={(e) => setNewLabelName(e.target.value)}
                placeholder="例：人資"
                disabled={addingLabel}
              />
            </div>
          </div>
          <div className="form-actions">
            <button
              className="btn btn-primary btn-sm"
              onClick={addLabel}
              disabled={addingLabel || !newLabelId.trim() || !newLabelName.trim()}
            >
              {addingLabel ? "新增中…" : "新增標籤"}
            </button>
          </div>
        </div>
        <ul className="list">
          {labels.map((l) => (
            <li key={l.id} className="row">
              <div className="row-main">
                {editingLabelId === l.id ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <input
                      className="input"
                      style={{ maxWidth: 220 }}
                      value={editLabelName}
                      onChange={(e) => setEditLabelName(e.target.value)}
                      disabled={savingLabel}
                    />
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => renameLabel(l.id)}
                      disabled={savingLabel || !editLabelName.trim()}
                    >
                      儲存
                    </button>
                    <button
                      className="btn btn-sm"
                      onClick={() => setEditingLabelId(null)}
                      disabled={savingLabel}
                    >
                      取消
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="row-title">{l.label}</div>
                    <div className="row-sub mono">{l.id}</div>
                  </>
                )}
              </div>
              {editingLabelId !== l.id && (
                <div className="row-actions">
                  <button className="btn btn-sm" onClick={() => startEditLabel(l)}>
                    改名
                  </button>
                  <button className="btn btn-danger btn-sm" onClick={() => removeLabel(l)}>
                    刪除
                  </button>
                </div>
              )}
            </li>
          ))}
          {labels.length === 0 && <li className="empty">尚未建立任何標籤。</li>}
        </ul>
      </div>
      <AccessLogCard tenantId={tenantId} files={files} labels={labels} onError={onError} />
    </div>
  );
}
