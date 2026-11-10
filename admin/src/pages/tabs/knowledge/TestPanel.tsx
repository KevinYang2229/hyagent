import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, type KnowledgeLabel, type QueryHit, type QueryTestPrincipal } from "../../../api";
import CollapsibleList from "../../../components/CollapsibleList";
import { labelNameFor } from "../knowledgeAcl.util";

/**
 * 「測試查詢」子頁：以指定身分（留空＝網站訪客）試查索引，回報實際使用的身分與可見範圍。
 * 從回饋分頁「用這題測試檢索」帶入 ?q=問題&as=提問者，預填後由管理員按下測試。
 */
export default function TestPanel({ tenantId, labels, indexEpoch, onError, readonly = false }: {
  tenantId: string;
  labels: KnowledgeLabel[];
  /** 索引被清除時遞增：舊的查詢結果已不代表現況，要一併清掉 */
  indexEpoch: number;
  onError: (e: unknown) => void;
  /** 唯讀：測試查詢是 POST（會呼叫 AI 檢索），唯讀帳號不能執行 */
  readonly?: boolean;
}) {
  const [searchParams] = useSearchParams();
  const [question, setQuestion] = useState(searchParams.get("q") ?? "");
  const [asUserId, setAsUserId] = useState(searchParams.get("as") ?? ""); // 試查身分：留空＝以網站訪客身分
  const [hits, setHits] = useState<QueryHit[]>([]);
  const [queriedAs, setQueriedAs] = useState<QueryTestPrincipal | null>(null);
  const testCardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (searchParams.get("q")) testCardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [searchParams]);

  useEffect(() => {
    setHits([]);
    setQueriedAs(null);
  }, [indexEpoch]);

  const test = async () => {
    try {
      const { hits, principal } = await api.knowledgeQueryTest(tenantId, question, asUserId.trim() || undefined);
      setHits(hits);
      setQueriedAs(principal ?? null);
    } catch (e) {
      onError(e);
    }
  };

  return (
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
            disabled={readonly || !question}
            title={readonly ? "測試查詢需要知識庫的編輯權限" : undefined}
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
            placeholder="輸入帳號；留空＝以網站訪客（未登入）身分查詢"
          />
        </div>
        {queriedAs && (
          <div className="row-sub" role="status" style={{ marginTop: 8 }}>
            本次以{queriedAs.kind === "guest" ? "網站訪客" : `「${queriedAs.userId}」`}查詢
            {queriedAs.kind === "user" && `（部門：${queriedAs.department === "__unassigned__" ? "未指定部門" : queriedAs.department}${queriedAs.inDirectory ? "" : "；不在使用者目錄，若帳號輸入錯誤請更正"}）`}
            ・可見範圍：<CollapsibleList items={queriedAs.labels} render={(scope) => labelNameFor(labels, scope)} empty="無（查不到任何檔案或網站內容）" />
          </div>
        )}
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
  );
}
