/**
 * 租戶的 AI 回覆回饋：統計、可篩選的清單（每頁 10 筆、無限捲動）、詳情（問答、檢索紀錄、判斷、處理狀態）。
 * 回答一律以純文字顯示：後台不需要排版，也不讓回答裡的連結或圖片被渲染。
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { api, type FeedbackFilterQuery, type FeedbackItem, type FeedbackReasonKey, type FeedbackStats } from '../../api';

const REASON_LABEL: Record<FeedbackReasonKey, string> = {
  wrong: '答錯了',
  not_answered: '沒回答到問題',
  outdated: '資料過時',
  inappropriate: '內容不恰當',
  other: '其他',
};
const SERVICE_LABEL: Record<string, string> = { knowledge: '知識庫', agent: '智慧代理', form: '表單', report: '報告' };
const serviceLabel = (id: string): string => SERVICE_LABEL[id] ?? id;

const SCROLL_MAX_HEIGHT = 480;
const th: CSSProperties = { textAlign: 'left', padding: '8px 10px', boxShadow: 'inset 0 -1px 0 var(--border-color)', fontWeight: 500, whiteSpace: 'nowrap', position: 'sticky', top: 0, zIndex: 1, background: 'var(--card-bg)' };
const td: CSSProperties = { padding: '6px 10px', borderBottom: '1px solid var(--border-color)', verticalAlign: 'top' };
const tdNowrap: CSSProperties = { ...td, whiteSpace: 'nowrap' };

/** 一行初步判斷：依序套用第一條成立者（見設計文件 §7.3） */
export function diagnose(f: FeedbackItem): string | null {
  const chunks = f.trace?.retrieval?.chunks;
  if (f.serviceId === 'knowledge' && chunks && chunks.length === 0 && !f.trace?.retrieval?.usedTables) {
    return '沒檢索到資料：知識庫可能缺這份內容，或提問者沒有權限看到';
  }
  if (f.reason === 'outdated') return '資料可能過時：請更新下列來源';
  if (f.reason === 'wrong' && chunks && chunks.length > 0) {
    return '有檢索到資料：請確認片段內容是否正確，或是模型理解錯誤';
  }
  return null;
}

type RatingFilter = '' | 'up' | 'down';
type StatusFilter = '' | 'open' | 'resolved';

