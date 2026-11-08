import { useState, type FormEvent } from 'react';
import { Dialog } from '@hyagent/ui';
import { api, type DepartmentSummary } from '../../api';
import { useUnsavedChanges } from '../../components/unsaved';

/** 部門綁定的權限摘要文字 */
function grantSummary(d: DepartmentSummary): string {
  const parts = [
    d.directGrants > 0 ? `直接授權 ${d.directGrants} 項` : '',
    d.roles > 0 ? `角色 ${d.roles} 個` : '',
  ].filter(Boolean);
  return parts.length ? parts.join('、') : '未綁定權限';
}

/** 後端以此值代表未指定部門 */
const UNSPECIFIED = '—';
/** 改名與刪除可能被外部來源蓋回的提示；兩個開關都關時沒有這個風險 */
function overwriteHint(directorySyncEnabled: boolean, ssoAutoProvision: boolean): string | null {
  if (directorySyncEnabled && ssoAutoProvision) return 'OA 同步與登入自動建立已開啟：部門名稱與成員以 OA 與登入憑證為準，這裡的改名或刪除可能在下次同步或員工下次登入時被蓋回。';
  if (directorySyncEnabled) return 'OA 同步已開啟：部門名稱與成員以 OA 為準，這裡的改名或刪除可能在下次同步時被 OA 蓋回。';
  if (ssoAutoProvision) return '登入自動建立已開啟：自動建立的成員，部門以登入憑證為準，這裡的改名或刪除可能在員工下次登入時被蓋回。';
  return null;
}

/**
 * 部門管理：部門是人員目錄上的字串，同時是權限的 key，改名／刪除由後端兩邊一起處理。
 * 「網站訪客」與「未指定部門」是系統保留的權限對象，不列在此處（在權限頁的角色「給誰」選擇）。
 */
