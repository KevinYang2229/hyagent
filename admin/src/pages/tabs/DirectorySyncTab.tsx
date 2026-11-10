/**
 * 人員同步分頁：兩個開關、專用同步金鑰、最近一批同步結果。
 *
 * 這裡每個動作都立即生效（沒有「儲存」鈕），與自動登入分頁同一種語意。
 * 同步金鑰與自動登入的 Assertion 金鑰是兩套：金鑰規則（上限、最後一把等）由後端把關，
 * 這裡只負責把後端的錯誤講清楚。
 */
import { useCallback, useEffect, useState } from 'react';
import { Checkbox } from '@hyagent/ui';
import {
  api,
  type DirectorySyncView,
  type KeyOperator,
  type KeyRevocationReason,
  type TenantPublicKey,
} from '../../api';
import { useUnsavedChanges } from '../../components/unsaved';

const REASON_LABEL: Record<KeyRevocationReason, string> = {
  rotated: '輪替汰換',
  aborted: '放棄輪替',
  compromised: '私鑰外洩',
  other: '其他',
};

const VIA_LABEL: Record<KeyOperator['via'], string> = {
  admin: '後台登入',
  'admin-api-key': '管理 API 金鑰',
};

const fmt = (iso: string): string => new Date(iso).toLocaleString();

function keyName(k: TenantPublicKey): string {
  const short = `${k.kid.slice(0, 8)}…`;
  return k.label ? `${k.label}（${short}）` : short;
}

function Stamp({ at, by }: { at?: string; by?: KeyOperator }) {
  if (!at) return <>—</>;
  return (
    <>
      {fmt(at)}
      {by && (
        <div className="field-hint">
          {VIA_LABEL[by.via]}
          {by.ip ? `・${by.ip.replace(/^::ffff:/, '')}` : ''}
        </div>
      )}
    </>
  );
}

const PANEL_STYLE = {
  border: '1px solid var(--border-color)',
  borderRadius: 11,
  padding: '12px 16px',
  display: 'grid',
  gap: 6,
} as const;

type SwitchKey = 'ssoAutoProvision' | 'directorySyncEnabled';