export default function FeedbackTab({
  tenantId,
  onError,
  onTestRetrieval,
}: {
  tenantId: string;
  onError: (e: unknown) => void;
  onTestRetrieval: (question: string, asUserId: string) => void;
}) {
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [stats, setStats] = useState<FeedbackStats | null>(null);
  const [rating, setRating] = useState<RatingFilter>('down');
  const [status, setStatus] = useState<StatusFilter>('open');
  const [serviceId, setServiceId] = useState('');
  const [reason, setReason] = useState<'' | FeedbackReasonKey>('');
  const [rows, setRows] = useState<FeedbackItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const genRef = useRef(0);
  const loadingRef = useRef(false);

  const filter: FeedbackFilterQuery = {
    ...(rating ? { rating } : {}),
    ...(status ? { status } : {}),
    ...(serviceId ? { serviceId } : {}),
    ...(reason ? { reason } : {}),
  };
  const filterKey = JSON.stringify(filter);

  useEffect(() => {
    api.getFeedbackStats(tenantId, days).then(setStats).catch(onError);
  }, [tenantId, days, onError]);

  useEffect(() => {
    const gen = ++genRef.current;
    loadingRef.current = false;
    setRows(null);
    setCursor(null);
    setOpenId(null);
    api
      .listFeedback(tenantId, JSON.parse(filterKey) as FeedbackFilterQuery, undefined)
      .then((page) => {
        if (gen !== genRef.current) return;
        setRows(page.items);
        setCursor(page.nextCursor);
      })
      .catch((e) => {
        if (gen === genRef.current) onError(e);
      });
  }, [tenantId, filterKey, onError]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingRef.current) return;
    const gen = genRef.current;
    loadingRef.current = true;
    setLoading(true);
    try {
      const page = await api.listFeedback(tenantId, JSON.parse(filterKey) as FeedbackFilterQuery, cursor);
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
  }, [cursor, tenantId, filterKey, onError]);

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

  async function updateStatus(f: FeedbackItem, next: 'open' | 'resolved') {
    try {
      const trimmed = note.trim();
      const updated = await api.updateFeedback(tenantId, f.id, { status: next, ...(trimmed ? { resolutionNote: trimmed } : {}) });
      setRows((prev) => prev?.map((r) => (r.id === updated.id ? updated : r)) ?? prev);
      setNote(updated.resolutionNote ?? '');
      api.getFeedbackStats(tenantId, days).then(setStats).catch(onError);
    } catch (e) {
      onError(e);
    }
  }

  function toggleRow(f: FeedbackItem) {
    setOpenId(f.id === openId ? null : f.id);
    setNote(f.resolutionNote ?? '');
  }

  const open = rows?.find((r) => r.id === openId);

  // 詳情卡在 480px 捲動清單下方：點開後捲過去，否則看起來像點了沒反應
  useEffect(() => {
    if (openId) detailRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [openId]);

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">回饋統計</div>
            <div className="card-desc">使用者對 AI 回覆的評價。倒讚請點開查看當時的檢索紀錄，修正後標為已處理。</div>
          </div>
          <select className="input" aria-label="統計期間" value={days} onChange={(e) => setDays(Number(e.target.value) as 7 | 30 | 90)}>
            <option value={7}>最近 7 天</option>
            <option value={30}>最近 30 天</option>
            <option value={90}>最近 90 天</option>
          </select>
        </div>
        <div className="card-body">
          {!stats ? (
            <div className="row-sub">載入中…</div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, fontSize: 14 }}>
              <div>評價 <strong>{stats.total}</strong></div>
              <div>讚 <strong>{stats.total ? Math.round((stats.up / stats.total) * 100) : 0}%</strong></div>
              <div className={stats.openDown > 0 ? 'badge badge-warn' : 'badge'}>{`待處理 ${stats.openDown}`}</div>
              <div>
                {Object.entries(stats.byService).map(([svc, c]) => (
                  <span key={svc} style={{ marginRight: 12 }}>{`${serviceLabel(svc)} 👍${c.up} 👎${c.down}`}</span>
                ))}
              </div>
              <div>
                {(Object.keys(REASON_LABEL) as FeedbackReasonKey[]).map((r) => (
                  <span key={r} style={{ marginRight: 12 }}>{`${REASON_LABEL[r]} ${stats.byReason[r]}`}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div className="card-title">回饋清單</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <select className="input" aria-label="評價" value={rating} onChange={(e) => setRating(e.target.value as RatingFilter)}>
              <option value="">全部評價</option>
              <option value="down">倒讚</option>
              <option value="up">讚</option>
            </select>
            <select className="input" aria-label="處理狀態" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
              <option value="">全部狀態</option>
              <option value="open">待處理</option>
              <option value="resolved">已處理</option>
            </select>
            <select className="input" aria-label="服務" value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
              <option value="">全部服務</option>
              {Object.entries(SERVICE_LABEL).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
            <select className="input" aria-label="原因" value={reason} onChange={(e) => setReason(e.target.value as '' | FeedbackReasonKey)}>
              <option value="">全部原因</option>
              {(Object.keys(REASON_LABEL) as FeedbackReasonKey[]).map((r) => <option key={r} value={r}>{REASON_LABEL[r]}</option>)}
            </select>
          </div>
        </div>
        {/* 上方不留 padding：sticky 表頭只會貼到 padding 內緣（同 AuditTab） */}
        <div ref={scrollRef} className="card-body" style={{ overflow: 'auto', maxHeight: SCROLL_MAX_HEIGHT, paddingTop: 0 }}>
          {!rows ? (
            <div className="row-sub" style={{ paddingTop: 16 }}>載入中…</div>
          ) : rows.length === 0 ? (
            <div className="row-sub" style={{ paddingTop: 16 }}>沒有符合條件的回饋。</div>
          ) : (
            <>
              <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13.5 }}>
                <thead>
                  <tr>
                    <th style={th}>時間</th>
                    <th style={th}>使用者</th>
                    <th style={th}>服務</th>
                    <th style={th}>評價</th>
                    <th style={th}>問題</th>
                    <th style={th}>狀態</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((f) => (
                    <tr key={f.id} onClick={() => toggleRow(f)} style={{ cursor: 'pointer', background: f.id === openId ? 'var(--hover-bg, rgba(0,0,0,0.03))' : undefined }}>
                      <td style={tdNowrap}>{new Date(f.createdAt).toLocaleString()}</td>
                      <td style={tdNowrap}>{f.userId}</td>
                      <td style={tdNowrap}>{serviceLabel(f.serviceId)}</td>
                      <td style={tdNowrap}>{f.rating === 'up' ? '👍' : `👎 ${f.reason ? REASON_LABEL[f.reason] : ''}`}</td>
                      <td style={{ ...td, maxWidth: 360 }}>
                        <button
                          type="button"
                          aria-expanded={f.id === openId}
                          onClick={(e) => { e.stopPropagation(); toggleRow(f); }}
                          className="feedback-row-btn"
                        >
                          {f.question}
                        </button>
                      </td>
                      <td style={tdNowrap}>{f.status === 'open' ? '待處理' : '已處理'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div ref={sentinelRef} aria-hidden style={{ height: 1 }} />
              <div className="row-sub" style={{ textAlign: 'center', padding: 8 }} aria-live="polite">
                {loading ? '載入中…' : cursor ? '' : '已顯示全部回饋'}
              </div>
            </>
          )}
        </div>
      </div>

      {open && (
        <div ref={detailRef} className="card">
          <div className="card-head">
            <div className="card-title">回饋詳情</div>
            <button type="button" className="btn" onClick={() => onTestRetrieval(open.question, open.userId)}>用這題測試檢索</button>
          </div>
          <div className="card-body" style={{ display: 'grid', gap: 12, fontSize: 14 }}>
            {diagnose(open) && <div className="badge badge-warn" style={{ justifySelf: 'start' }}>{diagnose(open)}</div>}
            <div><div className="row-sub">問題</div><div style={{ whiteSpace: 'pre-wrap' }}>{open.question}</div></div>
            <div><div className="row-sub">回答</div><div style={{ whiteSpace: 'pre-wrap' }}>{open.answer}</div></div>
            {open.comment && <div><div className="row-sub">使用者說明</div><div style={{ whiteSpace: 'pre-wrap' }}>{open.comment}</div></div>}
            {open.trace?.retrieval && (
              <div>
                <div className="row-sub">{`檢索紀錄（問句：${open.trace.retrieval.query}；候選 ${open.trace.retrieval.poolSize} 筆${open.trace.retrieval.usedTables ? '；含資料表' : ''}）`}</div>
                {open.trace.retrieval.chunks.length === 0 ? (
                  <div>沒有交給模型的片段。</div>
                ) : (
                  <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>
                    <tbody>
                      {open.trace.retrieval.chunks.map((c) => (
                        <tr key={c.rank}>
                          <td style={tdNowrap}>{`#${c.rank}`}</td>
                          <td style={tdNowrap}>{c.score !== undefined ? c.score.toFixed(3) : '—'}</td>
                          <td style={td}>
                            <div>{c.url && /^https?:/i.test(c.url) ? <a href={c.url} target="_blank" rel="noopener noreferrer">{c.title}</a> : c.title}</div>
                            <div className="row-sub" style={{ whiteSpace: 'pre-wrap' }}>{c.excerpt}</div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
            {open.trace?.tools && <div><div className="row-sub">呼叫的工具</div><div>{open.trace.tools.map((t) => `${t.name}${t.ok ? '' : '（失敗）'}`).join(' → ')}</div></div>}
            {open.trace?.model && <div className="row-sub">{`模型：${open.trace.model}`}</div>}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input className="input" aria-label="處理說明" placeholder="處理說明（選填）" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} style={{ flex: 1 }} />
              {open.status === 'open' ? (
                <button type="button" className="btn btn-primary" onClick={() => void updateStatus(open, 'resolved')}>標為已處理</button>
              ) : (
                <button type="button" className="btn" onClick={() => void updateStatus(open, 'open')}>重新開啟</button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
