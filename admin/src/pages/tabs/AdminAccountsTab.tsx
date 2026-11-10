import { useCallback, useEffect, useState } from 'react';
import { Dialog, useToast } from '@hyagent/ui';
import { ADMIN_TAB_KEYS, tabLevel, type AdminTabKey, type AdminTabLevel, type AdminTabPermissions } from '@hyagent/shared';
import { api, type AdminAccount } from '../../api';
import { IconPlus } from '../../components/icons';
import { useConfirm } from '../../components/confirm';
import { useUnsavedChanges } from '../../components/unsaved';
import { TAB_LABELS } from '../tabGroups';

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const LEVELS: { value: AdminTabLevel; label: string }[] = [
  { value: 'hidden', label: '隱藏' },
  { value: 'read', label: '唯讀' },
  { value: 'write', label: '可編輯' },
];
const PASSWORD_ERR = '密碼長度需為 10 到 128 個字元';

/** 把可能缺漏的權限補成 14 列完整內容 */
function fullPermissions(p: AdminTabPermissions): Record<AdminTabKey, AdminTabLevel> {
  return Object.fromEntries(ADMIN_TAB_KEYS.map((k) => [k, tabLevel(p, k)])) as Record<AdminTabKey, AdminTabLevel>;
}
const fmtTime = (iso?: string) => (iso ? new Date(iso).toLocaleString() : '從未登入');
const pwOk = (pw: string) => pw.length >= 10 && pw.length <= 128;