export default function DepartmentsSection({ tenantId, departments, directorySyncEnabled = false, ssoAutoProvision = false, onChanged, onError }: {
  tenantId: string;
  /** 由外層載入：人員表單的部門下拉與此處共用同一份清單（null＝載入中） */
  departments: DepartmentSummary[] | null;
  /** OA 同步開啟時，改名與刪除會被下次同步蓋回，需提示 */
  directorySyncEnabled?: boolean;
  /** 登入自動建立開啟時，改名與刪除會被員工下次登入蓋回，需提示 */
  ssoAutoProvision?: boolean;
  /** 改名／刪除後通知外層重新載入部門與人員（改名會連帶改成員的部門） */
  onChanged: () => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const hint = overwriteHint(directorySyncEnabled, ssoAutoProvision);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [pendingMerge, setPendingMerge] = useState<{ from: string; to: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<DepartmentSummary | null>(null);
  useUnsavedChanges(`部門：將「${renaming ?? ''}」改名`, !!renaming && newName.trim() !== '' && newName.trim() !== renaming);

  async function run(action: () => Promise<unknown>, success: string, fallbackError: string): Promise<boolean> {
    setBusy(true); setError(''); setMessage('');
    try {
      await action();
      setMessage(success);
      await onChanged();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : fallbackError);
      onError(err);
      return false;
    } finally { setBusy(false); }
  }

  async function rename(from: string, to: string) {
    const ok = await run(() => api.renameDepartment(tenantId, from, to), `已將「${from}」改名為「${to}」`, '改名失敗，請稍後再試');
    if (ok) { setRenaming(null); setNewName(''); }
  }

  function submitRename(event: FormEvent, from: string) {
    event.preventDefault();
    const to = newName.trim();
    if (!to || to === from || busy) return;
    // 改成既有部門名稱＝合併，成員與權限都會併入對方，先確認
    if (departments?.some((d) => d.name === to)) setPendingMerge({ from, to });
    else void rename(from, to);
  }

  async function confirmDelete() {
    const target = pendingDelete;
    setPendingDelete(null);
    if (target) await run(() => api.deleteDepartment(tenantId, target.name), `已刪除部門「${target.name}」`, '刪除失敗，請稍後再試');
  }

  // 有人員卻沒有任何授權（直接授權、角色皆無）：多半是部門在 OA 改名後，角色的適用部門沒跟上
  const roleless = (departments ?? []).filter((d) => d.name !== UNSPECIFIED && d.members > 0 && d.directGrants === 0 && d.roles === 0);

  return <section className="settings-section" aria-label="部門管理">
    <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>部門</h3>
    <p className="row-sub">部門由人員的「部門」欄位產生。改名會一併更新成員與權限設定；沒有成員的部門才能刪除，刪除時會清掉綁定的權限。「網站訪客」與「未指定部門」是系統保留的權限對象，不列在此處，請在權限頁的角色中設定。</p>
    {directorySyncEnabled && <p className="row-sub">已開啟 OA 同步：有成員的部門請在 OA 改名。OA 改名後，舊名稱會變成「已無成員」，可在這裡把它合併到新名稱，角色就會一起搬過去。</p>}
    {roleless.map((d) => <p key={d.name} role="status" className="badge">{d.name} 有 {d.members} 位人員，但沒有任何角色；若部門在 OA 改過名，請更新角色的適用部門。</p>)}
    {error && <p role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    {!departments ? <p role="status">載入中…</p> : !departments.length ? <p className="empty">尚無部門。新增人員時選擇「＋ 新增部門…」即可建立。</p> :
      <ul className="list">{departments.map((d) => <li className="row directory-row" key={d.name}>
        {renaming === d.name ? (
          <form className="directory-edit" aria-label={`將 ${d.name} 改名`} onSubmit={(event) => submitRename(event, d.name)} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {hint && <span className="row-sub">{hint}</span>}
            <input className="input" aria-label="新部門名稱" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={200} disabled={busy} autoFocus style={{ maxWidth: 260 }} />
            <button className="btn btn-primary btn-sm" disabled={busy || !newName.trim() || newName.trim() === d.name}>儲存</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setRenaming(null); setNewName(''); }} disabled={busy}>取消</button>
          </form>
        ) : <>
          <div className="row-main">
            <strong>{d.name}</strong>
            {d.members === 0 && <span className="badge" style={{ marginLeft: 8 }}>已無成員</span>}
            <div className="row-sub">{d.members} 位成員 · {grantSummary(d)}</div>
          </div>
          <div className="toolbar" style={{ display: 'flex', gap: 8 }}>
            {/* OA 同步開啟時，有成員的部門改名會在下次同步被蓋回，角色卻已搬到新名稱 → 整個部門失去權限，所以停用。
                已無成員的舊部門仍可改名／合併：這正是 OA 改名後把角色搬到新部門名稱的做法。 */}
            <button type="button" className="btn btn-ghost btn-sm" aria-label={`改名 ${d.name}`} disabled={busy || (directorySyncEnabled && d.members > 0)}
              title={directorySyncEnabled && d.members > 0 ? '已開啟 OA 同步，請在 OA 改名；改名後再把此處已無成員的舊部門合併到新名稱' : undefined}
              onClick={() => { setRenaming(d.name); setNewName(d.name); }}>改名</button>
            <button type="button" className="btn btn-danger btn-sm" aria-label={`刪除 ${d.name}`} disabled={busy || d.members > 0}
              title={d.members > 0 ? '請先將成員移到其他部門或刪除' : undefined} onClick={() => setPendingDelete(d)}>刪除</button>
          </div>
        </>}
      </li>)}</ul>}

    <Dialog
      isOpen={!!pendingMerge}
      title={`合併到「${pendingMerge?.to ?? ''}」？`}
      confirmText="合併"
      onClose={() => setPendingMerge(null)}
      onConfirm={() => { const m = pendingMerge; setPendingMerge(null); if (m) void rename(m.from, m.to); }}
    >
      「{pendingMerge?.to}」已存在。「{pendingMerge?.from}」的成員與權限會併入「{pendingMerge?.to}」，合併後無法自動拆回。
    </Dialog>

    <Dialog
      isOpen={!!pendingDelete}
      title={`刪除部門「${pendingDelete?.name ?? ''}」？`}
      confirmText="刪除"
      confirmVariant="danger"
      onClose={() => setPendingDelete(null)}
      onConfirm={() => void confirmDelete()}
    >
      {hint && <p>{hint}</p>}
      {pendingDelete && (pendingDelete.directGrants > 0 || pendingDelete.roles > 0)
        ? <>會一併清掉此部門的 {grantSummary(pendingDelete)}。之後即使有人加入同名部門或透過 SSO 帶入此部門，也不會自動取得這些權限。</>
        : <>此部門沒有綁定權限，刪除後即從清單移除。</>}
    </Dialog>
  </section>;
}
