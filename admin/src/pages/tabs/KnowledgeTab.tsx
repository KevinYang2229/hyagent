import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Checkbox, useToast } from "@hyagent/ui";
import {
  api,
  type IngestJob,
  type CustomSuggestedPrompt,
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
  countFilesWithLabel,
  fileLabelState,
  guestCorpusState,
  MANUAL_PROMPT_MAX_ZH_CHARS,
  isValidLabelId,
  kbScopeId,
  labelNameFor,
  sourceNeedsAclWarning,
  stripKbPrefix,
} from "./knowledgeAcl.util";

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
  // 從回饋分頁「用這題測試檢索」帶入：?q=問題&as=提問者，預填後由管理員按下測試
  const [searchParams] = useSearchParams();
  const [question, setQuestion] = useState(searchParams.get("q") ?? "");
  const [asUserId, setAsUserId] = useState(searchParams.get("as") ?? ""); // 試查身分：留空＝以管理者身分（見 test()）
  const testCardRef = useRef<HTMLDivElement>(null);
  const loaded = !!src && !!meta; // 載入完成前卡片還沒渲染，ref 是空的
  useEffect(() => {
    if (loaded && searchParams.get("q")) testCardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [searchParams, loaded]);
  const [hits, setHits] = useState<QueryHit[]>([]);
  const [fileSearch, setFileSearch] = useState("");
  const [fileFilter, setFileFilter] = useState("all");
  const [filePage, setFilePage] = useState(1);
  const pageSize = 5;
  const sortedFiles = [...(meta?.files ?? [])].sort((a, b) => b.ingestedAt.localeCompare(a.ingestedAt));
  const filteredFiles = sortedFiles.filter((file) =>
    file.name.toLocaleLowerCase().includes(fileSearch.trim().toLocaleLowerCase()) &&
    (fileFilter === "all" || fileLabelState(file.visibilityScopes) === fileFilter),
  );
  const pageCount = Math.max(1, Math.ceil(filteredFiles.length / pageSize));
  const currentPage = Math.min(filePage, pageCount);
  const visibleFiles = filteredFiles.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const [uploading, setUploading] = useState(false);
  // 可見性標籤：清單 + 新增／改名／刪除中的暫存狀態
  const [departments, setDepartments] = useState<string[]>([]);
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
  const [savingSource, setSavingSource] = useState(false);
  // ACL 盤點面板
  const [aclReport, setAclReport] = useState<KnowledgeAclReport | null>(null);
  const [regenerating, setRegenerating] = useState<PromptSource | null>(null); // 手動重新生成開場推薦詞中的來源
  const [dragOver, setDragOver] = useState(false); // 拖放上傳區的 drag-over 高亮
  // 手動編輯中的來源與草稿（null = 沒有在編輯）
  const [editingSource, setEditingSource] = useState<PromptSource | null>(null);
  const [manualDraft, setManualDraft] = useState<SuggestedPromptText>({ "zh-Hant": "", en: "" });
  const [customDraft, setCustomDraft] = useState<{ id?: string; source: PromptSource; text: SuggestedPromptText } | null>(null);
  const [savingCustom, setSavingCustom] = useState(false);
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
      const [ls, report, policy] = await Promise.all([
        api.listKnowledgeLabels(tenantId),
        api.getKnowledgeAclReport(tenantId),
        api.getTenantPolicy(tenantId),
      ]);
      setLabels(ls);
      setDepartments([...new Set([...policy.departments, ...Object.keys(policy.groups)])].filter((department) => department !== "—"));
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

  const saveSourceSettings = async () => {
    if (!src) return;
    setSavingSource(true);
    try {
      const saved = await api.saveKnowledgeSource(tenantId, src);
      setSrc(saved);
      await loadAcl();
      toast.success("已儲存網站設定，可直接重新生成推薦詞");
    } catch (e) {
      onError(e);
    } finally {
      setSavingSource(false);
    }
  };

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
        await Promise.all([load(), loadAcl()]);
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
      await Promise.all([load(), loadAcl()]);
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

  const saveCustomPrompt = async () => {
    if (!customDraft || !customDraft.text["zh-Hant"].trim()) return;
    setSavingCustom(true);
    try {
      const body = { source: customDraft.source, text: customDraft.text };
      const saved = customDraft.id
        ? await api.updateCustomSuggestion(tenantId, customDraft.id, body)
        : await api.createCustomSuggestion(tenantId, body);
      setMeta((current) => current ? { ...current, customSuggestedPrompts: customDraft.id
        ? (current.customSuggestedPrompts ?? []).map((prompt) => prompt.id === saved.id ? saved : prompt)
        : [...(current.customSuggestedPrompts ?? []), saved] } : current);
      setCustomDraft(null);
      toast.success("已儲存自訂提示詞");
    } catch (e) { onError(e); } finally { setSavingCustom(false); }
  };

  const deleteCustomPrompt = async (prompt: CustomSuggestedPrompt) => {
    if (!confirm(`確定刪除提示詞「${prompt.text["zh-Hant"]}」？`)) return;
    setSavingCustom(true);
    try {
      await api.deleteCustomSuggestion(tenantId, prompt.id);
      setMeta((current) => current ? { ...current, customSuggestedPrompts: (current.customSuggestedPrompts ?? []).filter((item) => item.id !== prompt.id) } : current);
      if (customDraft?.id === prompt.id) setCustomDraft(null);
      toast.success("已刪除自訂提示詞");
    } catch (e) { onError(e); } finally { setSavingCustom(false); }
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
  const audienceValid = src.audience?.mode !== "departments" || !!src.audience.departments?.length;
  const canParse =
    audienceValid &&
    !parsing &&
    src.chunkChars > 0 &&
    (sourceKind === "website" ? !!src.startUrl : !!pendingFile);

  return (
    // 兩欄各自直向堆疊：欄內卡片緊密相接，不會像單一 grid 那樣在矮卡旁留出空洞
    <div className="kb-cols">
      {aclReport && (
        <section className="card" style={{ gridColumn: "1 / -1" }} aria-label="知識庫可見範圍">
          <div className="card-head">
            <div>
              <div className="card-title">誰可以查詢這些知識？</div>
              <div className="card-desc">
                網站依「可查詢對象」設定開放；檔案與進階標籤模式需要先選標籤，再到「權限」授權給部門。
              </div>
            </div>
            <Link className="btn btn-sm" to="?tab=permissions">設定部門授權</Link>
          </div>
          <div className="card-body">
            <div className="row-title">訪客／未建檔帳號</div>
            <p className="row-sub">以下只顯示訪客的可見範圍；其他使用者請到「測試查詢」指定身分驗證。</p>
            <div className="kb-label-chips">
              <span className={`kb-label-chip${guestCorpusState(aclReport.guest) === "ok" ? "" : " kb-label-chip--warn"}`}>
                {guestCorpusState(aclReport.guest) === "ok" ? "有可查詢的內容" : "目前無法查詢任何內容"}
              </span>
              <span className="kb-label-chip">網站：{aclReport.guest.source ? "可查詢" : "無可查詢內容"}</span>
              <span className="kb-label-chip">可查詢檔案：{aclReport.guest.files} 份</span>
            </div>
            <p className="row-sub">
              訪客可見範圍：{aclReport.guest.scopes.length
                ? aclReport.guest.scopes.map((scope) => labelNameFor(labels, scope)).join("、")
                : "尚未授權"}
            </p>
            {guestCorpusState(aclReport.guest) === "no-grant" && (
              <p className="row-sub">下一步：要開放網站，請將「網站可查詢對象」設為「所有人」；要開放檔案或進階標籤來源，請到「權限」授權給「{aclReport.guest.department}」部門。</p>
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
                  <button type="button" className="btn btn-sm" onClick={() => {
                    setFileSearch("");
                    setFileFilter("all");
                    setFilePage(Math.floor(sortedFiles.findIndex((file) => file.fileId === f.fileId) / pageSize) + 1);
                    startEditFile(f);
                    requestAnimationFrame(() => document.getElementById(`kb-file-${f.fileId}`)?.scrollIntoView({ block: "center", behavior: "smooth" }));
                  }}>設定標籤</button>
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
      )}
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
                  <label className="field-label" htmlFor="website-audience">網站可查詢對象</label>
                  <select id="website-audience" className="select"
                    value={src.audience?.mode ?? ((src.visibilityScopes?.length ?? 0) > 0 ? "labels" : "disabled")}
                    disabled={parsing || savingSource}
                    onChange={(e) => update({
                      audience: { mode: e.target.value as NonNullable<KnowledgeSource["audience"]>["mode"], departments: src.audience?.departments ?? [] },
                      visibilityScopes: (src.visibilityScopes ?? []).filter((scope) => scope !== "kb:__website_access"),
                    })}>
                    <option value="disabled">暫不開放</option>
                    <option value="public">所有人（包含訪客）</option>
                    <option value="departments">指定部門</option>
                    <option value="labels">進階：使用可見性標籤</option>
                  </select>
                  {src.audience?.mode === "public" && <span className="field-hint">儲存後，所有人都可查詢此網站內容，也可用於公開開場推薦詞。</span>}
                  {src.audience?.mode === "departments" && <>
                    <div className="kb-label-options" role="group" aria-label="可查詢網站的部門">
                      {departments.map((department) => <label key={department}>
                        <Checkbox checked={src.audience?.departments?.includes(department) ?? false} disabled={parsing || savingSource}
                          onChange={(e) => update({ audience: { mode: "departments", departments: e.target.checked
                            ? [...(src.audience?.departments ?? []), department]
                            : (src.audience?.departments ?? []).filter((value) => value !== department) } })} />
                        <span>{department}</span>
                      </label>)}
                    </div>
                    <span className="field-hint">至少選擇一個部門。訪客與其他部門無法查詢；不需另外設定標籤授權。</span>
                    {departments.length === 0 && <span className="field-hint">尚無可選部門，請先設定人員目錄或部門權限。</span>}
                  </>}
                  {(src.audience?.mode === "labels" || (!src.audience && !!src.visibilityScopes?.length)) && <>
                    <div className="kb-label-options" role="group" aria-label="網站可見性標籤">
                      {labels.map((label) => <label key={label.id}>
                        <Checkbox checked={(src.visibilityScopes ?? []).includes(kbScopeId(label.id))} disabled={parsing || savingSource}
                          onChange={(e) => update({ visibilityScopes: e.target.checked
                            ? [...(src.visibilityScopes ?? []), kbScopeId(label.id)]
                            : (src.visibilityScopes ?? []).filter((scope) => scope !== kbScopeId(label.id)) })} />
                        <span>{label.label}</span>
                      </label>)}
                    </div>
                    <span className="field-hint">沿用標籤與部門授權。請到「權限」授權相同標籤；未選標籤時無人可查詢。</span>
                  </>}
                  {(src.audience?.mode === "disabled" || (!src.audience && !src.visibilityScopes?.length)) && <span className="field-hint">保留網站內容，但暫不提供任何人查詢。</span>}
                  <span className="field-hint">僅套用到整個網站來源，不會變更檔案的可見範圍。儲存後生效，不需重新解析。</span>
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
              {sourceKind === "website" && (
                <button
                  type="button"
                  className="btn"
                  onClick={saveSourceSettings}
                  disabled={parsing || savingSource || !src.startUrl.trim() || !audienceValid}
                >
                  {savingSource ? "儲存中…" : "儲存網站設定（不重新解析）"}
                </button>
              )}
              <button
                className="btn btn-primary"
                onClick={parseSource}
                disabled={!canParse || savingSource}
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
                先替文件選擇標籤，再到「權限」授權給部門。未設定標籤時無人可查詢。
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
        <section className="card" aria-label="已匯入檔案">
          <div className="card-head">
            <div>
              <div className="card-title">已匯入檔案 <span className="row-sub">共 {sortedFiles.length} 份</span></div>
              <div className="card-desc">依匯入時間由新到舊排列，每頁顯示 {pageSize} 份。</div>
            </div>
          </div>
          <div className="card-body kb-file-toolbar">
            <input className="input" aria-label="搜尋檔案名稱" placeholder="搜尋檔案名稱…" value={fileSearch}
              onChange={(e) => { setFileSearch(e.target.value); setFilePage(1); }} />
            <select className="select" aria-label="篩選檔案可見性設定" value={fileFilter}
              onChange={(e) => { setFileFilter(e.target.value); setFilePage(1); }}>
              <option value="all">全部設定狀態</option>
              <option value="unlabeled">待設定標籤</option>
              <option value="labeled">已設定標籤</option>
              <option value="empty">不開放</option>
            </select>
          </div>
          <ul className="list">
            {visibleFiles.map((f) => {
              const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
              const scopes = f.visibilityScopes ?? [];
              const state = fileLabelState(f.visibilityScopes);
              return (
                <li key={f.fileId} id={`kb-file-${f.fileId}`} className="kb-file-item">
                  <div className="kb-file-heading">
                    <span className="kfile-ext" data-ext={ext}>{ext}</span>
                    <div className="row-main">
                      <div className="row-title">{f.name}</div>
                      <div className="row-sub">{f.chunks} 個段落 · {new Date(f.ingestedAt).toLocaleString("zh-TW")}</div>
                    </div>
                  </div>
                  <div className="kb-file-labels">
                    <div className="row-sub">可見性標籤 · 仍需部門授權</div>
                    <div className="kb-label-chips">
                      {state !== "labeled" ? <span className="kb-label-chip kb-label-chip--warn">
                        {state === "unlabeled" ? "待設定標籤（無人可查詢）" : "不開放（標籤已清空）"}
                      </span> : scopes.slice(0, 3).map((scope) => (
                        <span key={scope} className="kb-label-chip">{labelNameFor(labels, scope)}</span>
                      ))}
                    </div>
                    {scopes.length > 3 && <details className="kb-file-more-labels">
                      <summary>另有 {scopes.length - 3} 個標籤</summary>
                      <div className="kb-label-chips">{scopes.slice(3).map((scope) => (
                        <span key={scope} className="kb-label-chip">{labelNameFor(labels, scope)}</span>
                      ))}</div>
                    </details>}
                  </div>
                  <div className="kb-file-actions">
                    <button type="button" className="btn btn-sm" disabled={savingVisibility}
                      onClick={() => editingFileId === f.fileId ? setEditingFileId(null) : startEditFile(f)}>
                      {editingFileId === f.fileId ? "收合編輯" : "編輯標籤"}
                    </button>
                    <button type="button" className="btn btn-danger btn-sm" disabled={savingVisibility}
                      aria-label={`刪除 ${f.name}`} onClick={() => removeFile(f)}>刪除檔案</button>
                  </div>
                  {editingFileId === f.fileId && <div className="kb-file-editor">
                    <div className="row-title">選擇可見性標籤 <span className="row-sub">已選 {editScopes.length} 個</span></div>
                    <div className="kb-label-options" role="group" aria-label="可見性標籤選項">
                      {labels.map((label) => <label key={label.id}>
                        <Checkbox checked={editScopes.includes(label.id)} disabled={savingVisibility} onChange={() => toggleEditScope(label.id)} />
                        <span>{label.label}</span>
                      </label>)}
                      {labels.length === 0 && <div className="row-sub">請先在「可見性標籤」新增標籤。</div>}
                    </div>
                    {editScopes.length === 0 && <div className="row-sub">未選擇任何標籤，儲存後無人可查詢。</div>}
                    <div className="kb-file-actions">
                      <button type="button" className="btn btn-primary btn-sm" disabled={savingVisibility} onClick={() => saveFileVisibility(f)}>{savingVisibility ? "儲存中…" : "儲存標籤"}</button>
                      <button type="button" className="btn btn-sm" disabled={savingVisibility} onClick={() => setEditingFileId(null)}>取消</button>
                    </div>
                  </div>}
                </li>
              );
            })}
            {visibleFiles.length === 0 && <li className="empty">{sortedFiles.length ? "找不到符合條件的檔案，請調整搜尋或篩選。" : "尚未匯入檔案。"}</li>}
          </ul>
          <nav className="kb-file-pagination" aria-label="檔案清單分頁">
            <span className="row-sub" aria-live="polite">共 {filteredFiles.length} 份 · 第 {currentPage} / {pageCount} 頁</span>
            <div className="kb-file-actions">
              <button type="button" className="btn btn-sm" disabled={currentPage <= 1 || savingVisibility} onClick={() => setFilePage(currentPage - 1)}>上一頁</button>
              <button type="button" className="btn btn-sm" disabled={currentPage >= pageCount || savingVisibility} onClick={() => setFilePage(currentPage + 1)}>下一頁</button>
            </div>
          </nav>
        </section>

        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">索引狀態</div>
              <div className="card-desc">解析進度與目前索引摘要。</div>
            </div>
            <span className="badge badge-on">權限過濾已強制啟用</span>
          </div>
          <div className="card-body">
            {running ? (
              <div className="row-sub">
                階段：{job!.status}｜已爬 {job!.pagesCrawled} 頁｜已 embed{" "}
                {job!.embedded} / {job!.chunks}
              </div>
            ) : meta.status === "ready" ? (
              <>
                <dl className="kb-index-summary">
                  <div><dt>已建立段落</dt><dd>{meta.chunkCount} 個</dd></div>
                  <div><dt>來源</dt><dd>{meta.source ?? "—"}</dd></div>
                  <div><dt>更新時間</dt><dd>{meta.generatedAt ? new Date(meta.generatedAt).toLocaleString("zh-TW") : "—"}</dd></div>
                </dl>
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
            ) : meta.status === "failed" ? (
              <div className="row-sub">失敗：{meta.error ?? "未知錯誤"}</div>
            ) : (
              <div className="row-sub">
                尚未建立索引，設定來源後按「開始解析」。
              </div>
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

        <div className="card" ref={testCardRef}>
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


    </div>
  );
}

