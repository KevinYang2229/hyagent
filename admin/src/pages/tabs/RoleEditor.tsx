import { useState } from 'react';
import { Checkbox } from '@hyagent/ui';
import type { ScopeDef } from '../../api';
import { formatDepartment } from '../../components/department.util';
import {
  capabilityGaps, capabilityLabel, everyoneBlockedScopes, groupCapabilities, isMcp, toggleCapability, type Person, type RoleDraft,
} from './permissions.util';

/** 選項多於此數才顯示搜尋框 */
const SEARCH_THRESHOLD = 8;

/** 可搜尋的勾選清單（部門、帳號、表單共用） */
function CheckList({ label, items, selected, onToggle, disabled }: {
  label: string;
  items: { id: string; label: string; sub?: string }[];
  selected: string[];
  onToggle: (id: string) => void;
  disabled?: (id: string) => boolean;
}) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLocaleLowerCase();
  const shown = q ? items.filter((it) => `${it.label} ${it.sub ?? ''}`.toLocaleLowerCase().includes(q)) : items;
  return <div className="role-checklist">
    {items.length > SEARCH_THRESHOLD && (
      <input className="input" aria-label={`搜尋${label}`} placeholder={`搜尋${label}…`} value={query} onChange={(e) => setQuery(e.target.value)} />
    )}
    <div className="role-check-grid" role="group" aria-label={label}>
      {shown.map((it) => (
        <label key={it.id} className="role-check">
          <Checkbox checked={selected.includes(it.id)} disabled={disabled?.(it.id)} onChange={() => onToggle(it.id)} />
          <span>{it.label}{it.sub && <span className="role-check-sub">{it.sub}</span>}</span>
        </label>
      ))}
      {!shown.length && <span className="perm-text">{items.length ? '找不到符合的項目。' : '目前沒有可選的項目。'}</span>}
    </div>
  </div>;
}

/**
 * 角色編輯器：同一個面板設定「能做什麼」與「給誰」。
 * 相依項目自動補上／一併取消並告知；開給所有人時擋下知識庫標籤與外部服務。
 */
