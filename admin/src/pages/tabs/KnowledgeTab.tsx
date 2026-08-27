import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { Checkbox, useToast } from "@hyagent/ui";
import {
  api,
  type IngestJob,
  type KnowledgeAclReport,
  type KnowledgeFileMeta,
  type KnowledgeLabel,
  type KnowledgeMeta,
  type KnowledgeSource,
  type PromptSource,
  type QueryHit,
  type SuggestedPromptText,
} from "../../api";
import NumberField from "../../components/NumberField";
import {
  type AclMode,
  buildAclOnConfirmMessage,
  countFilesWithLabel,
  fileLabelState,
  isValidLabelId,
  kbScopeId,
  labelNameFor,
  needsAclOnConfirm,
  sourceNeedsAclWarning,
  stripKbPrefix,
} from "./knowledgeAcl.util";

/** off → shadow → on 是遷移路徑，不是三個平等選項；UI 上要讀起來像階段推進 */
const ACL_MODE_STEPS: { mode: AclMode; label: string }[] = [
  { mode: "off", label: "① 關閉" },
  { mode: "shadow", label: "② 觀察" },
  { mode: "on", label: "③ 啟用" },
];

const EMBEDDING_MODELS = ["text-embedding-3-large", "text-embedding-3-small"];
type SourceKind = "website" | "file";

/**
 * 知識庫可上傳的副檔名，需與 server 端 doc-parse 的 SUPPORTED_EXTENSIONS 一致。
 *
 * accept、拖放白名單與提示文案共用這一份：三處分開寫必然漂移——只放寬 accept 的話，
 * 檔案挑得到卻拖不進來，而且錯在前端，使用者連 server 的錯誤訊息都看不到。
 */
const KNOWLEDGE_EXTS = ["txt", "md", "htm", "html", "doc", "docx", "pdf", "xlsx"];
const KNOWLEDGE_ACCEPT = KNOWLEDGE_EXTS.map((e) => `.${e}`).join(",");
/** 顯示用：htm 與 html 對使用者是同一件事，只列一個 */
const KNOWLEDGE_EXT_LABELS = KNOWLEDGE_EXTS.filter((e) => e !== "html").map((e) =>
  e.toUpperCase(),
);