export default function AdminAccountsTab({ tenantId, onError }: { tenantId: string; onError: (e: unknown) => void }) {
  const confirm = useConfirm();
  const toast = useToast();
  const [list, setList] = useState<AdminAccount[]>([]);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [formErr, setFormErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<AdminAccount | null>(null);
  const [draft, setDraft] = useState<Record<AdminTabKey, AdminTabLevel> | null>(null);
  const [resetting, setResetting] = useState<AdminAccount | null>(null);
  const [newPw, setNewPw] = useState('');
  const [pwErr, setPwErr] = useState('');

  const permsDirty = !!editing && !!draft && JSON.stringify(draft) !== JSON.stringify(fullPermissions(editing.permissions));
  useUnsavedChanges('後台管理者：新增帳號', username.trim() !== '' || displayName.trim() !== '' || password !== '');
  useUnsavedChanges('後台管理者：權限設定', permsDirty);

  const load = useCallback(async () => {
    try {
      setList(await api.listAdminAccounts(tenantId));
    } catch (e) {
      onError(e);
    }
  }, [tenantId, onError]);
  useEffect(() => { void load(); }, [load]);

  async function create() {
    if (busy) return;
    const u = username.trim();
    const d = displayName.trim();
    if (!USERNAME_RE.test(u)) return setFormErr('帳號格式不符：3 到 32 個字元，只能用小寫英數、點、底線、連字號，且開頭須為英數');
    if (u === 'admin') return setFormErr('admin 為保留帳號');
    if (!d || d.length > 100) return setFormErr('請輸入顯示名稱（100 字以內）');
    if (!pwOk(password)) return setFormErr(PASSWORD_ERR);
    setFormErr('');
    setBusy(true);
    try {
      await api.createAdminAccount(tenantId, { username: u, displayName: d, password });
      setUsername(''); setDisplayName(''); setPassword('');
      toast.success('已新增帳號，預設所有分頁為隱藏，請接著設定權限');
      await load();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  async function toggleStatus(a: AdminAccount) {
    const next = a.status === 'active' ? 'disabled' : 'active';
    try {
      await api.updateAdminAccount(tenantId, a.id, { status: next });
      await load();
    } catch (e) {
      onError(e);
    }
  }

  async function remove(a: AdminAccount) {
    if (!(await confirm({ title: `刪除管理者「${a.username}」？`, message: '刪除後該帳號立即無法登入，且無法復原。若只是暫時不要，可改用「停用」。' }))) return;
    try {
      await api.deleteAdminAccount(tenantId, a.id);
      if (editing?.id === a.id) closeEditor();
      await load();
    } catch (e) {
      onError(e);
    }
  }

  function openEditor(a: AdminAccount) {
    setEditing(a);
    setDraft(fullPermissions(a.permissions));
  }
  function closeEditor() { setEditing(null); setDraft(null); }
  const setAll = (level: AdminTabLevel) => setDraft(Object.fromEntries(ADMIN_TAB_KEYS.map((k) => [k, level])) as Record<AdminTabKey, AdminTabLevel>);

  async function savePermissions() {
    if (!editing || !draft || busy) return;
    setBusy(true);
    try {
      await api.updateAdminAccount(tenantId, editing.id, { permissions: draft });
      toast.success('已儲存權限，立即生效');
      closeEditor();
      await load();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  async function submitReset() {
    if (!resetting || busy) return;
    if (!pwOk(newPw)) return setPwErr(PASSWORD_ERR);
    setBusy(true);
    try {
      await api.resetAdminAccountPassword(tenantId, resetting.id, newPw);
      toast.success('密碼已重設，該帳號已登入的裝置會被登出');
      setResetting(null); setNewPw(''); setPwErr('');
    } catch (e) {
      setPwErr(e instanceof Error ? e.message : '重設失敗');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">後台管理者</div>
          <div className="card-desc">建立只能管理此租戶的後台帳號，並逐一指定每個分頁是隱藏、唯讀或可編輯。權限調整立即生效。</div>
        </div>
      </div>

      <div className="card-body" style={{ borderBottom: '1px solid var(--border-color)' }}>
        <div className="toolbar">
          <label className="field">
            <span className="field-label">帳號</span>
            <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" placeholder="例如 alice01" />
          </label>
          <label className="field">
            <span className="field-label">顯示名稱</span>
            <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoComplete="off" />
          </label>
          <label className="field">
            <span className="field-label">初始密碼</span>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" placeholder="10 到 128 個字元" />
          </label>
          <button className="btn btn-primary" onClick={() => void create()} disabled={busy}>
            <IconPlus />
            新增帳號
          </button>
        </div>
        {formErr && <p className="login-err" role="alert">{formErr}</p>}
      </div>

      <ul className="list">
        {list.map((a) => (
          <li key={a.id} className="row">
            <div className="row-main">
              <div className="row-title">
                <span className={`badge ${a.status === 'active' ? 'badge-on' : 'badge-off'}`}>{a.status === 'active' ? '啟用中' : '已停用'}</span>
                <span className="mono" style={{ fontWeight: 500 }}>{a.username}</span>
                <span>{a.displayName}</span>
              </div>
              <div className="row-sub">最後登入：{fmtTime(a.lastLoginAt)}</div>
            </div>
            <div className="row-actions">
              <button className="btn btn-ghost btn-sm" onClick={() => openEditor(a)}>編輯權限</button>
              <button className="btn btn-ghost btn-sm" onClick={() => void toggleStatus(a)}>{a.status === 'active' ? '停用' : '啟用'}</button>
              <button className="btn btn-ghost btn-sm" onClick={() => { setResetting(a); setNewPw(''); setPwErr(''); }}>重設密碼</button>
              <button className="btn btn-danger btn-sm" onClick={() => void remove(a)}>刪除</button>
            </div>
          </li>
        ))}
        {list.length === 0 && <li className="empty">尚無後台管理者。</li>}
      </ul>

      {editing && draft && (
        <div className="card-body" style={{ borderTop: '1px solid var(--border-color)' }}>
          <div className="card-title">編輯權限：{editing.username}（{editing.displayName}）</div>
          <div className="toolbar" style={{ margin: '8px 0' }}>
            <button className="btn btn-ghost btn-sm" onClick={() => setAll('hidden')}>全部隱藏</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setAll('read')}>全部唯讀</button>
          </div>
          {ADMIN_TAB_KEYS.map((k) => (
            <div key={k} role="group" aria-label={TAB_LABELS[k]} className="row" style={{ alignItems: 'center' }}>
              <div className="row-main">{TAB_LABELS[k]}</div>
              <div className="row-actions">
                {LEVELS.map((l) => (
                  <label key={l.value} style={{ marginRight: 12 }}>
                    <input type="radio" name={`perm-${k}`} checked={draft[k] === l.value} onChange={() => setDraft({ ...draft, [k]: l.value })} /> {l.label}
                  </label>
                ))}
              </div>
            </div>
          ))}
          <div className="toolbar" style={{ marginTop: 12 }}>
            <button className="btn btn-primary" onClick={() => void savePermissions()} disabled={busy}>儲存權限</button>
            <button className="btn btn-ghost" onClick={closeEditor}>取消</button>
          </div>
        </div>
      )}

      {resetting && (
        <Dialog
          isOpen
          title={`重設密碼：${resetting.username}`}
          confirmText={busy ? '儲存中…' : '儲存'}
          confirmDisabled={busy}
          onClose={() => { setResetting(null); setNewPw(''); setPwErr(''); }}
          onConfirm={() => void submitReset()}
        >
          <label className="field">
            <span className="field-label">新密碼</span>
            <input className="input" type="password" autoComplete="new-password" value={newPw} onChange={(e) => setNewPw(e.target.value)} autoFocus placeholder="10 到 128 個字元" />
          </label>
          <p className="field-hint">儲存後，該帳號已登入的裝置會被登出。</p>
          {pwErr && <p className="login-err">{pwErr}</p>}
        </Dialog>
      )}
    </div>
  );
}
