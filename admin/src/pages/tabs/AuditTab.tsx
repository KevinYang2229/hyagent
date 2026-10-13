import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { api, type AuditEntry, type AuditPage } from '../../api';

// 固定表頭：border-collapse 下的 border 會跟著內容捲走，底線改用 inset 陰影畫
const th: CSSProperties = { textAlign: 'left', padding: '8px 10px', boxShadow: 'inset 0 -1px 0 var(--border-color)', fontWeight: 500, whiteSpace: 'nowrap', position: 'sticky', top: 0, zIndex: 1, background: 'var(--card-bg)' };
const td: CSSProperties = { padding: '6px 10px', borderBottom: '1px solid var(--border-color)', verticalAlign: 'top' };
const tdNowrap: CSSProperties = { ...td, whiteSpace: 'nowrap' };

/** 捲動區高度：一次只載 10 筆，捲到底再接下一頁 */
const SCROLL_MAX_HEIGHT = 480;

/** 帶 tenantId＝該租戶稽核；不帶＝平台層稽核（建立／刪除租戶、MCP 服務等） */
export default function AuditTab({
  tenantId,
  onError,
  scrollMaxHeight = SCROLL_MAX_HEIGHT,
}: {
  tenantId?: string;
  onError: (e: unknown) => void;
  /** 捲動區高度上限；獨立頁面可撐到視窗高度 */
  scrollMaxHeight?: number | string;
}) {
  const [rows, setRows] = useState<AuditEntry[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  // 切換租戶時作廢上一個租戶尚未回來的請求，避免兩邊資料混在一起
  const genRef = useRef(0);
  const loadingRef = useRef(false);

  const fetchPage = useCallback(
    (before?: string): Promise<AuditPage> => (tenantId ? api.getTenantAudit(tenantId, before) : api.getPlatformAudit(before)),
    [tenantId],
  );

  useEffect(() => {
    const gen = ++genRef.current;
    loadingRef.current = false;
    setRows(null);
    setCursor(null);
    fetchPage()
      .then((page) => {
        if (gen !== genRef.current) return;
        setRows(page.items);
        setCursor(page.nextCursor);
      })
      .catch((e) => {
        if (gen === genRef.current) onError(e);
      });
  }, [fetchPage, onError]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingRef.current) return;
    const gen = genRef.current;
    loadingRef.current = true;
    setLoading(true);
    try {
      const page = await fetchPage(cursor);
      if (gen !== genRef.current) return;
      setRows((prev) => [...(prev ?? []), ...page.items]);
      setCursor(page.nextCursor);
    } catch (e) {
      if (gen === genRef.current) onError(e);
    } finally {
      if (gen === genRef.current) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  }, [cursor, fetchPage, onError]);

  // 底部哨兵進入捲動區即載下一頁。每次游標變動都重建 observer：
  // 第一頁若填不滿捲動區，哨兵一直可見，重建時的初次回呼才會再觸發下一頁
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!cursor || !sentinel || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMore();
      },
      { root: scrollRef.current, rootMargin: '0px 0px 80px 0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [cursor, loadMore]);

  if (!rows) return <div className="card"><div className="card-body">載入中…</div></div>;

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">{tenantId ? '稽核紀錄' : '平台稽核紀錄'}</div>
          <div className="card-desc">
            {tenantId
              ? '有副作用的動作（寄信、送單、後台設定變更）的軌跡：誰、何時、做了什麼、成功與否。只顯示安全摘要（路徑、欄位名），不含內容。'
              : '平台層的後台變更（建立／刪除租戶、MCP 服務）。租戶內的變更請到各租戶的稽核紀錄查看。'}
          </div>
        </div>
      </div>
      {/* 上方不留 padding：sticky 表頭只會貼到 padding 內緣，留著的話捲上去的列會從表頭上方露出來 */}
      <div ref={scrollRef} className="card-body" style={{ overflow: 'auto', maxHeight: scrollMaxHeight, paddingTop: 0 }}>
        {rows.length === 0 ? (
          <div className="row-sub" style={{ paddingTop: 16 }}>尚無稽核紀錄。</div>
        ) : (
          <>
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13.5 }}>
              <thead>
                <tr>
                  <th style={th}>時間</th>
                  <th style={th}>工具</th>
                  <th style={th}>使用者</th>
                  <th style={th}>摘要</th>
                  <th style={th}>狀態</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e, i) => (
                  <tr key={i}>
                    <td style={tdNowrap}>{new Date(e.at).toLocaleString()}</td>
                    <td style={td}>{e.toolId}</td>
                    <td style={td}>{e.userId}</td>
                    <td style={td}>{e.summary}</td>
                    <td style={tdNowrap}>{e.ok ? '✅ 成功' : `⛔ ${e.error ?? '失敗'}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div ref={sentinelRef} aria-hidden style={{ height: 1 }} />
            <div className="row-sub" style={{ textAlign: 'center', padding: 8 }} aria-live="polite">
              {loading ? '載入中…' : cursor ? '' : '已顯示全部紀錄'}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
