/**
 * 自動登入分頁：Assertion 公鑰與逐租戶設定（規格 §7.3、§7.4、§10.4、§11.1）。
 *
 * 取代改造前的「SSO 共享密鑰」輸入框。最重要的差別：**這裡只收公鑰**。
 * HyAgent 自此不持有任何可偽造客戶身分的秘密——誤貼私鑰會被後端擋下並要求換一組金鑰對。
 *
 * 不變條件（上限 2 把、輪替汰換不得撤掉最後一把）由後端強制（規格 §7.3 明文「不得僅在
 * UI 層」），這裡只負責把後端回的錯誤講清楚，不自行複製一份判斷邏輯——兩份遲早會不一致。
 *
 * 公鑰只有「啟用中 → 已撤銷」一條路，介面以「輪替」呈現：例行換金鑰走輪替面板的
 * 「完成輪替」／「放棄輪替」（撤銷原因分別記為輪替汰換、放棄輪替），列上的「撤銷」只留給
 * 外洩等例外狀況。
 * 撤銷原因只供稽核、不影響驗證；事後回頭查時，「例行退役還是外洩」是第一個要回答的問題。
 * 輪替中隱藏上傳框純屬引導，上限仍由後端把關。
 *
 * 自成分頁而不是塞在「設定」裡的理由：這裡每個動作都**立即生效**，與設定分頁那顆
 * 一次送出的「儲存設定」語意不同。混在同一張卡時，改完公鑰或時鐘容忍的人會去按
 * 底下那顆「儲存設定」，以為沒按就沒生效——而那顆按鈕根本不送這些欄位。
 */
import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type AssertionKeysView,
  type AssertionSettings,
  type KeyOperator,
  type KeyRevocationReason,
  type TenantPublicKey,
} from '../../api';
import SessionsPanel from './SessionsPanel';

const REASON_LABEL: Record<KeyRevocationReason, string> = {
  rotated: '輪替汰換',
  aborted: '放棄輪替',
  compromised: '私鑰外洩',
  other: '其他',
};

/** 規格 §2.5 輪替步驟 4 的建議觀察期。只用來提示——後台看不到客戶急著收尾的理由，不替他擋。 */
const OBSERVE_HOURS = 24;

/** 內文提到金鑰時的簡稱：kid 太長，有備註就帶備註，與 Session 列表的下拉同一種寫法。 */
function keyName(k: TenantPublicKey): string {
  const short = `${k.kid.slice(0, 8)}…`;
  return k.label ? `${k.label}（${short}）` : short;
}

function duration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes} 分鐘`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} 小時` : `${Math.floor(hours / 24)} 天`;
}

const fmt = (iso: string): string => new Date(iso).toLocaleString();

const VIA_LABEL: Record<KeyOperator['via'], string> = {
  admin: '後台登入',
  'admin-api-key': '管理 API 金鑰',
};

/**
 * 稽核欄位：時間在上、操作者在下。後台沒有個人帳號，操作者只有管道與來源 IP（規格 §7.3）。
 * IPv4 經 IPv6 socket 進來會帶 `::ffff:` 前綴，顯示時去掉，免得看起來像另一個位址。
 */
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

