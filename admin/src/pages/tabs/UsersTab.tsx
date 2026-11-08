import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { Dialog } from '@hyagent/ui';
import { api, type DepartmentSummary, type DirectoryUser } from '../../api';
import DepartmentsSection from './DepartmentsSection';
import CollapsibleList from '../../components/CollapsibleList';

/** 部門下拉的「新增部門」選項值；不會與真實部門名稱衝突 */
const NEW_DEPARTMENT = '__new__';
/** 後端以此值代表未指定部門 */
const UNSPECIFIED = '—';

/** 部門選擇的狀態：選既有部門，或選「新增部門」後自行輸入 */
interface DeptState { choice: string; typed: string }

const deptStateOf = (department: string): DeptState => ({ choice: department === UNSPECIFIED ? '' : department, typed: '' });
const deptValueOf = ({ choice, typed }: DeptState): string => (choice === NEW_DEPARTMENT ? typed.trim() : choice);
const deptIncomplete = (state: DeptState): boolean => state.choice === NEW_DEPARTMENT && !state.typed.trim();

/**
 * 部門會被權限比對，改用下拉選既有部門，避免手打錯字默默產生新部門、權限對不上。
 * 新增與編輯共用。
 */
function DepartmentField({ departments, value, onChange, disabled }: {
  departments: string[];
  value: DeptState;
  onChange: (next: DeptState) => void;
  disabled: boolean;
}) {
  const newDeptId = useId();
  const deptId = useId();
  const typed = value.typed.trim();
  const typedExisting = value.choice === NEW_DEPARTMENT && departments.includes(typed);
  return <>
    <div className="field"><label className="field-label" htmlFor={deptId}>部門（選填）</label>
      <select id={deptId} className="select" value={value.choice} onChange={(e) => onChange({ ...value, choice: e.target.value })} disabled={disabled}>
        <option value="">未指定部門</option>
        {departments.map((dep) => <option key={dep} value={dep}>{dep}</option>)}
        <option value={NEW_DEPARTMENT}>＋ 新增部門…</option>
      </select>
      {/* 與下拉放在同一個欄位容器：表單是兩欄格線，獨立成元素會另佔一格、跑到隔壁欄 */}
      {value.choice === '' && <span className="field-hint">未指定部門的帳號只取得套用給「未指定部門」與所有登入員工的角色，不會取得任何一般部門的角色。</span>}
    </div>
    {value.choice === NEW_DEPARTMENT && <div className="field"><label className="field-label" htmlFor={newDeptId}>新部門名稱</label>
      <input id={newDeptId} className="input" value={value.typed} onChange={(e) => onChange({ ...value, typed: e.target.value })} required maxLength={200} disabled={disabled} autoFocus />
      {typedExisting && <span className="field-hint">已有此部門，將直接加入。</span>}
      {!typedExisting && typed && <span className="field-hint">將建立新部門；權限需另外授權給此部門。</span>}
    </div>}
  </>;
}

/** 來自 SSO／OA 同步，或曾被 OA 同步寫入 */
const isOaManaged = (user: DirectoryUser): boolean => user.origin === 'sso' || user.origin === 'sync' || !!user.syncedAt;
/** 與伺服端 isPasswordLoginUser 同規則：只看 origin，被 webhook 接手的手動帳號仍可帳密登入 */
const canPasswordLogin = (user: DirectoryUser): boolean => !user.origin || user.origin === 'manual';
interface Switches { ssoAutoProvision: boolean; directorySyncEnabled: boolean }
/**
 * 與伺服端 isFieldLocked 同規則，鎖定跟著負責的開關走。
 * 開關未知（讀取中或失敗）時 OA 管理的帳號維持鎖定：多擋一個按鈕，好過按了才收到 409。
 */
const isLocked = (user: DirectoryUser, switches: Switches | null): boolean => {
  if (!isOaManaged(user)) return false;
  if (!switches) return true;
  return user.syncedAt || user.origin === 'sync' ? switches.directorySyncEnabled : switches.ssoAutoProvision;
};
const originLabel = (user: DirectoryUser): string =>
  user.syncedAt || user.origin === 'sync' ? 'OA 同步' : user.origin === 'sso' ? '自動登入' : '手動';

interface Draft { name: string; dept: DeptState; email: string }

