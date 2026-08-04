import { useCallback, useEffect, useRef, useState } from "react";
import { Checkbox, useToast } from "@oa-agent/ui";
import {
  api,
  type IngestJob,
  type KnowledgeFileMeta,
  type KnowledgeMeta,
  type KnowledgeSource,
  type PromptSource,
  type QueryHit,
  type SuggestedPromptText,
} from "../../api";
import NumberField from "../../components/NumberField";

const EMBEDDING_MODELS = ["text-embedding-3-large", "text-embedding-3-small"];
type SourceKind = "website" | "file";

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
  const [hits, setHits] = useState<QueryHit[]>([]);
  const [uploading, setUploading] = useState(false);
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

  useEffect(() => {
    load();
    return () => {
      if (poll.current) clearInterval(poll.current);
    };
  }, [load]);

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
      const { hits } = await api.knowledgeQueryTest(tenantId, question);
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
      await load();
    } catch (e) {
      onError(e);
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
                  accept=".txt,.md,.htm,.html,.doc,.docx,.pdf"
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
                    if (
                      !["txt", "md", "htm", "html", "doc", "docx", "pdf"].includes(ext)
                    ) {
                      toast.error("僅支援 TXT、MD、HTM、DOC、DOCX、PDF 檔案");
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
                          : "支援 TXT・MD・HTM・DOC・DOCX・PDF，單檔上限 10MB（DOCX 檢索準確度最佳）"}
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
                          <div className="field">
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
                              style={{ marginInlineStart: 4 }}
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