export default function RoleEditor({ draft, isNew, capabilities, departments, people, onChange, onDone, onCancel }: {
  draft: RoleDraft;
  isNew: boolean;
  capabilities: ScopeDef[];
  departments: string[];
  people: Person[];
  onChange: (next: RoleDraft) => void;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [notice, setNotice] = useState('');
  const groups = groupCapabilities(capabilities).filter((g) => g.items.length > 0);
  const blocked = everyoneBlockedScopes(draft.scopes);
  const gaps = capabilityGaps(draft.scopes, capabilities);
  const hasTarget = draft.everyone || draft.departments.length > 0 || draft.accounts.length > 0;

  const toggleScope = (id: string) => {
    const result = toggleCapability(draft.scopes, id, capabilities);
    const nowBlocked = everyoneBlockedScopes(result.scopes);
    // 開給所有人的角色加入知識庫標籤或外部服務 → 改為只套用給指定對象，並提醒確認
    if (draft.everyone && nowBlocked.length > 0) {
      onChange({ ...draft, scopes: result.scopes, everyone: false });
      setNotice([result.notice, '這個角色含知識庫標籤或外部服務，不能開給所有人（含網站訪客），已改為只套用給下方選擇的部門或帳號，請確認套用對象。'].filter(Boolean).join(' '));
      return;
    }
    onChange({ ...draft, scopes: result.scopes });
    setNotice(result.notice ?? '');
  };
  const toggleIn = (key: 'departments' | 'accounts', id: string) => {
    const list = draft[key];
    onChange({ ...draft, [key]: list.includes(id) ? list.filter((x) => x !== id) : [...list, id] });
  };

  // 外部能力：服務內的角色排在該服務底下，看得出從屬關係
  const ordered = (items: ScopeDef[]) => [...items].sort((a, b) => a.id.localeCompare(b.id));
  const itemsOf = (items: ScopeDef[]) => ordered(items).map((c) => ({
    id: c.id,
    label: isMcp(c.id) && c.id.split(':').length > 2 ? `└ ${c.label}` : c.label,
    sub: c.description || undefined,
  }));

  return <form className="role-editor" aria-label={isNew ? '新增角色' : `編輯 ${draft.name}`} onSubmit={(e) => { e.preventDefault(); if (draft.name.trim()) onDone(); }}>
    <div className="form-grid">
      <label className="field"><span className="field-label">角色名稱</span>
        <input className="input" value={draft.name} onChange={(e) => onChange({ ...draft, name: e.target.value })} placeholder="例：一般員工、報告分析員" maxLength={100} autoFocus /></label>
      <label className="field"><span className="field-label">說明（選填）</span>
        <input className="input" value={draft.description ?? ''} onChange={(e) => onChange({ ...draft, description: e.target.value })} maxLength={200} /></label>
    </div>

    <section className="role-editor-section" aria-label="能做什麼">
      <h4>1. 能做什麼</h4>
      {groups.map((g) => (
        <div key={g.key} className="role-editor-group">
          <div className="field-label">{g.label}</div>
          <CheckList label={g.label} items={itemsOf(g.items)} selected={draft.scopes} onToggle={toggleScope} />
        </div>
      ))}
      {notice && <p className="perm-notice" role="status">{notice}</p>}
      {gaps.map((gap) => <p key={gap} className="perm-warn">{gap}<span className="perm-text">（若其他角色已提供，可忽略）</span></p>)}
      {draft.scopes.filter((s) => !capabilities.some((c) => c.id === s)).length > 0 && (
        <p className="perm-text">另有已不存在的項目：{draft.scopes.filter((s) => !capabilities.some((c) => c.id === s)).map((s) => capabilityLabel(capabilities, s)).join('、')}</p>
      )}
    </section>

    <section className="role-editor-section" aria-label="給誰">
      <h4>2. 給誰</h4>
      <label className="role-check role-check-everyone">
        <Checkbox checked={draft.everyone} disabled={blocked.length > 0} onChange={() => onChange({ ...draft, everyone: !draft.everyone })} />
        <span>所有人（含網站訪客）</span>
      </label>
      {blocked.length > 0 && <p className="perm-text">含 {blocked.map((s) => `「${capabilityLabel(capabilities, s)}」`).join('、')}，不能開給所有人，請選擇部門或帳號。</p>}
      {draft.everyone ? (
        <p className="perm-text">已套用給所有人，不需要再選部門或帳號。{(draft.departments.length + draft.accounts.length) > 0 && `另外指定的 ${draft.departments.length + draft.accounts.length} 個部門／帳號會保留。`}</p>
      ) : <>
        <div className="role-editor-group">
          <div className="field-label">部門</div>
          <CheckList label="部門" selected={draft.departments} onToggle={(id) => toggleIn('departments', id)}
            items={departments.map((d) => ({ id: d, label: formatDepartment(d) }))} />
          <p className="perm-text">部門裡的人（包含之後新加入的人）都會自動取得這個角色。</p>
        </div>
        <div className="role-editor-group">
          <div className="field-label">個別帳號</div>
          <CheckList label="帳號" selected={draft.accounts} onToggle={(id) => toggleIn('accounts', id)}
            items={people.filter((p) => p.kind === 'user').map((p) => ({ id: p.id, label: p.label, sub: p.inDirectory ? `${p.id} · ${formatDepartment(p.department)}` : `${p.id} · 未列於目前名錄` }))} />
        </div>
      </>}
      {!hasTarget && <p className="perm-warn">還沒有套用給任何人，這個角色目前不會生效。</p>}
    </section>

    <div className="form-actions">
      <button className="btn btn-primary btn-sm" disabled={!draft.name.trim()}>完成</button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>取消</button>
      <span className="perm-text">完成後按頁面底部「儲存」才會生效。</span>
    </div>
  </form>;
}