/** 目錄每頁筆數：OA 同步後可能上千人，整份平鋪會無法使用 */
const PAGE_SIZE = 20;

export default function UsersTab({ tenantId, onError }: { tenantId: string; onError: (error: unknown) => void }) {
  const [users, setUsers] = useState<DirectoryUser[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [dept, setDept] = useState<DeptState>({ choice: '', typed: '' });
  const [email, setEmail] = useState('');
  // 編輯中的帳號（同時只編輯一位）與草稿
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pendingDelete, setPendingDelete] = useState<DirectoryUser | null>(null);
  // 部門清單（含已無成員但仍綁權限的部門）：人員表單的下拉與部門區塊共用
  const [deptSummaries, setDeptSummaries] = useState<DepartmentSummary[] | null>(null);
  const load = useCallback(async () => {
    setLoaded(false);
    setError('');
    try { setUsers((await api.listDirectoryUsers(tenantId)).users); setLoaded(true); }
    catch (err) { setError('目錄載入失敗，請重新整理'); onError(err); }
  }, [tenantId, onError]);
  const loadDepartments = useCallback(async () => {
    try { setDeptSummaries((await api.listDepartments(tenantId)).departments); }
    catch (err) { onError(err); }
  }, [tenantId, onError]);
  // 兩個開關：決定編輯按鈕與部門提示。null＝讀取中或失敗，不影響目錄本身（見 isLocked）
  const [switches, setSwitches] = useState<Switches | null>(null);
  const loadSwitches = useCallback(async () => {
    try {
      const view = await api.getDirectorySync(tenantId);
      setSwitches({ ssoAutoProvision: !!view.ssoAutoProvision, directorySyncEnabled: !!view.directorySyncEnabled });
    } catch { setSwitches(null); }
  }, [tenantId]);
  useEffect(() => { void load(); void loadDepartments(); void loadSwitches(); }, [load, loadDepartments, loadSwitches]);
  // 部門改名後成員的部門跟著變：背景更新名單，不切回「載入中」（否則部門區塊的結果訊息會消失）
  const refreshAfterDepartmentChange = useCallback(async () => {
    try {
      const [dir] = await Promise.all([api.listDirectoryUsers(tenantId), loadDepartments()]);
      setUsers(dir.users);
    } catch (err) { onError(err); }
  }, [tenantId, onError, loadDepartments]);
  // 清單的搜尋／篩選／分頁
  const [query, setQuery] = useState('');
  const [deptFilter, setDeptFilter] = useState('all');
  const [originFilter, setOriginFilter] = useState('all');
  const [page, setPage] = useState(1);
  const q = query.trim().toLocaleLowerCase();
  const filteredUsers = users.filter((user) =>
    (!q || `${user.name} ${user.id} ${user.email ?? ''}`.toLocaleLowerCase().includes(q))
    && (deptFilter === 'all' || (deptFilter === UNSPECIFIED ? (!user.department || user.department === UNSPECIFIED) : user.department === deptFilter))
    && (originFilter === 'all' || originLabel(user) === originFilter));
  const pageCount = Math.max(1, Math.ceil(filteredUsers.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const visibleUsers = filteredUsers.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const noDept = users.filter((user) => !user.department || user.department === UNSPECIFIED);
  const departments = [...new Set([...users.map((user) => user.department), ...(deptSummaries ?? []).map((d) => d.name)]
    .filter((dep) => dep && dep !== UNSPECIFIED))]
    .sort((a, b) => a.localeCompare(b, 'zh-Hant'));

  /** 共用的寫入流程：鎖住按鈕、清訊息、成功時以伺服器回傳的目錄為準 */
  async function run(action: () => Promise<{ users: DirectoryUser[] }>, success: string, fallbackError: string): Promise<boolean> {
    setBusy(true); setError(''); setMessage('');
    try {
      setUsers((await action()).users);
      void loadDepartments();
      setMessage(success);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : fallbackError);
      onError(err);
      return false;
    } finally { setBusy(false); }
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    if (busy || !loaded) return;
    const newId = id.trim();
    const ok = await run(() => api.addDirectoryUser(tenantId, {
      id: newId, name: name.trim(), department: deptValueOf(dept) || UNSPECIFIED,
      ...(email.trim() ? { email: email.trim() } : {}),
    }), `已新增帳號 ${newId}`, '新增失敗，請稍後再試');
    if (ok) { setId(''); setName(''); setDept({ choice: '', typed: '' }); setEmail(''); }
  }

  function startEdit(user: DirectoryUser) {
    setEditingId(user.id);
    setDraft({ name: user.name, dept: deptStateOf(user.department), email: user.email ?? '' });
  }
  function cancelEdit() { setEditingId(null); setDraft(null); }

  async function saveEdit(event: FormEvent, user: DirectoryUser) {
    event.preventDefault();
    if (!draft || busy) return;
    const ok = await run(() => api.updateDirectoryUser(tenantId, user.id, {
      name: draft.name.trim(),
      department: deptValueOf(draft.dept) || UNSPECIFIED,
      email: draft.email.trim() || null,
    }), `已更新帳號 ${user.id}`, '更新失敗，請稍後再試');
    if (ok) cancelEdit();
  }

  async function confirmDelete() {
    const target = pendingDelete;
    setPendingDelete(null);
    if (!target) return;
    const ok = await run(() => api.deleteDirectoryUser(tenantId, target.id), `已刪除帳號 ${target.id}`, '刪除失敗，請稍後再試');
    if (ok && editingId === target.id) cancelEdit();
  }

  return <div className="card">
    <div className="card-head"><div><div className="card-title">使用者目錄</div>
      <div className="card-desc">管理此租戶的人員帳號。已開放帳密登入時，請使用此處的帳號及服務設定的登入密碼。</div>
    </div><button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void load()}>重新整理</button></div>
    <div className="card-body">
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      {!loaded && !error && <p role="status">載入中…</p>}
      {loaded && <>
        <p className="row-sub">共 {users.length} 位使用者。部門會決定取得哪些角色；未指定部門時只取得「未指定部門」與所有登入員工的角色。新增不會覆蓋其他人員。</p>
        {noDept.length > 0 && (
          <div className="perm-warn" role="status">
            {noDept.length} 位未指定部門，不會取得任何一般部門的角色：
            <CollapsibleList items={noDept} render={(user) => `${user.name}（${user.id}）`} />
          </div>
        )}
        {users.length > 0 && (
          <div className="directory-toolbar">
            <input className="input" aria-label="搜尋使用者" placeholder="搜尋姓名、帳號或 Email…" value={query}
              onChange={(e) => { setQuery(e.target.value); setPage(1); }} />
            <select className="select" aria-label="依部門篩選" value={deptFilter} onChange={(e) => { setDeptFilter(e.target.value); setPage(1); }}>
              <option value="all">全部部門</option>
              <option value={UNSPECIFIED}>未指定部門</option>
              {departments.map((dep) => <option key={dep} value={dep}>{dep}</option>)}
            </select>
            <select className="select" aria-label="依來源篩選" value={originFilter} onChange={(e) => { setOriginFilter(e.target.value); setPage(1); }}>
              <option value="all">全部來源</option>
              <option value="手動">手動</option>
              <option value="自動登入">自動登入</option>
              <option value="OA 同步">OA 同步</option>
            </select>
          </div>
        )}
        {!users.length ? <p className="empty">尚無使用者，請先新增登入帳號。</p> : !filteredUsers.length ? <p className="empty">找不到符合條件的使用者，請調整搜尋或篩選。</p> :
          <ul className="list">{visibleUsers.map((user) => <li className="row directory-row" key={user.id}>
            {editingId === user.id && draft ? (
              <form className="directory-form directory-edit" aria-label={`編輯 ${user.name}`} onSubmit={(event) => void saveEdit(event, user)}>
                <div className="row-sub">帳號：{user.id}（帳號建立後不可修改）</div>
                <div className="form-grid">
                  <label className="field"><span className="field-label">顯示名稱</span><input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} required maxLength={200} disabled={busy} /></label>
                  <DepartmentField departments={departments} value={draft.dept} onChange={(next) => setDraft({ ...draft, dept: next })} disabled={busy} />
                  <label className="field"><span className="field-label">Email（選填）</span><input className="input" type="email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} disabled={busy} /></label>
                </div>
                <div className="form-actions">
                  <button className="btn btn-primary btn-sm" disabled={busy || !draft.name.trim() || deptIncomplete(draft.dept)}>{busy ? '儲存中…' : '儲存'}</button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={cancelEdit} disabled={busy}>取消</button>
                </div>
              </form>
            ) : <>
              <div className="row-main"><strong>{user.name}</strong><span className="badge" style={{ marginLeft: 8 }}>{originLabel(user)}</span><div className="row-sub">帳號：{user.id} · 部門：{user.department === UNSPECIFIED ? '未指定' : user.department}{user.email ? ` · ${user.email}` : ''}</div></div>
              <div className="toolbar" style={{ display: 'flex', gap: 8 }}>
                {!isLocked(user, switches) && <button type="button" className="btn btn-ghost btn-sm" aria-label={`編輯 ${user.name}`} onClick={() => startEdit(user)} disabled={busy}>編輯</button>}
                <button type="button" className="btn btn-danger btn-sm" aria-label={`刪除 ${user.name}`} onClick={() => setPendingDelete(user)} disabled={busy}>刪除</button>
              </div>
            </>}
          </li>)}</ul>}
        {filteredUsers.length > PAGE_SIZE && (
          <nav className="directory-pagination" aria-label="使用者清單分頁">
            <span className="row-sub" aria-live="polite">共 {filteredUsers.length} 位 · 第 {currentPage} / {pageCount} 頁 · 每頁 {PAGE_SIZE} 位</span>
            <div>
              <button type="button" className="btn btn-sm" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>上一頁</button>
              <button type="button" className="btn btn-sm" disabled={currentPage === pageCount} onClick={() => setPage(currentPage + 1)}>下一頁</button>
            </div>
          </nav>
        )}
        <DepartmentsSection tenantId={tenantId} departments={deptSummaries} directorySyncEnabled={switches?.directorySyncEnabled ?? false} ssoAutoProvision={switches?.ssoAutoProvision ?? false} onChanged={refreshAfterDepartmentChange} onError={onError} />
        <form onSubmit={(event) => void add(event)} className="directory-form settings-section">
          <h3>新增使用者</h3>
          <div className="form-grid">
          <label className="field"><span className="field-label">登入帳號</span><input className="input" value={id} onChange={(e) => setId(e.target.value)} required maxLength={200} disabled={busy} autoComplete="off" placeholder="例如 hyweb" /></label>
          <label className="field"><span className="field-label">顯示名稱</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} disabled={busy} /></label>
          <DepartmentField departments={departments} value={dept} onChange={setDept} disabled={busy} />
          <label className="field"><span className="field-label">Email（選填）</span><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} /></label>
          </div>
          <div className="form-actions"><button className="btn btn-primary" disabled={busy || !id.trim() || !name.trim() || deptIncomplete(dept)}>{busy ? '新增中…' : '新增使用者'}</button></div>
        </form>
      </>}
    </div>

    <Dialog
      isOpen={!!pendingDelete}
      title={`刪除「${pendingDelete?.name ?? ''}」？`}
      confirmText="刪除"
      confirmVariant="danger"
      onClose={() => setPendingDelete(null)}
      onConfirm={() => void confirmDelete()}
    >
      <p style={{ marginTop: 0 }}>帳號 {pendingDelete?.id} 將從目錄移除：</p>
      <ul style={{ paddingLeft: 18 }}>
        {pendingDelete && canPasswordLogin(pendingDelete) && <li>無法再用帳密登入，帳密登入的工作階段會立即失效。</li>}
        {pendingDelete && (isOaManaged(pendingDelete)
          ? <li>自動登入的工作階段不會因此結束；要立即登出，請到「自動登入」分頁的「登入工作階段」作廢。</li>
          : <li>若此人也透過自動登入進入，不受影響，其工作階段仍然有效。</li>)}
        <li>會從其他人的代理人名單中移除。</li>
        <li>「權限」中直接指派給此帳號的角色會保留；之後以相同帳號重新加入，或透過 SSO 以此帳號登入時仍會生效。</li>
      </ul>
      {pendingDelete && isOaManaged(pendingDelete) && <p>此帳號由 OA 管理：刪除後下次同步或登入時會重新建立，停權請在 OA 處理。</p>}
    </Dialog>
  </div>;
}
