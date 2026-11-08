import type { IngestJob, KnowledgeMeta } from "../../../api";

/** 解析工作的階段，顯示用中文 */
const JOB_STATUS_LABEL: Record<string, string> = {
  queued: "排隊中",
  crawling: "讀取網頁中",
  embedding: "建立向量中",
  done: "完成",
  failed: "失敗",
};

/** 「來源與檔案」子頁的索引狀態卡：解析進度與目前索引摘要（唯讀） */
export default function IndexStatusCard({ meta, job }: { meta: KnowledgeMeta; job: IngestJob | null }) {
  const running = !!job && ["queued", "crawling", "embedding"].includes(job.status);
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">索引狀態</div>
          <div className="card-desc">解析進度與目前索引摘要。開場推薦詞請到「開場推薦詞」子頁。</div>
        </div>
        <span className="badge badge-on">權限過濾已強制啟用</span>
      </div>
      <div className="card-body">
        {running ? (
          <div className="row-sub">
            階段：{JOB_STATUS_LABEL[job!.status] ?? job!.status}｜已讀取 {job!.pagesCrawled} 頁｜已建立向量{" "}
            {job!.embedded} / {job!.chunks} 個段落
          </div>
        ) : meta.status === "ready" ? (
          <>
            <dl className="kb-index-summary">
              <div><dt>已建立段落</dt><dd>{meta.chunkCount} 個</dd></div>
              <div><dt>來源</dt><dd>{meta.source ?? "—"}</dd></div>
              <div><dt>更新時間</dt><dd>{meta.generatedAt ? new Date(meta.generatedAt).toLocaleString("zh-TW") : "—"}</dd></div>
            </dl>
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
  );
}