export default function KnowledgeTab({
  tenantId,
  onError,
}: {
  tenantId: string;
  onError: (e: unknown) => void;
}) {
  const toast = useToast();
  const [src, setSrc] = useState<KnowledgeSource | null>(null);
  const [meta, setMeta] = useState<KnowledgeMeta | null>(null);
  const [job, setJob] = useState<IngestJob | null>(null);
  const [question, setQuestion] = useState("");
  const [asUserId, setAsUserId] = useState(""); // 試查身分：留空＝以管理者身分（見 test()）
  const [hits, setHits] = useState<QueryHit[]>([]);
  const [uploading, setUploading] = useState(false);
  // 可見性標籤：清單 + 新增／改名／刪除中的暫存狀態
  const [labels, setLabels] = useState<KnowledgeLabel[]>([]);
  const [newLabelId, setNewLabelId] = useState("");
  const [newLabelName, setNewLabelName] = useState("");
  const [addingLabel, setAddingLabel] = useState(false);
  const [editingLabelId, setEditingLabelId] = useState<string | null>(null);
  const [editLabelName, setEditLabelName] = useState("");
  const [savingLabel, setSavingLabel] = useState(false);
  // 檔案可見性多選編輯：editingFileId 為 null 代表沒有檔案在編輯中
  const [editingFileId, setEditingFileId] = useState<string | null>(null);
  const [editScopes, setEditScopes] = useState<string[]>([]); // labelId（未加 kb: 前綴）
  const [savingVisibility, setSavingVisibility] = useState(false);
  // ACL 盤點面板
  const [aclReport, setAclReport] = useState<KnowledgeAclReport | null>(null);
  const [changingAclMode, setChangingAclMode] = useState(false);
  const [regenerating, setRegenerating] = useState<PromptSource | null>(null); // 手動重新生成開場推薦詞中的來源
  const [dragOver, setDragOver] = useState(false); // 拖放上傳區的 drag-over 高亮
  // 手動編輯中的來源與草稿（null = 沒有在編輯）
  const [editingSource, setEditingSource] = useState<PromptSource | null>(null);
  const [manualDraft, setManualDraft] = useState<SuggestedPromptText>({ "zh-Hant": "", en: "" });
  const [savingManual, setSavingManual] = useState(false);
  // 來源設定：先選網站或檔案，再填完參數，最後由同一顆「開始解析」依類型處理。
  const [sourceKind, setSourceKind] = useState<SourceKind>("website");
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const d = await api.getKnowledge(tenantId);
      const effectiveSource = {
        ...d.source,
        embeddingModel: d.meta.model ?? d.source.embeddingModel,
      };
      setSrc(effectiveSource);
      setMeta(d.meta);
      setJob(d.runningJob);
    } catch (e) {
      onError(e);
    }
  }, [tenantId, onError]);

  /** 標籤清單 + ACL 盤點：兩者都是「標籤異動後要重看」的資料，合併成一次載入 */
  const loadAcl = useCallback(async () => {
    try {
      const [ls, report] = await Promise.all([
        api.listKnowledgeLabels(tenantId),
        api.getKnowledgeAclReport(tenantId),
      ]);
      setLabels(ls);
      setAclReport(report);
    } catch (e) {
      onError(e);
    }
  }, [tenantId, onError]);

  useEffect(() => {
    load();
    loadAcl();
    return () => {
      if (poll.current) clearInterval(poll.current);
    };
  }, [load, loadAcl]);

  const update = (patch: Partial<KnowledgeSource>) =>
    setSrc((s) => (s ? { ...s, ...patch } : s));

  const startPoll = (jobId: string) => {
    if (poll.current) clearInterval(poll.current);
    poll.current = setInterval(async () => {
      try {
        const j = await api.getKnowledgeJob(tenantId, jobId);
        setJob(j);
        if (j.status === "done" || j.status === "failed") {
          if (poll.current) clearInterval(poll.current);
          poll.current = null;
          load();
        }
      } catch (e) {
        onError(e);
      }
    }, 2000);
  };

  const parseSource = async () => {
    if (!src) return;
    if (sourceKind === "file" && !pendingFile) {
      toast.error("請先選擇要解析的檔案");
      return;
    }
    setUploading(sourceKind === "file");
    try {
      await api.saveKnowledgeSource(tenantId, src);
      if (sourceKind === "website") {
        const { jobId, status } = await api.startKnowledgeIngest(tenantId);
        setJob({
          id: jobId,
          tenantId,
          status: status as IngestJob["status"],
          pagesCrawled: 0,
          chunks: 0,
          embedded: 0,
          startedAt: new Date().toISOString(),
        });
        startPoll(jobId);
      } else if (pendingFile) {
        const m = await api.uploadKnowledgeFile(tenantId, pendingFile);
        toast.success(`已匯入 ${m.chunks} 個段落`);
        setPendingFile(null);
        await load();
      }
    } catch (e) {
      onError(e);
    } finally {
      setUploading(false);
    }
  };

  const test = async () => {
    try {
      const { hits } = await api.knowledgeQueryTest(tenantId, question, asUserId.trim() || undefined);
      setHits(hits);
    } catch (e) {
      onError(e);
    }
  };

  const clear = async () => {
    try {
      await api.deleteKnowledge(tenantId);
      await load();
      setHits([]);
    } catch (e) {
      onError(e);
    }
  };

  /**
   * 重新生成某來源的開場推薦詞：平時由索引異動自動觸發，這裡是補救入口
   * （索引建立於此功能上線前、或當時生成失敗的租戶，否則要重爬才生得出來）。
   */
  const regenerateSuggestion = async (source: PromptSource) => {
    setRegenerating(source);
    try {
      const { slot } = await api.refreshKnowledgeSuggestion(tenantId, source);
      setMeta((m) => (m ? { ...m, suggestedPrompts: { ...m.suggestedPrompts, [source]: slot } } : m));
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
      setMeta((m) => (m ? { ...m, suggestedPrompts: { ...m.suggestedPrompts, [source]: slot } } : m));
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
      setMeta((m) => (m ? { ...m, suggestedPrompts: { ...m.suggestedPrompts, [source]: slot } } : m));
      toast.success("已恢復自動生成");
    } catch (e) {
      onError(e);
    }
  };

  /** 選檔只帶入來源；chunk/model 等參數在同一區塊確認後，再按「開始解析」。 */
  const pickFile = (file: File) => {
    setSourceKind("file");
    setPendingFile(file);
  };

  const removeFile = async (f: KnowledgeFileMeta) => {
    if (!confirm(`確定刪除檔案「${f.name}」？`)) return;
    try {
      await api.deleteKnowledgeFile(tenantId, f.fileId);
      await Promise.all([load(), loadAcl()]);
    } catch (e) {
      onError(e);
    }
  };

  // ---- ACL 模式切換 ----

  /**
   * 切換三態旗標。切到 on 之前用目前已載入的 aclReport 算出代價並在
   * window.confirm 裡攤開來——off/shadow 不會讓任何東西消失，不需要確認。
   * 成功後重新載入盤點資料，讓 badge 與清單反映新狀態。
   */
  const changeAclMode = async (mode: AclMode) => {
    if (!aclReport || mode === aclReport.mode || changingAclMode) return;
    if (needsAclOnConfirm(mode)) {
      const msg = buildAclOnConfirmMessage({
        unlabeledCount: aclReport.unlabeled.length,
        explicitlyEmptyCount: aclReport.explicitlyEmpty.length,
        source: aclReport.source,
      });
      if (!confirm(msg)) return;
    }
    setChangingAclMode(true);
    try {
      await api.updateTenant(tenantId, { knowledgeAcl: mode });
      await loadAcl();
      toast.success(
        mode === "off"
          ? "已切回關閉，權限過濾停用"
          : mode === "shadow"
            ? "已切換為觀察模式，尚未實際擋人"
            : "已啟用權限過濾",
      );
    } catch (e) {
      onError(e);
    } finally {
      setChangingAclMode(false);
    }
  };

  // ---- 可見性標籤 CRUD ----

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
      await loadAcl();
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
      await loadAcl();
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
    const affected = countFilesWithLabel(meta?.files ?? [], l.id);
    const warn =
      affected > 0
        ? `\n\n${affected} 份文件目前套用此標籤，刪除後這些文件將回到未標記狀態（無人可見）。`
        : "";
    if (!confirm(`確定刪除標籤「${l.label}」（${l.id}）？${warn}`)) return;
    try {
      const { affectedFiles } = await api.deleteKnowledgeLabel(tenantId, l.id);
      await Promise.all([load(), loadAcl()]);
      toast.success(
        affectedFiles > 0
          ? `已刪除標籤，${affectedFiles} 份文件回到未標記狀態`
          : "已刪除標籤",
      );
    } catch (e) {
      onError(e);
    }
  };

  // ---- 檔案可見性多選編輯 ----

  const startEditFile = (f: KnowledgeFileMeta) => {
    setEditingFileId(f.fileId);
    setEditScopes((f.visibilityScopes ?? []).map(stripKbPrefix));
  };

  const toggleEditScope = (labelId: string) =>
    setEditScopes((cur) =>
      cur.includes(labelId) ? cur.filter((x) => x !== labelId) : [...cur, labelId],
    );

  const saveFileVisibility = async (f: KnowledgeFileMeta) => {
    setSavingVisibility(true);
    try {
      const scopes = editScopes.map(kbScopeId);
      await api.setKnowledgeFileVisibility(tenantId, f.fileId, scopes);
      setEditingFileId(null);
      await Promise.all([load(), loadAcl()]);
      toast.success("已更新可見性");
    } catch (e) {
      onError(e);
    } finally {
      setSavingVisibility(false);
    }
  };

  if (!src || !meta)
    return (
      <div className="card">
        <div className="card-body">載入中…</div>
      </div>
    );
  const running =
    !!job && ["queued", "crawling", "embedding"].includes(job.status);
  const parsing = running || uploading;
  const lockedModel = meta.model;
  const canParse =
    !parsing &&
    src.chunkChars > 0 &&
    (sourceKind === "website" ? !!src.startUrl : !!pendingFile);

  return (
    // 兩欄各自直向堆疊：欄內卡片緊密相接，不會像單一 grid 那樣在矮卡旁留出空洞
    <div className="kb-cols">
      <div className="kb-col">
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">建立知識來源</div>
              <div className="card-desc">
                選擇網站或檔案，設定參數後解析成此租戶專屬的 RAG 索引。
              </div>
            </div>
          </div>
          <div className="card-body">
            <div className="tabs kb-source-tabs" role="tablist" aria-label="知識來源類型">
              <button
                type="button"
                className={`tab ${sourceKind === "website" ? "active" : ""}`}
                onClick={() => setSourceKind("website")}
                disabled={parsing}
              >
                網站
              </button>
              <button
                type="button"
                className={`tab ${sourceKind === "file" ? "active" : ""}`}
                onClick={() => setSourceKind("file")}
                disabled={parsing}
              >
                檔案
              </button>
            </div>

            {sourceKind === "website" ? (
              <div className="form-grid">
                <div className="field">
                  <label className="field-label">起始網址</label>
                  <input
                    className="input"
                    value={src.startUrl}
                    onChange={(e) => update({ startUrl: e.target.value })}
                    placeholder="https://www.example.com/"
                    disabled={parsing}
                  />
                </div>
                <div className="field">
                  <label className="field-label">最大頁數</label>
                  <NumberField
                    value={src.maxPages}
                    onChange={(maxPages) => update({ maxPages })}
                    min={1}
                    max={1000}
                    disabled={parsing}
                  />
                </div>
                <div className="field">
                  <label className="field-label">路徑前綴（選填）</label>
                  <input
                    className="input"
                    value={src.pathPrefix ?? ""}
                    onChange={(e) =>
                      update({ pathPrefix: e.target.value || undefined })
                    }
                    placeholder="/mp"
                    disabled={parsing}
                  />
                </div>
              </div>
            ) : (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={KNOWLEDGE_ACCEPT}
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) pickFile(file);
                    e.target.value = ""; // 允許再次上傳同一檔
                  }}
                />
                <div
                  role="button"
                  tabIndex={0}
                  aria-label="上傳檔案"
                  className={`kdrop${dragOver ? " kdrop--over" : ""}${uploading ? " kdrop--busy" : ""}`}
                  onClick={() => !parsing && fileInputRef.current?.click()}
                  onKeyDown={(e) => {
                    if (!parsing && (e.key === "Enter" || e.key === " ")) {
                      e.preventDefault();
                      fileInputRef.current?.click();
                    }
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    if (!parsing) setDragOver(true);
                  }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragOver(false);
                    if (parsing) return;
                    const file = e.dataTransfer.files?.[0];
                    if (!file) return;
                    const ext = file.name
                      .slice(file.name.lastIndexOf(".") + 1)
                      .toLowerCase();
                    if (!KNOWLEDGE_EXTS.includes(ext)) {
                      toast.error(`僅支援 ${KNOWLEDGE_EXT_LABELS.join("、")} 檔案`);
                      return;
                    }
                    pickFile(file);
                  }}
                >
                  {uploading ? (
                    <>
                      <span className="kdrop-spinner" aria-hidden />
                      <div className="kdrop-title">正在解析並建立索引…</div>
                      <div className="kdrop-sub">大型檔案可能需要數十秒</div>
                    </>
                  ) : (
                    <>
                      <svg
                        className="kdrop-icon"
                        width="32"
                        height="32"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M4 14.9A7 7 0 1 1 15.7 8h1.8a4.5 4.5 0 0 1 2.5 8.2" />
                        <path d="M12 12v9" />
                        <path d="m8 17 4-4 4 4" />
                      </svg>
                      <div className="kdrop-title">
                        {pendingFile ? pendingFile.name : "拖曳檔案到這裡，或點擊選擇"}
                      </div>
                      <div className="kdrop-sub">
                        {pendingFile
                          ? `${Math.max(1, Math.round(pendingFile.size / 1024))} KB，支援重新點擊更換檔案`
                          : // 括號內改點名弱的一端：xlsx 與 docx 同屬保留得到結構的格式，
                            // 再寫「DOCX 準確度最佳」就不對了
                            `支援 ${KNOWLEDGE_EXT_LABELS.join("・")}，單檔上限 10MB（DOC、PDF 取不到文件結構，檢索準確度較低）`}
                      </div>
                    </>
                  )}
                </div>
              </>
            )}

            <div className="kb-param-block">
              <div className="form-grid">
                <div className="field">
                  <label className="field-label">chunk 大小（字元）</label>
                  <NumberField
                    value={src.chunkChars}
                    onChange={(chunkChars) => update({ chunkChars })}
                    min={200}
                    max={4000}
                    disabled={parsing}
                  />
                </div>
                <div className="field">
                  <label className="field-label">embedding 模型</label>
                  {lockedModel ? (
                    <>
                      <input className="input" value={lockedModel} disabled />
                      <span className="field-hint">
                        同一索引須沿用既有模型；要換模型請先清除索引
                      </span>
                    </>
                  ) : (
                    <select
                      className="select"
                      value={src.embeddingModel}
                      onChange={(e) => update({ embeddingModel: e.target.value })}
                      disabled={parsing}
                    >
                      {EMBEDDING_MODELS.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
                <div className="field">
                  <label className="field-label">LLM 重排</label>
                  <label
                    style={{ display: "flex", alignItems: "center", gap: 8 }}
                  >
                    <Checkbox
                      checked={src.rerank}
                      onChange={(e) => update({ rerank: e.target.checked })}
                      disabled={parsing}
                    />
                    <span className="field-hint">
                      啟用兩階段檢索（精準度↑，每次查詢多一次呼叫）
                    </span>
                  </label>
                </div>
              </div>
            </div>

            <div className="form-actions">
              <button
                className="btn btn-primary"
                onClick={parseSource}
                disabled={!canParse}
              >
                {parsing ? "解析中…" : "開始解析"}
              </button>
              <button
                className="btn btn-danger"
                onClick={clear}
                disabled={parsing || meta.status === "none"}
              >
                清除索引
              </button>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">可見性標籤</div>
              <div className="card-desc">
                標籤決定哪些人看得到哪些文件；未標記的文件 fail-closed，無人可見。
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
                      <div className="row-sub">{l.id}</div>
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
      </div>

      <div className="kb-col">
        {(meta.files ?? []).length > 0 && (
          <div className="card">
            <div className="card-head">
              <div>
                <div className="card-title">已匯入檔案</div>
                <div className="card-desc">
                  檔案內容會與網站來源合併進同一份索引。
                </div>
              </div>
            </div>
            {(meta.files ?? []).length > 0 && (
              <ul className="list kfile-list">
                {(meta.files ?? []).map((f) => {
                  const ext = f.name
                    .slice(f.name.lastIndexOf(".") + 1)
                    .toLowerCase();
                  const labelState = fileLabelState(f.visibilityScopes);
                  return (
                    <li key={f.fileId} className="row">
                      <span className="kfile-ext" data-ext={ext}>
                        {ext}
                      </span>
                      <div className="row-main">
                        <div className="row-title">{f.name}</div>
                        <div className="row-sub">
                          {f.chunks} 個段落 ·{" "}
                          {new Date(f.ingestedAt).toLocaleString()}
                        </div>
                        {/* 標籤 chips：未標記／已清空都是無人可見，fail-closed 下等於白花錢，
                            用 danger 紅刺眼提示，不能跟正常標籤混在一起不顯眼 */}
                        <div className="kb-label-chips">
                          {labelState === "unlabeled" ? (
                            <span className="kb-label-chip kb-label-chip--warn">
                              未標記（無人可見）
                            </span>
                          ) : labelState === "empty" ? (
                            <span className="kb-label-chip kb-label-chip--warn">
                              已清空（無人可見）
                            </span>
                          ) : (
                            (f.visibilityScopes ?? []).map((s) => (
                              <span key={s} className="kb-label-chip">
                                {labelNameFor(labels, s)}
                              </span>
                            ))
                          )}
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() =>
                              editingFileId === f.fileId ? setEditingFileId(null) : startEditFile(f)
                            }
                          >
                            {editingFileId === f.fileId ? "取消" : "編輯標籤"}
                          </button>
                        </div>
                        {editingFileId === f.fileId && (
                          <div style={{ marginTop: 8 }}>
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
                              {labels.length === 0 && (
                                <span className="row-sub">
                                  尚未建立任何標籤，請先在上方「可見性標籤」新增。
                                </span>
                              )}
                              {labels.map((l) => (
                                <label
                                  key={l.id}
                                  style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}
                                >
                                  <Checkbox
                                    checked={editScopes.includes(l.id)}
                                    onChange={() => toggleEditScope(l.id)}
                                  />
                                  <span style={{ fontSize: 13.5 }}>{l.label}</span>
                                </label>
                              ))}
                            </div>
                            <div className="row-actions" style={{ marginTop: 8 }}>
                              <button
                                type="button"
                                className="btn btn-primary btn-sm"
                                onClick={() => saveFileVisibility(f)}
                                disabled={savingVisibility}
                              >
                                儲存
                              </button>
                              <button
                                type="button"
                                className="btn btn-sm"
                                onClick={() => setEditingFileId(null)}
                              >
                                取消
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                      <div className="row-actions">
                        <button
                          className="btn btn-danger btn-sm kfile-del"
                          title="刪除"
                          aria-label={`刪除 ${f.name}`}
                          onClick={() => removeFile(f)}
                        >
                          <svg
                            width="15"
                            height="15"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                          >
                            <path d="M3 6h18" />
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                            <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}

        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">索引狀態</div>
              <div className="card-desc">解析進度與目前索引摘要。</div>
            </div>
            <span
              className={`badge ${meta.status === "ready" ? "badge-on" : "badge-off"}`}
            >
              {running
                ? "解析中"
                : meta.status === "ready"
                  ? "已就緒"
                  : meta.status === "failed"
                    ? "失敗"
                    : "尚未建立"}
            </span>
          </div>
          <div className="card-body">
            {running ? (
              <div className="row-sub">
                階段：{job!.status}｜已爬 {job!.pagesCrawled} 頁｜已 embed{" "}
                {job!.embedded} / {job!.chunks}
              </div>
            ) : meta.status === "ready" ? (
              <>
                <div className="row-sub">
                  {meta.chunkCount} 片段｜來源 {meta.source ?? "—"}｜
                  {meta.generatedAt ?? ""}
                </div>
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
                    <div className="row-sub" key={source}>
                      {source === "website" ? "網站來源" : "檔案來源"}｜
                      {effective
                        ? `${effective["zh-Hant"]}｜${effective.en || "（英文未填）"}`
                        : "尚未生成，widget 不會顯示這顆 chip"}
                      {slot?.manual ? "（手動）" : "（自動）"}
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => regenerateSuggestion(source)}
                        disabled={regenerating !== null || count === 0}
                        style={{ marginInlineStart: 8 }}
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
                        style={{ marginInlineStart: 4 }}
                      >
                        編輯
                      </button>
                      {slot?.manual && (
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => clearManual(source)}
                          style={{ marginInlineStart: 4 }}
                        >
                          恢復自動
                        </button>
                      )}
                      {editingSource === source && (
                        <div className="form-grid" style={{ marginBlockStart: 8 }}>
                          <div className="field">
                            <label className="field-label">繁體中文（必填，20 字以內）</label>
                            <input
                              className="input"
                              value={manualDraft["zh-Hant"]}
                              onChange={(e) =>
                                setManualDraft((d) => ({ ...d, "zh-Hant": e.target.value }))
                              }
                              maxLength={20}
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
                    </div>
                  );
                })}
              </>
            ) : meta.status === "failed" ? (
              <div className="row-sub">失敗：{meta.error ?? "未知錯誤"}</div>
            ) : (
              <div className="row-sub">
                尚未建立索引，設定來源後按「開始解析」。
              </div>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">測試查詢</div>
              <div className="card-desc">
                輸入問題，檢視索引檢索到的片段（驗證用）。
              </div>
            </div>
          </div>
          <div
            className="card-body"
            style={{ borderBottom: "1px solid var(--border-color)" }}
          >
            <div className="toolbar">
              <input
                className="input"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="例：台北分公司電話"
              />
              <button
                className="btn btn-primary"
                onClick={test}
                disabled={!question}
              >
                查詢
              </button>
            </div>
            <div className="field" style={{ marginTop: 10 }}>
              <label className="field-label">以此使用者身分查詢（選填）</label>
              <input
                className="input"
                value={asUserId}
                onChange={(e) => setAsUserId(e.target.value)}
                placeholder="留空＝以管理者身分（權限最大，通常查得到全部）"
              />
            </div>
          </div>
          <ul className="list">
            {hits.map((h, i) => (
              <li key={i} className="row">
                <div className="row-main">
                  <div className="row-title">
                    <span className="badge badge-on">{h.score.toFixed(3)}</span>
                    <span style={{ fontWeight: 500 }}>{h.title}</span>
                  </div>
                  <div className="row-sub">{h.snippet}</div>
                </div>
              </li>
            ))}
            {hits.length === 0 && <li className="empty">尚無查詢結果。</li>}
          </ul>
        </div>
      </div>

      {aclReport && (
        <div className="card" style={{ gridColumn: "1 / -1" }}>
          <div className="card-head">
            <div>
              <div className="card-title">ACL 盤點</div>
              <div className="card-desc">
                目前生效模式與可見性標記完整度；shadow 模式下另附被擋統計，用於補標漏網文件。
              </div>
            </div>
            <span
              className={`badge ${
                aclReport.mode === "on"
                  ? "badge-on"
                  : aclReport.mode === "shadow"
                    ? "badge-warn"
                    : "badge-off"
              }`}
            >
              {aclReport.mode === "off"
                ? "關閉（未啟用權限過濾）"
                : aclReport.mode === "shadow"
                  ? "Shadow（觀察中，尚未實際擋人）"
                  : "已啟用"}
            </span>
          </div>
          <div className="card-body">
            {/* off → shadow → on 是遷移路徑，不是三顆平等按鈕：用 .tabs 分段控制表達
                「階段推進」的順序感，跳過 shadow 直接切 on 是最容易出事的走法 */}
            <div
              className="tabs"
              role="tablist"
              aria-label="權限過濾模式（遷移路徑：關閉→觀察→啟用）"
            >
              {ACL_MODE_STEPS.map((s) => (
                <button
                  key={s.mode}
                  type="button"
                  className={`tab ${aclReport.mode === s.mode ? "active" : ""}`}
                  disabled={changingAclMode || aclReport.mode === s.mode}
                  onClick={() => changeAclMode(s.mode)}
                >
                  {s.label}
                </button>
              ))}
            </div>

            {aclReport.mode === "off" && (
              <div className="row-sub" style={{ marginBottom: 12, color: "var(--status-warning)" }}>
                目前為「① 關閉」：權限過濾尚未生效，所有人都能查到未標記／已清空的內容——
                下方與檔案清單裡的「無人可見」標示描述的是切到「③ 啟用」後才會發生的事，不是現況。
              </div>
            )}
            {sourceNeedsAclWarning(aclReport.source) && (
              <div className="row-sub" style={{ marginBottom: 12, color: "var(--status-danger)" }}>
                警示：網站來源尚未標記可見性（來源標籤是整個來源一組，不在下方檔案清單內，
                不算進「未標記文件」的數字）。切換為「③ 啟用」後，整個網站爬取語料將對所有人不可見。
              </div>
            )}

            <div className="row-sub" style={{ marginBottom: 16 }}>
              {aclReport.shadowCaveat}
            </div>

            {/* unlabeled（從未標記＝待辦）與 explicitlyEmpty（已清空＝已完成的決定）分開列，
                兩者查詢效果相同但語意不同，混在一起會讓「還沒做」跟「做過了」分不清 */}
            <div style={{ fontWeight: 500, marginBottom: 8 }}>
              未標記文件（待辦，共 {aclReport.unlabeled.length} 份）
            </div>
            <ul className="list" style={{ marginBottom: 16 }}>
              {aclReport.unlabeled.map((f) => (
                <li key={f.fileId} className="row">
                  <div className="row-main">
                    <div className="row-title">{f.name}</div>
                  </div>
                </li>
              ))}
              {aclReport.unlabeled.length === 0 && (
                <li className="empty">沒有未標記的文件。</li>
              )}
            </ul>

            <div style={{ fontWeight: 500, marginBottom: 8 }}>
              明確清空（已決定無人可見，共 {aclReport.explicitlyEmpty.length} 份）
            </div>
            <ul className="list" style={{ marginBottom: 16 }}>
              {aclReport.explicitlyEmpty.map((f) => (
                <li key={f.fileId} className="row">
                  <div className="row-main">
                    <div className="row-title">{f.name}</div>
                  </div>
                </li>
              ))}
              {aclReport.explicitlyEmpty.length === 0 && (
                <li className="empty">沒有明確清空的文件。</li>
              )}
            </ul>

            <div style={{ fontWeight: 500, marginBottom: 8 }}>
              Shadow 被擋統計（{aclReport.shadowStats.length} 筆）
            </div>
            {aclReport.shadowStats.length === 0 ? (
              <div className="empty">尚無統計資料。</div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13.5 }}>
                  <thead>
                    <tr>
                      <th style={aclThStyle}>檔名</th>
                      <th style={aclThStyle}>被擋次數</th>
                      <th style={aclThStyle}>樣本使用者</th>
                      <th style={aclThStyle}>最後時間</th>
                    </tr>
                  </thead>
                  <tbody>
                    {aclReport.shadowStats.map((s) => (
                      <tr key={s.fileId}>
                        <td style={aclTdStyle}>
                          {(meta.files ?? []).find((f) => f.fileId === s.fileId)?.name ?? s.fileId}
                        </td>
                        <td style={aclTdStyle}>{s.blockedCount}</td>
                        <td style={aclTdStyle}>{s.sampleUserIds.join("、") || "—"}</td>
                        <td style={aclTdStyle}>{new Date(s.lastBlockedAt).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const aclThStyle: CSSProperties = {
  textAlign: "left",
  padding: "8px 10px",
  borderBottom: "1px solid var(--border-color)",
  fontWeight: 500,
  whiteSpace: "nowrap",
};
const aclTdStyle: CSSProperties = {
  padding: "6px 10px",
  borderBottom: "1px solid var(--border-color)",
  verticalAlign: "middle",
};
