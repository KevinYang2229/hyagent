/**
 * 登入 Session 管理（規格 §7.4）。
 *
 * 取代改造前的「盲打 sub 作廢」：後台本來就沒有任何地方查得到使用者的 sub，
 * 那個輸入框只有在客戶打電話來報工號時才用得上。改成列表後，管理員看得到再點。
 *
 * ## 搜尋的能力邊界（hint 裡那句話不是客套）
 *
 * `sub` 在後端只以 HMAC 與密文落地（見 server/src/lib/auth-session.store.ts 檔頭第 3 點），
 * 密文上做不了模糊比對。所以搜尋一個欄位走兩條路、取聯集：完整 sub 精確命中，
 * 或 name 關鍵字模糊命中。**沒帶 name 的 Session 一定要打完整工號才找得到**——
 * 這是加密設計的必然代價，寫在畫面上比讓人以為系統壞了好。
 */
import { useCallback, useEffect, useState } from 'react';
import { api, type AuthSessionPage, type TenantPublicKey } from '../../api';

const PAGE_SIZE = 50;

/** 顯示用的使用者欄：與後端 getApplicant 同一條 fallback 規則（name ?? sub）。 */
function displayName(session: { name?: string; sub: string }): string {
  return session.name ?? session.sub;
}

function remaining(expiresAt: string): string {
  const ms = Date.parse(expiresAt) - Date.now();
  if (ms <= 0) return '已過期';
  const minutes = Math.round(ms / 60000);
  return minutes < 60 ? `${minutes} 分鐘後` : `${Math.round(minutes / 60)} 小時後`;
}

export default function SessionsPanel({
  tenantId,
  keys,
  onError,
}: {
  tenantId: string;
  /** 供 kid 篩選；撤銷公鑰前想看影響範圍時，這個下拉是最快的路徑 */
  keys: TenantPublicKey[];
  onError: (e: unknown) => void;
}) {
  const [page, setPage] = useState<AuthSessionPage | null>(null);
  // draft 是輸入中的字，query 是已送出的條件——不邊打邊查，避免每個字都打一次 API
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [kid, setKid] = useState('');
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const load = useCallback(() => {
    void api
      .listSessions(tenantId, {
        ...(query ? { query } : {}),
        ...(kid ? { kid } : {}),
        limit: PAGE_SIZE,
        offset,
      })
      .then(setPage)
      .catch(onError);
  }, [tenantId, query, kid, offset, onError]);

  useEffect(load, [load]);

  async function run(fn: () => Promise<string>): Promise<void> {
    setBusy(true);
    setNotice('');
    try {
      setNotice(await fn());
      load();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  const search = (): void => {
    setQuery(draft.trim());
    setOffset(0);
  };

  const revokeOne = (session: { id: string; name?: string; sub: string }): void => {
    if (!window.confirm(`作廢 ${displayName(session)} 的這個 Session？對方會立刻被登出。`)) return;
    void run(async () => {
      await api.revokeSession(tenantId, session.id);
      return `已作廢 ${displayName(session)} 的 1 個 Session`;
    });
  };

  const revokeAllOf = (session: { name?: string; sub: string }): void => {
    if (
      !window.confirm(
        `作廢 ${displayName(session)} 的所有 Session？\n\n` +
          '同一個人在多個分頁或裝置登入時會全部被登出。\n' +
          '若是帳號停權，請先在客戶自家系統停權，否則對方的 Identity Endpoint 還會繼續簽發新憑證。',
      )
    )
      return;
    void run(async () => {
      const r = await api.revokeSessionsBySub(tenantId, session.sub);
      return `已作廢 ${displayName(session)} 的 ${r.revoked} 個 Session`;
    });
  };

  const total = page?.total ?? 0;
  const shown = page?.sessions ?? [];

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">登入 Session</div>
          <div className="card-desc">
            此租戶目前有效的登入。作廢後對方立刻被登出，但<strong>不會阻止重新登入</strong>
            ——帳號停權請先在客戶自家系統處理，否則對方的 Identity Endpoint 會繼續簽發新憑證。
          </div>
        </div>
        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={load}>
          重新整理
        </button>
      </div>
      <div className="card-body">
        <div className="field">
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input
              className="input"
              style={{ flex: '1 1 220px' }}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && search()}
              placeholder="姓名或工號"
            />
            <select
              className="select"
              style={{ flex: '0 1 200px' }}
              value={kid}
              onChange={(e) => {
                setKid(e.target.value);
                setOffset(0);
              }}
            >
              <option value="">全部公鑰</option>
              {keys.map((k) => (
                <option key={k.kid} value={k.kid}>
                  {k.label ? `${k.label}（${k.kid.slice(0, 8)}…）` : k.kid}
                </option>
              ))}
            </select>
            <button className="btn" disabled={busy} onClick={search}>
              搜尋
            </button>
            {(query || kid) && (
              <button
                className="btn btn-ghost"
                disabled={busy}
                onClick={() => {
                  setDraft('');
                  setQuery('');
                  setKid('');
                  setOffset(0);
                }}
              >
                清除
              </button>
            )}
          </div>
          <span className="field-hint">
            姓名可輸入關鍵字；工號需完整輸入。客戶的 Assertion 沒帶 <code>name</code>{' '}
            時只有工號可查——使用者識別碼在我們這裡不以明文保存，無法做關鍵字比對。
          </span>
        </div>

        {page === null ? (
          <p className="field-hint">載入中…</p>
        ) : total === 0 ? (
          <div className="empty">
            {query || kid ? '沒有符合條件的 Session。' : '目前沒有人登入。'}
          </div>
        ) : (
          <>
            <table style={{ width: '100%', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left' }}>
                  <th>使用者</th>
                  <th>建立於</th>
                  <th>到期</th>
                  <th>公鑰</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((s) => (
                  <tr key={s.id}>
                    <td>
                      {displayName(s)}
                      {!s.name && (
                        <span className="field-hint" style={{ marginLeft: 6 }}>
                          （客戶未提供姓名）
                        </span>
                      )}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {new Date(s.createdAt).toLocaleString()}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }} title={new Date(s.expiresAt).toLocaleString()}>
                      {remaining(s.expiresAt)}
                    </td>
                    <td style={{ fontFamily: 'monospace' }} title={s.kid}>
                      {s.kid.slice(0, 8)}…
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn" disabled={busy} onClick={() => revokeOne(s)}>
                        作廢
                      </button>
                      <button className="btn" disabled={busy} onClick={() => revokeAllOf(s)}>
                        作廢此人全部
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div
              style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end' }}
            >
              <span className="field-hint">
                {offset + 1}–{offset + shown.length} / 共 {total} 個
              </span>
              <button
                className="btn"
                disabled={busy || offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                上一頁
              </button>
              <button
                className="btn"
                disabled={busy || offset + shown.length >= total}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                下一頁
              </button>
            </div>
          </>
        )}

        {notice && <p className="field-hint" role="status">{notice}</p>}
      </div>
    </div>
  );
}
