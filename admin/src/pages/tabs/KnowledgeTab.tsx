import { useCallback, useEffect, useRef, useState } from "react";
import { Checkbox } from "@oa-agent/ui";
import {
  api,
  type IngestJob,
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
  const [src, setSrc] = useState<KnowledgeSource | null>(null);
  const [meta, setMeta] = useState<KnowledgeMeta | null>(null);
  const [job, setJob] = useState<IngestJob | null>(null);
  const [question, setQuestion] = useState("");
  const [hits, setHits] = useState<QueryHit[]>([]);
  const [saving, setSaving] = useState(false);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api.getKnowledge(tenantId);
      setSrc(d.source);
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

  if (!src || !meta)
    return (
      <div className="card">
        <div className="card-body">載入中…</div>
      </div>
    );
  const running =
    !!job && ["queued", "crawling", "embedding"].includes(job.status);

  return (
    <div className="appearance-grid">
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
                onChange={(e) => update({ chunkChars: Number(e.target.value) })}
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
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
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
  );
}
