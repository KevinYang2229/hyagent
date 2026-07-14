import { useCallback, useEffect, useRef, useState } from "react";
import { Checkbox, useToast } from "@oa-agent/ui";
import {
  api,
  type IngestJob,
  type KnowledgeFileMeta,
  type KnowledgeMeta,
  type KnowledgeSource,
  type QueryHit,
} from "../../api";

const EMBEDDING_MODELS = ["text-embedding-3-large", "text-embedding-3-small"];

export default function KnowledgeTab({
  tenantId,
  onError,
}: {
  tenantId: string;
  onError: (e: unknown) => void;
}) {
  const toast = useToast();
  const [src, setSrc] = useState<KnowledgeSource | null>(null);
  // 後端實際生效的來源設定（上傳檔案沿用它切塊/embed）；src 是表單編輯值，可能尚未儲存
  const [savedSrc, setSavedSrc] = useState<KnowledgeSource | null>(null);
  const [meta, setMeta] = useState<KnowledgeMeta | null>(null);
  const [job, setJob] = useState<IngestJob | null>(null);
  const [question, setQuestion] = useState("");
  const [hits, setHits] = useState<QueryHit[]>([]);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false); // 拖放上傳區的 drag-over 高亮
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const d = await api.getKnowledge(tenantId);
      setSrc(d.source);
      setSavedSrc(d.source);
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

  const save = async () => {
    if (!src) return;
    setSaving(true);
    try {
      await api.saveKnowledgeSource(tenantId, src);
      await load();
      toast.success("已儲存變更");
    } catch (e) {
      onError(e);
    } finally {
      setSaving(false);
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

  const ingest = async () => {
    if (!src) return;
    try {
      await api.saveKnowledgeSource(tenantId, src);
      const { jobId } = await api.startKnowledgeIngest(tenantId);
      startPoll(jobId);
    } catch (e) {
      onError(e);
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

  const uploadFile = async (file: File) => {
    setUploading(true);
    try {
      const meta = await api.uploadKnowledgeFile(tenantId, file);
      toast.success(`已匯入 ${meta.chunks} 個段落`);
      await load();
    } catch (e) {
      onError(e);
    } finally {
      setUploading(false);
    }
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

  return (
    // 兩欄各自直向堆疊：欄內卡片緊密相接，不會像單一 grid 那樣在矮卡旁留出空洞
    <div className="kb-cols">
      <div className="kb-col">
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">知識來源</div>
              <div className="card-desc">
                輸入網站與參數，解析後建立此租戶專屬的 RAG 索引。
              </div>
            </div>
          </div>
          <div className="card-body">
            <div className="form-grid">
              <div className="field">
                <label className="field-label">起始網址</label>
                <input
                  className="input"
                  value={src.startUrl}
                  onChange={(e) => update({ startUrl: e.target.value })}
                  placeholder="https://www.example.com/"
                />
              </div>
              <div className="field">
                <label className="field-label">最大頁數</label>
                <input
                  className="input"
                  type="number"
                  value={src.maxPages}
                  onChange={(e) => update({ maxPages: Number(e.target.value) })}
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
                />
              </div>
              <div className="field">
                <label className="field-label">chunk 大小（字元）</label>
                <input
                  className="input"
                  type="number"
                  value={src.chunkChars}
                  onChange={(e) =>
                    update({ chunkChars: Number(e.target.value) })
                  }
                />
              </div>
              <div className="field">
                <label className="field-label">embedding 模型</label>
                <select
                  className="select"
                  value={src.embeddingModel}
                  onChange={(e) => update({ embeddingModel: e.target.value })}
                >
                  {EMBEDDING_MODELS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label className="field-label">LLM 重排</label>
                <label
                  style={{ display: "flex", alignItems: "center", gap: 8 }}
                >
                  <Checkbox
                    checked={src.rerank}
                    onChange={(e) => update({ rerank: e.target.checked })}
                  />
                  <span className="field-hint">
                    啟用兩階段檢索（精準度↑，每次查詢多一次呼叫）
                  </span>
                </label>
              </div>
            </div>

            <div className="form-actions">
              <button
                className="btn btn-primary"
                onClick={save}
                disabled={saving || running}
              >
                儲存設定
              </button>
              <button
                className="btn btn-primary"
                onClick={ingest}
                disabled={running || !src.startUrl}
              >
                開始解析
              </button>
              <button
                className="btn btn-danger"
                onClick={clear}
                disabled={running || meta.status === "none"}
              >
                清除索引
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="kb-col">
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">檔案來源</div>
              <div className="card-desc">
                上傳規章文件，內容與網站來源合併建立索引，供 AI 問答檢索。
              </div>
            </div>
          </div>
          <div className="card-body">
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,.md,.pdf,.docx"
              style={{ display: "none" }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void uploadFile(file);
                e.target.value = ""; // 允許再次上傳同一檔
              }}
            />
            {/* 拖放上傳區：點擊/拖曳/鍵盤皆可觸發；上傳中顯示進度並停用 */}
            <div
              role="button"
              tabIndex={0}
              aria-label="上傳檔案"
              className={`kdrop${dragOver ? " kdrop--over" : ""}${uploading ? " kdrop--busy" : ""}`}
              onClick={() => !uploading && fileInputRef.current?.click()}
              onKeyDown={(e) => {
                if (!uploading && (e.key === "Enter" || e.key === " ")) {
                  e.preventDefault();
                  fileInputRef.current?.click();
                }
              }}
              onDragOver={(e) => {
                e.preventDefault();
                if (!uploading) setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                if (uploading) return;
                const file = e.dataTransfer.files?.[0];
                if (!file) return;
                const ext = file.name
                  .slice(file.name.lastIndexOf(".") + 1)
                  .toLowerCase();
                if (!["txt", "md", "pdf", "docx"].includes(ext)) {
                  toast.error("僅支援 TXT、MD、PDF、DOCX 檔案");
                  return;
                }
                void uploadFile(file);
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
                  <div className="kdrop-title">拖曳檔案到這裡，或點擊選擇</div>
                  <div className="kdrop-sub">
                    支援 TXT・MD・PDF・DOCX，單檔上限 10MB
                  </div>
                </>
              )}
            </div>

            {/* 上傳即解析：把實際套用的參數攤在檯面上，避免使用者不知道用了哪組設定 */}
            {savedSrc && (
              <div className="field-hint" style={{ marginTop: 8 }}>
                上傳後立即以「知識來源」的已儲存設定建立索引：每段約{" "}
                {savedSrc.chunkChars} 字、embedding 模型{" "}
                {meta.model ?? savedSrc.embeddingModel}
                {meta.model && meta.model !== savedSrc.embeddingModel
                  ? "（同一索引須沿用既有模型）"
                  : ""}
                。要調整請先修改左側設定並儲存，再重新上傳檔案。
              </div>
            )}

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
                          className="btn btn-ghost btn-sm kfile-del"
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
        </div>

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
              <div className="row-sub">
                {meta.chunkCount} 片段｜來源 {meta.source ?? "—"}｜
                {meta.generatedAt ?? ""}
              </div>
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