export default function DirectorySyncTab({
  tenantId,
  onError,
  readonly = false,
}: {
  tenantId: string;
  onError: (e: unknown) => void;
  /** 唯讀：可檢視開關、公鑰與同步狀態，不能切換、新增或撤銷 */
  readonly?: boolean;
}) {
  const [view, setView] = useState<DirectorySyncView | null>(null);
  const [pem, setPem] = useState('');
  const [label, setLabel] = useState('');
  useUnsavedChanges('人員同步：新增同步公鑰', pem.trim() !== '' || label.trim() !== '');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [revoking, setRevoking] = useState<TenantPublicKey | null>(null);
  const [savingSwitches, setSavingSwitches] = useState<SwitchKey[]>([]);

  const load = useCallback(() => {
    void api.getDirectorySync(tenantId).then(setView).catch(onError);
  }, [tenantId, onError]);

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

  /**
   * 開關先更新畫面再寫入：db 模式的寫入要等整份快照落地，可能要好幾秒，等回應才動會像沒反應。
   * 失敗時重新讀取而不是直接還原，因為後端可能已改了記憶體、只是寫入失敗，畫面要跟它的實際狀態一致。
   */
  const toggle = async (key: SwitchKey, checked: boolean): Promise<void> => {
    setView((current) => (current ? { ...current, [key]: checked } : current));
    setSavingSwitches((current) => [...current, key]);
    setNotice('');
    try {
      // PATCH 已回傳最新狀態，不必再 GET 一次
      setView(await api.updateDirectorySync(tenantId, { [key]: checked }));
      setNotice('已更新設定');
    } catch (e) {
      onError(e);
      load();
    } finally {
      setSavingSwitches((current) => current.filter((k) => k !== key));
    }
  };

  const add = () =>
    run(async () => {
      const result = await api.addDirectorySyncKey(tenantId, {
        publicKey: pem.trim(),
        ...(label.trim() ? { label: label.trim() } : {}),
      });
      // 冪等回既有那筆（created=false）對操作者而言就是沒成功，丟成錯誤；輸入框保留
      if (!result.created) {
        throw new Error(
          result.key.status === 'revoked'
            ? `這把公鑰已經登記過且已撤銷（${result.key.kid}），撤銷不可復原，請產生一組新的金鑰對`
            : `這把公鑰已經登記過了（${result.key.kid}），未重複新增`,
        );
      }
      setPem('');
      setLabel('');
      return `已新增公鑰 ${result.key.kid}`;
    });

  const revoke = (key: TenantPublicKey, reason: KeyRevocationReason) =>
    run(async () => {
      await api.revokeDirectorySyncKey(tenantId, key.kid, reason);
      setRevoking(null);
      return `已撤銷 ${keyName(key)}（${REASON_LABEL[reason]}）`;
    });

  if (!view) return <p className="field-hint">載入中…</p>;

  const active = view.keys
    .filter((k) => k.status === 'active')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const revoked = view.keys
    .filter((k) => k.status === 'revoked')
    .sort((a, b) => (b.revokedAt ?? b.createdAt).localeCompare(a.revokedAt ?? a.createdAt));
  const revokingTarget = revoking && active.find((k) => k.kid === revoking.kid);
  const status = view.status;

  return (
    <div className="settings-stack">
      {(notice || savingSwitches.length > 0) && (
        <p className="field-hint" role="status">
          {savingSwitches.length > 0 ? '儲存中…' : notice}
        </p>
      )}

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">同步開關</div>
            <div className="card-desc">兩個開關都是按下立即生效，不需另外儲存。</div>
          </div>
        </div>
        <div className="card-body">
          <div className="field">
            <Checkbox
              label="自動登入時建立目錄資料"
              checked={view.ssoAutoProvision}
              disabled={readonly || savingSwitches.includes('ssoAutoProvision')}
              onChange={(e) => void toggle('ssoAutoProvision', e.target.checked)}
            />
            <span className="field-hint">
              開啟後，透過自動登入進來的使用者會在背景寫入使用者目錄。以自動登入識別訪客的公開網站租戶請保持關閉，
              否則所有訪客都會被寫進目錄。
            </span>
          </div>
          <div className="field">
            <Checkbox
              label="接受人員同步"
              checked={view.directorySyncEnabled}
              disabled={readonly || savingSwitches.includes('directorySyncEnabled')}
              onChange={(e) => void toggle('directorySyncEnabled', e.target.checked)}
            />
            <span className="field-hint">
              開啟後，客戶的 OA 系統可推送人員異動到使用者目錄；關閉時一律拒絕。串接方式請交給 OA 團隊參閱
              <code>docs/HANDOFF-DIRECTORY-SYNC.md</code>。
            </span>
            {view.directorySyncEnabled && active.length === 0 && (
              <span className="field-hint" style={{ color: '#b45309' }}>
                尚無啟用中的同步金鑰 —— 已開啟同步，但在上傳公鑰前任何推送都會被拒絕。
              </span>
            )}
          </div>
          <p className="field-hint">
            關閉開關後，由該開關管理的帳號可在「使用者目錄」編輯。自動建立的帳號也會改回使用登入資料：
            本人登入時以憑證為準，目錄中的修改只影響他人查詢時看到的內容。
          </p>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">同步公鑰</div>
            <div className="card-desc">
              客戶以自家私鑰簽署同步請求，這裡只登記對應的<strong>公鑰</strong>。這組金鑰只用於人員同步，
              不可與自動登入共用。
            </div>
          </div>
        </div>
        <div className="card-body">
          {active.length === 0 ? (
            <p className="field-hint" style={{ color: '#b45309' }}>
              {view.keys.length === 0 ? '尚未登記任何同步公鑰' : '尚無啟用中的同步公鑰'} —— 此租戶目前無法接受人員同步。
            </p>
          ) : (
            <table style={{ width: '100%', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left' }}>
                  <th>金鑰編號（kid）</th>
                  <th>演算法</th>
                  <th>備註</th>
                  <th>建立</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {active.map((k) => (
                  <tr key={k.kid}>
                    <td style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{k.kid}</td>
                    <td>{k.alg}</td>
                    <td>{k.label ?? '—'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <Stamp at={k.createdAt} by={k.createdBy} />
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn btn-danger" disabled={readonly || busy} onClick={() => setRevoking(k)}>
                        撤銷
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {revokingTarget && (
            <RevokePanel
              key={revokingTarget.kid}
              target={revokingTarget}
              isLast={active.length === 1}
              canRotate={active.length > 1}
              busy={busy}
              onConfirm={(reason) => void revoke(revokingTarget, reason)}
              onCancel={() => setRevoking(null)}
            />
          )}

          {!readonly && <div className="field">
            <label className="field-label">{active.length ? '上傳新公鑰' : '上傳公鑰'}</label>
            <span className="field-hint">
              貼上 SPKI PEM（<code>-----BEGIN PUBLIC KEY-----</code>）或 JWK。這組金鑰只用於人員同步，
              不可與自動登入共用。請客戶只提供公鑰，私鑰絕不可離開他們的環境。
            </span>
            <textarea
              className="input"
              rows={5}
              value={pem}
              onChange={(e) => setPem(e.target.value)}
              placeholder="-----BEGIN PUBLIC KEY-----"
            />
            <input
              className="input"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="備註（選填），例如「2026 正式環境」"
            />
            <div className="form-actions">
              <button className="btn btn-primary" disabled={busy || !pem.trim()} onClick={() => void add()}>
                新增公鑰
              </button>
            </div>
          </div>}
        </div>
      </div>

      {revoked.length > 0 && (
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">已撤銷的公鑰（{revoked.length}）</div>
              <div className="card-desc">撤銷不可復原。紀錄留存供稽核：撤銷原因、時間與操作者。</div>
            </div>
          </div>
          <div className="card-body">
            <table style={{ width: '100%', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left' }}>
                  <th>金鑰編號（kid）</th>
                  <th>撤銷原因</th>
                  <th>備註</th>
                  <th>撤銷</th>
                </tr>
              </thead>
              <tbody>
                {revoked.map((k) => (
                  <tr key={k.kid}>
                    <td style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{k.kid}</td>
                    <td>
                      <span className={`badge ${k.revokedReason === 'compromised' ? 'badge-warn' : 'badge-off'}`}>
                        {k.revokedReason ? REASON_LABEL[k.revokedReason] : '未記錄'}
                      </span>
                    </td>
                    <td>{k.label ?? '—'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <Stamp at={k.revokedAt} by={k.revokedBy} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">最近同步</div>
            <div className="card-desc">最近一批人員異動的處理結果。</div>
          </div>
        </div>
        <div className="card-body">
          {status ? (
            <p className="field-hint">
              {fmt(status.at)}・已套用 {status.applied}・過期略過 {status.stale}・拒絕 {status.rejected}
            </p>
          ) : (
            <p className="field-hint">尚未同步</p>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * 撤銷同步金鑰：先選原因再確定。原因不給預設值，免得稽核紀錄混進沒人真的選過的答案。
 * 「輪替汰換」只在另有啟用中金鑰時提供（換新後汰換舊的）。
 */
function RevokePanel({
  target,
  isLast,
  canRotate,
  busy,
  onConfirm,
  onCancel,
}: {
  target: TenantPublicKey;
  isLast: boolean;
  canRotate: boolean;
  busy: boolean;
  onConfirm: (reason: KeyRevocationReason) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState<KeyRevocationReason | null>(null);
  const options: Array<{ value: KeyRevocationReason; label: string }> = [
    ...(canRotate ? [{ value: 'rotated' as const, label: '輪替汰換（已有新金鑰接手）' }] : []),
    { value: 'compromised', label: '私鑰外洩或疑似外洩' },
    { value: 'other', label: '其他（例如上傳錯誤、停止服務）' },
  ];

  return (
    <div style={PANEL_STYLE}>
      <div className="field-label">撤銷公鑰 {keyName(target)}</div>
      {options.map((o) => (
        <label key={o.value} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
          <input
            type="radio"
            name={`revoke-reason-${target.kid}`}
            checked={reason === o.value}
            onChange={() => setReason(o.value)}
          />
          {o.label}
        </label>
      ))}
      <span className="field-hint">
        撤銷只會停止以這把金鑰簽署的人員同步，不會登出任何人，也不影響自動登入。此操作無法復原。
      </span>
      {isLast && (
        <span className="field-hint" style={{ color: '#b45309' }}>
          這是最後一把啟用中的同步公鑰，撤銷後人員同步將停止，直到你上傳新的公鑰。
        </span>
      )}
      <div className="form-actions">
        <button className="btn btn-danger" disabled={busy || !reason} onClick={() => reason && onConfirm(reason)}>
          確定撤銷
        </button>
        <button className="btn" disabled={busy} onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}
