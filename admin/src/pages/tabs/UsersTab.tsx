import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, type DirectoryUser } from '../../api';

export default function UsersTab({ tenantId, onError }: { tenantId: string; onError: (error: unknown) => void }) {
  const [users, setUsers] = useState<DirectoryUser[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [department, setDepartment] = useState('');
  const [email, setEmail] = useState('');
  const load = useCallback(async () => {
    setLoaded(false);
    setError('');
    try { setUsers((await api.listDirectoryUsers(tenantId)).users); setLoaded(true); }
    catch (err) { setError('目錄載入失敗，請重新整理'); onError(err); }
  }, [tenantId, onError]);
  useEffect(() => { void load(); }, [load]);
  async function add(event: FormEvent) {
    event.preventDefault();
    if (busy || !loaded) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await api.addDirectoryUser(tenantId, {
        id: id.trim(), name: name.trim(), department: department.trim() || '—',
        ...(email.trim() ? { email: email.trim() } : {}),
      });
      setUsers(result.users);
      setMessage(`已新增帳號 ${id.trim()}`);
      setId(''); setName(''); setDepartment(''); setEmail('');
    } catch (err) { setError(err instanceof Error ? err.message : '新增失敗，請稍後再試'); onError(err); }
    finally { setBusy(false); }
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
        <p className="row-sub">共 {users.length} 位使用者。部門會影響既有部門授權，未填寫時為「未指定」。新增不會覆蓋其他人員。</p>
        {!users.length ? <p className="empty">尚無使用者，請先新增登入帳號。</p> :
          <ul className="list">{users.map((user) => <li className="row" key={user.id}>
            <div><strong>{user.name}</strong><div className="row-sub">帳號：{user.id} · 部門：{user.department === '—' ? '未指定' : user.department}{user.email ? ` · ${user.email}` : ''}</div></div>
          </li>)}</ul>}
        <form onSubmit={(event) => void add(event)} className="directory-form settings-section">
          <h3>新增使用者</h3>
          <div className="form-grid">
          <label className="field"><span className="field-label">登入帳號</span><input className="input" value={id} onChange={(e) => setId(e.target.value)} required maxLength={200} disabled={busy} autoComplete="off" placeholder="例如 hyweb" /></label>
          <label className="field"><span className="field-label">顯示名稱</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} disabled={busy} /></label>
          <label className="field"><span className="field-label">部門（選填）</span><input className="input" value={department} onChange={(e) => setDepartment(e.target.value)} maxLength={200} disabled={busy} /></label>
          <label className="field"><span className="field-label">Email（選填）</span><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} /></label>
          </div>
          <div className="form-actions"><button className="btn btn-primary" disabled={busy || !id.trim() || !name.trim()}>{busy ? '新增中…' : '新增使用者'}</button></div>
        </form>
      </>}
    </div>
  </div>;
}