export default function SsoTab({
  tenantId,
  onError,
}: {
  tenantId: string;
  onError: (e: unknown) => void;
}) {
  const [view, setView] = useState<AssertionKeysView | null>(null);
  const [pem, setPem] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  /** 正在選撤銷原因的那把；null＝撤銷面板收起 */
  const [revoking, setRevoking] = useState<TenantPublicKey | null>(null);

  const load = useCallback(() => {
    void api.listAssertionKeys(tenantId).then(setView).catch(onError);
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

  const add = () =>
    run(async () => {
      const result = await api.addAssertionKey(tenantId, {
        publicKey: pem.trim(),
        ...(label.trim() ? { label: label.trim() } : {}),
      });
      // 冪等回既有那筆時不改狀態（§7.3），後端回的是 200。但對操作者而言這次上傳就是沒成功——
      // 什麼都沒新增——所以丟成錯誤，與其他錯誤一樣以 toast 呈現，而不是混在頂端那行操作結果裡
      // 被當成成功。輸入框也保留，不替他清掉
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

  /** 輪替收尾與手動撤銷共用；後端撤銷時會一併作廢以該 kid 建立的 Session。 */
  const revoke = (key: TenantPublicKey, reason: KeyRevocationReason, done: string) =>
    run(async () => {
      const r = await api.revokeAssertionKey(tenantId, key.kid, reason);
      setRevoking(null);
      return r.revokedSessions ? `${done}，並登出以它建立的 ${r.revokedSessions} 個 Session` : done;
    });

  const saveSettings = (patch: Partial<AssertionSettings>) =>
    run(async () => {
      await api.updateAssertionSettings(tenantId, patch);
      return '已更新設定';
    });

  if (!view) return <p className="field-hint">載入中…</p>;

  const active = view.keys
    .filter((k) => k.status === 'active')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  // 輪替只有一種形狀：舊的那把先在、新的後上傳。撤銷不可逆，新上傳的那把必然較晚建立
  const rotation = active.length >= 2 ? { from: active[0], to: active[active.length - 1] } : null;
  const revoked = view.keys
    .filter((k) => k.status === 'revoked')
    .sort((a, b) => (b.revokedAt ?? b.createdAt).localeCompare(a.revokedAt ?? a.createdAt));
  const revokingTarget = revoking && active.find((k) => k.kid === revoking.kid);

  return (
    <div className="settings-stack">
      {/* 公鑰與時間設定兩張卡共用的操作結果。固定在頂端，訊息跟著按鈕跑會看不到；
          Session 列表的操作量大、回饋要貼著表格，所以它自己管一份 */}
      {notice && (
        <p className="field-hint" role="status">
          {notice}
        </p>
      )}

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">Assertion 簽章公鑰</div>
            <div className="card-desc">
              客戶以自家私鑰簽發身分憑證，這裡只登記對應的<strong>公鑰</strong>。平常只有 1 把；
              換金鑰時先上傳新的讓新舊並存，確認客戶端已改用新金鑰後再完成輪替。kid 由系統依
              RFC 7638 自公鑰算出，不需填寫。
            </div>
          </div>
        </div>
        <div className="card-body">
          {active.length === 0 ? (
            <p className="field-hint" style={{ color: '#b45309' }}>
              {view.keys.length === 0 ? '尚未登記任何公鑰' : '尚無啟用中的公鑰'} —— 此租戶目前無法以 SSO 登入。
            </p>
          ) : (
            <table style={{ width: '100%', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left' }}>
                  <th>kid</th>
                  <th>演算法</th>
                  <th>用途</th>
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
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {!rotation ? (
                        <span className="badge badge-on">使用中</span>
                      ) : k.kid === rotation.to.kid ? (
                        <span className="badge badge-on">新金鑰</span>
                      ) : (
                        <span className="badge badge-warn">舊金鑰・待汰換</span>
                      )}
                    </td>
                    <td>{k.label ?? '—'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <Stamp at={k.createdAt} by={k.createdBy} />
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn btn-danger" disabled={busy} onClick={() => setRevoking(k)}>
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
              busy={busy}
              onConfirm={(reason) =>
                void revoke(revokingTarget, reason, `已撤銷 ${keyName(revokingTarget)}（${REASON_LABEL[reason]}）`)
              }
              onCancel={() => setRevoking(null)}
            />
          )}

          {rotation ? (
            <>
              <RotationPanel
                tenantId={tenantId}
                from={rotation.from}
                to={rotation.to}
                sessionExpiresIn={view.settings.sessionExpiresIn}
                busy={busy}
                onRevoke={(key, reason, done) => void revoke(key, reason, done)}
                onError={onError}
              />
              <p className="field-hint">
                輪替進行中，須先完成或放棄這次輪替才能再上傳新公鑰。若輪替期間私鑰外洩，
                直接撤銷外洩的那一把即可釋出名額。
              </p>
            </>
          ) : (
            <div className="field">
              <label className="field-label">{active.length ? '輪替金鑰：上傳新公鑰' : '上傳公鑰'}</label>
              <span className="field-hint">
                {active.length > 0 &&
                  `上傳後新舊兩把並存，請客戶改以新私鑰簽發；觀察 ≥ ${OBSERVE_HOURS} 小時無錯誤後，回來按「完成輪替」汰換舊金鑰。`}
                貼上 SPKI PEM（<code>-----BEGIN PUBLIC KEY-----</code>）或 JWK。請客戶只提供公鑰，
                私鑰絕不可離開他們的環境。
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
                  {active.length ? '上傳並開始輪替' : '新增公鑰'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {revoked.length > 0 && <RevokedKeysCard keys={revoked} />}

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">時間與 Session 設定</div>
            <div className="card-desc">
              時鐘容忍 0–30 秒，且不得超過 Assertion 有效期的 ¼；Session 有效期 300–28800 秒。
              每個欄位各自儲存，按下即生效。
            </div>
          </div>
        </div>
        <div className="card-body">
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <NumberField
              label="時鐘容忍（秒）"
              value={view.settings.clockSkewSeconds}
              defaultValue={15}
              disabled={busy}
              onSave={(v) => void saveSettings({ clockSkewSeconds: v })}
            />
            <NumberField
              label="Assertion 有效期（秒）"
              value={view.settings.assertionLifetimeSeconds}
              defaultValue={60}
              disabled={busy}
              onSave={(v) => void saveSettings({ assertionLifetimeSeconds: v })}
            />
            <NumberField
              label="Session 有效期（秒）"
              value={view.settings.sessionExpiresIn}
              defaultValue={3600}
              disabled={busy}
              onSave={(v) => void saveSettings({ sessionExpiresIn: v })}
            />
          </div>

          {view.clockOffset && (
            <p className="field-hint">
              近期時鐘偏移：{view.clockOffset.count} 次觀測，中位數 {view.clockOffset.median} 秒，
              範圍 {view.clockOffset.min} ～ {view.clockOffset.max} 秒
              {view.clockOffset.warnCount > 0 &&
                `，其中 ${view.clockOffset.warnCount} 次超過容忍值一半（請雙方檢查 NTP）`}
            </p>
          )}
        </div>
      </div>

      <SessionsPanel tenantId={tenantId} keys={view.keys} onError={onError} />
    </div>
  );
}

interface KeyUsage {
  /** 以這把 kid 建立、仍有效的 Session 數 */
  total: number;
  /** 其中最近一筆的建立時間 */
  latest?: string;
}

/**
 * 已撤銷的公鑰（規格 §7.3 的稽核留存）。
 *
 * 獨立成卡、預設收合：這些金鑰已無任何作用，日常管理用不到，只有回頭查「哪把、為何、
 * 何時、從哪裡撤的」時才需要。攤開放在啟用中的金鑰旁邊，輪替幾次後就把真正要操作的那
 * 一兩把淹沒了。收合時標題仍帶筆數，讓人知道有紀錄可查。
 */
function RevokedKeysCard({ keys }: { keys: TenantPublicKey[] }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">已撤銷的公鑰（{keys.length}）</div>
          <div className="card-desc">撤銷不可復原。紀錄留存供稽核：撤銷原因、時間與操作者。</div>
        </div>
        <button className="btn btn-ghost btn-sm" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? '收合' : '展開'}
        </button>
      </div>
      {open && (
        <div className="card-body">
          <table style={{ width: '100%', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left' }}>
                <th>kid</th>
                <th>演算法</th>
                <th>撤銷原因</th>
                <th>備註</th>
                <th>建立</th>
                <th>撤銷</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.kid}>
                  <td style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{k.kid}</td>
                  <td>{k.alg}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <span className={`badge ${k.revokedReason === 'compromised' ? 'badge-warn' : 'badge-off'}`}>
                      {k.revokedReason ? REASON_LABEL[k.revokedReason] : '未記錄'}
                    </span>
                  </td>
                  <td>{k.label ?? '—'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <Stamp at={k.createdAt} by={k.createdBy} />
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <Stamp at={k.revokedAt} by={k.revokedBy} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const PANEL_STYLE = {
  border: '1px solid var(--border-color)',
  borderRadius: 11,
  padding: '12px 16px',
  display: 'grid',
  gap: 6,
} as const;

/**
 * 手動撤銷（規格 §2.6）：先選原因再按確定，這一步本身就是規格要求的二次確認。
 *
 * 不提供「輪替汰換」「放棄輪替」——這兩個走輪替面板，那裡會先讓管理員看過新舊金鑰
 * 各有沒有人在用。從這裡撤的只會是外洩或其他例外狀況，所以原因不給預設值：
 * 預設成任何一個，稽核紀錄裡就會混進沒人真的選過的答案。
 *
 * 文案必須明說「會一併登出正常使用者」——撤銷的動機通常是私鑰外洩，
 * 按下去的人多半沒想到它同時會把當下在線的所有人踢出去。
 */
function RevokePanel({
  target,
  isLast,
  busy,
  onConfirm,
  onCancel,
}: {
  target: TenantPublicKey;
  isLast: boolean;
  busy: boolean;
  onConfirm: (reason: KeyRevocationReason) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState<KeyRevocationReason | null>(null);
  const options: Array<{ value: KeyRevocationReason; label: string }> = [
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
        撤銷後，以這把金鑰建立的所有 Session 會立刻失效，包含目前正常使用中的使用者。此操作無法復原。
      </span>
      {isLast && (
        <span className="field-hint" style={{ color: '#b45309' }}>
          這是最後一把啟用中的公鑰，撤銷後該租戶將無法登入，直到你上傳新的公鑰。
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

/**
 * 輪替進行中的收尾面板（規格 §2.5 步驟 4–5）。
 *
 * 「完成輪替」本質上就是以「輪替汰換」撤銷舊金鑰，但按下去前管理員最想知道的是「客戶端真的換過去了沒」。
 * 有效 Session 正好回答這件事：Session 最長只活 sessionExpiresIn 秒，舊 kid 底下一筆都
 * 沒有，就代表這段時間內沒人再拿舊私鑰簽的憑證登入；新 kid 底下有，才證明客戶端已切過去。
 * 兩把都沒有時只能說「看不出來」——低流量的租戶很常見，不能當成可以收尾。
 */
function RotationPanel({
  tenantId,
  from,
  to,
  sessionExpiresIn,
  busy,
  onRevoke,
  onError,
}: {
  tenantId: string;
  from: TenantPublicKey;
  to: TenantPublicKey;
  sessionExpiresIn: number;
  busy: boolean;
  onRevoke: (key: TenantPublicKey, reason: KeyRevocationReason, done: string) => void;
  onError: (e: unknown) => void;
}) {
  const [usage, setUsage] = useState<{ from: KeyUsage; to: KeyUsage } | null>(null);

  useEffect(() => {
    const usageOf = (kid: string): Promise<KeyUsage> =>
      api
        .listSessions(tenantId, { kid, limit: 1 })
        .then((p) => ({ total: p.total, latest: p.sessions[0]?.createdAt }));
    setUsage(null);
    void Promise.all([usageOf(from.kid), usageOf(to.kid)])
      .then(([f, t]) => setUsage({ from: f, to: t }))
      .catch(onError);
  }, [tenantId, from.kid, to.kid, onError]);

  const elapsedMs = Date.now() - Date.parse(to.createdAt);
  const observed = elapsedMs >= OBSERVE_HOURS * 3_600_000;
  const lookback = duration(sessionExpiresIn * 1000);
  // 新金鑰上傳後還有人用舊金鑰登入＝客戶端至少還有一台主機沒切過去
  const oldStillUsed =
    !!usage?.from.latest && Date.parse(usage.from.latest) > Date.parse(to.createdAt);

  const complete = (): void => {
    let extra = '';
    if (!observed) {
      extra += `\n\n距上傳新金鑰僅 ${duration(elapsedMs)}，未滿建議的 ${OBSERVE_HOURS} 小時觀察期。`;
    }
    if (usage && usage.from.total > 0) {
      extra += `\n\n目前仍有 ${usage.from.total} 個以舊金鑰登入的 Session，會一併被登出。`;
    }
    if (
      window.confirm(
        `完成輪替：汰換舊金鑰 ${keyName(from)}？\n\n舊金鑰會以「輪替汰換」撤銷，之後以舊私鑰簽發的` +
          `憑證一律被拒，此操作無法復原。請提醒客戶銷毀舊私鑰。${extra}`,
      )
    ) {
      onRevoke(from, 'rotated', `輪替完成：已汰換舊金鑰 ${keyName(from)}`);
    }
  };

  const abort = (): void => {
    if (
      window.confirm(
        `放棄這次輪替：撤銷新金鑰 ${keyName(to)}？\n\n舊金鑰維持使用；客戶端若已改用新私鑰簽發，` +
          '會立刻無法登入，以新金鑰登入的 Session 也會一併被登出。\n\n' +
          '撤銷無法復原，之後要重新輪替請產生一組新的金鑰對。',
      )
    ) {
      onRevoke(to, 'aborted', `已放棄輪替：撤銷新金鑰 ${keyName(to)}`);
    }
  };

  let verdict: string;
  if (!usage) verdict = '查詢兩把金鑰的使用狀況中…';
  else if (usage.from.latest)
    verdict =
      `舊金鑰仍有 ${usage.from.total} 個有效 Session（最近一次登入於 ${fmt(usage.from.latest)}）；` +
      `新金鑰 ${usage.to.total} 個。`;
  else if (usage.to.total > 0)
    verdict = `最近 ${lookback} 內只有新金鑰的登入（${usage.to.total} 個有效 Session），客戶端已改用新金鑰。`;
  else verdict = `最近 ${lookback} 內兩把金鑰都沒有登入紀錄，還看不出客戶端是否已切換。`;

  return (
    <div style={PANEL_STYLE}>
      <div className="field-label">輪替進行中</div>
      <span className="field-hint">
        新金鑰 {keyName(to)} 於 {fmt(to.createdAt)} 上傳，已過 {duration(elapsedMs)}
        {observed ? '。' : `（建議觀察 ≥ ${OBSERVE_HOURS} 小時）。`}
      </span>
      <span className="field-hint">{verdict}</span>
      {oldStillUsed && (
        <span className="field-hint" style={{ color: '#b45309' }}>
          上傳新金鑰之後仍有人以舊金鑰登入——客戶端可能還有主機沒切換到新私鑰，此時完成輪替會讓這些登入失敗。
        </span>
      )}
      <div className="form-actions">
        <button className="btn btn-primary" disabled={busy} onClick={complete}>
          完成輪替
        </button>
        <button className="btn" disabled={busy} onClick={abort}>
          放棄輪替
        </button>
      </div>
    </div>
  );
}

/** 數值設定：顯示現行值並標示是否偏離規格預設（規格 §11.1 的收斂呈現要求）。 */
function NumberField({
  label,
  value,
  defaultValue,
  disabled,
  onSave,
}: {
  label: string;
  value: number;
  defaultValue: number;
  disabled: boolean;
  onSave: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const changed = Number(draft) !== value;
  return (
    <div style={{ display: 'grid', gap: 2 }}>
      <span className="field-hint">
        {label}
        {value !== defaultValue && `（預設 ${defaultValue}）`}
      </span>
      <div style={{ display: 'flex', gap: 4 }}>
        <input
          className="input"
          type="number"
          style={{ width: 110 }}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button className="btn" disabled={disabled || !changed} onClick={() => onSave(Number(draft))}>
          儲存
        </button>
      </div>
    </div>
  );
}
