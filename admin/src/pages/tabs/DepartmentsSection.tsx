import { useState, type FormEvent } from 'react';
import { Dialog } from '@hyagent/ui';
import { api, type DepartmentSummary } from '../../api';

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
const OA_OVERWRITE_HINT = 'OA 同步已開啟：部門名稱與成員以 OA 為準，這裡的改名或刪除可能在下次同步時被 OA 蓋回。';

/**
 * 部門管理：部門是人員目錄上的字串，同時是權限的 key，改名／刪除由後端兩邊一起處理。
 * 「未指定」部門供網站訪客使用，不列在此處。
 */
export default function DepartmentsSection({ tenantId, departments, directorySyncEnabled = false, onChanged, onError }: {
  tenantId: string;
  /** 由外層載入：人員表單的部門下拉與此處共用同一份清單（null＝載入中） */
  departments: DepartmentSummary[] | null;
  /** OA 同步開啟時，改名與刪除會被下次同步蓋回，需提示 */
  directorySyncEnabled?: boolean;
  /** 改名／刪除後通知外層重新載入部門與人員（改名會連帶改成員的部門） */
  onChanged: () => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [pendingMerge, setPendingMerge] = useState<{ from: string; to: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<DepartmentSummary | null>(null);

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
    <p className="row-sub">部門由人員的「部門」欄位產生。改名會一併更新成員與權限設定；沒有成員的部門才能刪除，刪除時會清掉綁定的權限。「未指定」供網站訪客使用，不列在此處。</p>
    {roleless.map((d) => <p key={d.name} role="status" className="badge">{d.name} 有 {d.members} 位人員，但沒有任何角色；若部門在 OA 改過名，請更新角色的適用部門。</p>)}
    {error && <p role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    {!departments ? <p role="status">載入中…</p> : !departments.length ? <p className="empty">尚無部門。新增人員時選擇「＋ 新增部門…」即可建立。</p> :
      <ul className="list">{departments.map((d) => <li className="row directory-row" key={d.name}>
        {renaming === d.name ? (
          <form className="directory-edit" aria-label={`將 ${d.name} 改名`} onSubmit={(event) => submitRename(event, d.name)} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {directorySyncEnabled && <span className="row-sub">{OA_OVERWRITE_HINT}</span>}
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
            <button type="button" className="btn btn-ghost btn-sm" aria-label={`改名 ${d.name}`} disabled={busy}
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
      {directorySyncEnabled && <p>{OA_OVERWRITE_HINT}</p>}
      {pendingDelete && (pendingDelete.directGrants > 0 || pendingDelete.roles > 0)
        ? <>會一併清掉此部門的 {grantSummary(pendingDelete)}。之後即使有人加入同名部門或透過 SSO 帶入此部門，也不會自動取得這些權限。</>
        : <>此部門沒有綁定權限，刪除後即從清單移除。</>}
    </Dialog>
  </section>;
}
