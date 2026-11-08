import { useCallback, useEffect, useState } from 'react';
import { Checkbox, Dialog, useToast } from '@hyagent/ui';
import { api, ConflictError, type TenantPolicyView } from '../../api';
import { formatDepartment } from '../../components/department.util';
import RoleEditor from './RoleEditor';
import CollapsibleList from '../../components/CollapsibleList';
import {
  applyRoleDraft, capabilityGaps, GENERAL_SERVICES_ROLE_ID, generalServicesScopes, capabilityLabel, CATEGORY_LABELS, categoryOf, effectiveCapabilities, peopleOf, policyChanged,
  policyDepartments, removeRole, roleDraftOf, rolesOf, targetSummary, type Person, type RoleDraft, type RoleSource,
} from './permissions.util';

/**
 * 權限頁：只有「角色」。每個角色同時寫明能做什麼、給誰（所有人／部門／帳號）。
 * 舊的直接授權由後端換算成等效角色（convertedRoleIds），按儲存後改由角色承載。
 * 下方「個人權限」用來確認某人最後拿到什麼、有沒有缺漏，也可直接替他加角色。
 */

/** 人員下拉最多列出幾位；更多時要求先搜尋，避免上千個選項的下拉 */
const PERSON_OPTION_MAX = 200;

/** 摘要最多列出幾項能力，其餘以「等 N 項」帶過 */
const SUMMARY_MAX = 5;

const TEMPLATES: { name: string; description: string; scopes: string[] }[] = [
  { name: '一般員工', description: '填表申請與查詢規定；請另選允許的表單與知識庫標籤。', scopes: ['service:form', 'service:knowledge'] },
  { name: '報告分析員', description: '查詢知識並產生報告；請另選可查詢的知識庫標籤。', scopes: ['service:knowledge', 'service:report'] },
];

function sourceText(source: RoleSource): string {
  if (source.via === 'everyone') return '套用給所有人';
  if (source.via === 'members') return '套用給所有登入員工';
  if (source.via === 'department') return `來自部門「${formatDepartment(source.department)}」`;
  return '直接指派';
}

export default function PermissionsTab({ tenantId, onError, onDirtyChange }: {
  tenantId: string;
  onError: (e: unknown) => void;
  /** 未儲存狀態變化時通知外層，讓切換分頁時能先確認 */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const toast = useToast();
  const [policy, setPolicy] = useState<TenantPolicyView | null>(null);
  // 最後一次載入／儲存成功的內容，用來判斷是否有未儲存變更與「放棄變更」
  const [baseline, setBaseline] = useState<TenantPolicyView | null>(null);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<RoleDraft | null>(null);
  const [draftIsNew, setDraftIsNew] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<RoleDraft | null>(null);
  const [personKey, setPersonKey] = useState<string>('');
  const [personQuery, setPersonQuery] = useState('');
  // 儲存時發現資料已被他人變更：保留畫面上的修改，讓管理者決定重新載入
  const [conflict, setConflict] = useState(false);

  const load = useCallback(async () => {
    try {
      const loaded = await api.getTenantPolicy(tenantId);
      setPolicy(loaded);
      setBaseline(loaded);
      setConflict(false);
    } catch (e) {
      onError(e);
    }
  }, [tenantId, onError]);

  useEffect(() => { void load(); }, [load]);

  // 角色編輯器開著也算未儲存：草稿還沒「完成」就切分頁，內容會直接消失
  const dirty = !!draft || (!!policy && !!baseline && policyChanged(policy, baseline));
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  // 離開分頁（unmount）時清掉外層的未儲存旗標
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  // 重整或關閉瀏覽器前提醒
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  if (!policy) return <div className="card"><div className="card-body">載入中…</div></div>;

  const caps = policy.capabilities;
  const people = peopleOf(policy);
  const departments = policyDepartments(policy);
  const accountLabel = (id: string) => people.find((p) => p.id === id)?.label ?? id;
  const converted = policy.convertedRoleIds.filter((id) => policy.bundles.some((b) => b.id === id));
  // 有缺漏的人（以每個人所有角色的聯集判斷才準確）
  const gapsOf = (person: Person) => capabilityGaps(effectiveCapabilities(policy, person).map((c) => c.scope), caps);
  // 彙總名單只列真正會用不了的缺漏（不含軟提醒），也不列網站訪客：訪客只開部分能力通常是刻意的
  const peopleWithGaps = people.filter((p) => p.kind === 'user'
    && capabilityGaps(effectiveCapabilities(policy, p).map((c) => c.scope), caps, { includeSoft: false }).length > 0);

  const startNew = (template?: (typeof TEMPLATES)[number]) => {
    setDraft({
      id: `b-${crypto.randomUUID()}`,
      name: template?.name ?? '',
      ...(template ? { description: template.description } : {}),
      scopes: template ? template.scopes.filter((id) => caps.some((c) => c.id === id)) : [],
      everyone: false, members: false, departments: [], accounts: [],
    });
    setDraftIsNew(true);
  };
  const startEdit = (roleId: string) => {
    const role = policy.bundles.find((b) => b.id === roleId)!;
    setDraft(roleDraftOf(policy, role));
    setDraftIsNew(false);
  };
  const finishDraft = () => {
    if (!draft) return;
    setPolicy((p) => (p ? applyRoleDraft(p, draft) : p));
    setDraft(null);
  };
  const confirmDelete = () => {
    const target = pendingDelete;
    setPendingDelete(null);
    if (target) setPolicy((p) => (p ? removeRole(p, target.id) : p));
  };

  /** 個人權限區直接替某人加／移除角色（只動直接指派） */
  const toggleDirect = (person: Person, roleId: string) => setPolicy((p) => {
    if (!p) return p;
    const cur = p.accountBundles[person.id] ?? [];
    const next = cur.includes(roleId) ? cur.filter((x) => x !== roleId) : [...cur, roleId];
    return { ...p, accountBundles: { ...p.accountBundles, [person.id]: next } };
  });

  const save = async () => {
    setSaving(true);
    try {
      const updated = await api.putTenantPolicy(tenantId, {
        // 直接授權一律送空：資料改由角色承載（舊設定已由後端換算成角色）
        grantedScopes: [], groups: {}, accounts: {},
        bundles: policy.bundles,
        groupBundles: policy.groupBundles,
        accountBundles: policy.accountBundles,
        tenantBundles: policy.tenantBundles,
        memberBundles: policy.memberBundles,
        baseVersion: baseline?.version ?? policy.version,
      });
      setPolicy(updated);
      setBaseline(updated);
      toast.success('已儲存變更');
    } catch (e) {
      if (e instanceof ConflictError) { setConflict(true); return; }
      onError(e);
    } finally {
      setSaving(false);
    }
  };
  const discard = () => { setPolicy(baseline); setDraft(null); };

  const selected = people.find((p) => `${p.kind}:${p.id}` === personKey) ?? null;
  const personOptionLabel = (p: Person) =>
    p.kind === 'guest' ? '網站訪客（未登入）' : `${p.label}（${p.inDirectory ? formatDepartment(p.department) : '未列於目前名錄'}）`;
  const pq = personQuery.trim().toLocaleLowerCase();
  const matchedPeople = pq
    ? people.filter((p) => `${p.label} ${p.id} ${formatDepartment(p.department)} ${p.kind === 'guest' ? '網站訪客' : ''}`.toLocaleLowerCase().includes(pq))
    : people;
  const shownPeople = matchedPeople.slice(0, PERSON_OPTION_MAX);
  const editor = draft && (
    <RoleEditor draft={draft} isNew={draftIsNew} capabilities={caps} departments={departments} people={people}
      onChange={setDraft} onDone={finishDraft} onCancel={() => setDraft(null)} />
  );

  return <div className="settings-stack">
    {conflict && (
      <div className="banner banner-err" role="alert">
        權限設定在你開啟此頁後已被變更（可能是其他管理者、表單異動或人員同步），為避免蓋掉那些變更，這次沒有儲存。
        請記下你的修改，重新載入後再設定一次。
        <button type="button" className="btn btn-sm" style={{ marginLeft: 8 }} onClick={() => void load()}>重新載入（放棄我的修改）</button>
      </div>
    )}
    {converted.length > 0 && (
      <div className="banner" role="status">
        舊的權限設定已整理成 {converted.length} 個角色（標示「由舊設定轉換」），每個人的權限都不變。按頁面底部「儲存」後改用新的角色格式；也可以先改名或合併。
      </div>
    )}

    <GeneralServicesCard
      policy={policy}
      disabled={!!draft}
      onToggle={(on) => setPolicy((p) => (p ? {
        ...p,
        memberBundles: on
          ? [...new Set([...p.memberBundles, GENERAL_SERVICES_ROLE_ID])]
          : p.memberBundles.filter((id) => id !== GENERAL_SERVICES_ROLE_ID),
      } : p))}
      onCreate={() => setPolicy((p) => (p ? {
        ...p,
        bundles: [...p.bundles, {
          id: GENERAL_SERVICES_ROLE_ID,
          name: '通用服務',
          description: '全員通用的服務。可一鍵開給所有登入員工（不含網站訪客）。',
          scopes: generalServicesScopes(p.capabilities),
        }],
      } : p))}
      onEdit={() => startEdit(GENERAL_SERVICES_ROLE_ID)}
    />

    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">角色</div>
          <div className="card-desc">每個角色寫明「能做什麼」與「給誰」。</div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={() => startNew()} disabled={!!draft}>＋ 新增角色</button>
      </div>

      {!draft && (
        <div className="card-body role-templates">
          <p className="perm-text role-tip">新人報到：在「使用者目錄」把人放進正確的部門，就會自動取得該部門的角色；需要額外權限時，到下方「個人權限」替他加角色。</p>
          <span className="perm-text">從範本開始：</span>
          {TEMPLATES.map((t) => <button key={t.name} type="button" className="btn btn-ghost btn-sm" onClick={() => startNew(t)}>{t.name}</button>)}
        </div>
      )}
      {draft && draftIsNew && <div className="card-body">{editor}</div>}

      {policy.bundles.length === 0 && !draft && <div className="empty">尚未建立角色，可從範本開始。</div>}
      <ul className="list">
        {policy.bundles.map((role) => {
          if (draft && !draftIsNew && draft.id === role.id) return <li key={role.id} className="row role-row-editing">{editor}</li>;
          const d = roleDraftOf(policy, role);
          const target = targetSummary(d, accountLabel);
          const labels = role.scopes.map((s) => capabilityLabel(caps, s));
          const shown = labels.length > SUMMARY_MAX ? `${labels.slice(0, SUMMARY_MAX).join('、')} 等 ${labels.length} 項` : labels.join('、');
          return <li key={role.id} className="row role-row">
            <div className="row-main">
              <div className="row-title">
                {role.name}
                {converted.includes(role.id) && <span className="badge badge-warn">由舊設定轉換</span>}
              </div>
              <div className="perm-text">能做：{shown || '（尚未選擇能力）'}</div>
              <div className="perm-text">給誰：{target || <span className="perm-warn-inline">尚未套用給任何人，目前不會生效</span>}</div>
            </div>
            <div className="row-actions">
              <button className="btn btn-ghost btn-sm" onClick={() => startEdit(role.id)} disabled={!!draft} aria-label={`編輯 ${role.name}`}>編輯</button>
              <button className="btn btn-danger btn-sm" onClick={() => setPendingDelete(d)} disabled={!!draft} aria-label={`刪除 ${role.name}`}>刪除</button>
            </div>
          </li>;
        })}
      </ul>
    </div>

    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">個人權限</div>
          <div className="card-desc">選一個人，查看他最後擁有哪些能力、來自哪個角色，並檢查有沒有缺漏。需要部門以外的權限時，可以在這裡直接替他加角色。</div>
        </div>
      </div>
      <div className="card-body person-access">
        {peopleWithGaps.length > 0 ? (
          <div className="perm-warn" role="status">
            {peopleWithGaps.length} 位的權限可能不完整：
            <CollapsibleList items={peopleWithGaps} separator={null}
              render={(p) => <button type="button" className="perm-link" onClick={() => setPersonKey(`${p.kind}:${p.id}`)}>{p.label}</button>} />
          </div>
        ) : <p className="perm-ok">沒有發現權限缺漏。</p>}

        <div className="person-picker">
          <label className="field">
            <span className="field-label">搜尋人員</span>
            <input className="input" aria-label="搜尋人員" placeholder="姓名、帳號或部門…" value={personQuery} onChange={(e) => setPersonQuery(e.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">人員{personQuery.trim() && `（符合 ${matchedPeople.length} 位）`}</span>
            <select className="select" aria-label="選擇人員" value={personKey} onChange={(e) => setPersonKey(e.target.value)}>
              <option value="">請選擇…</option>
              {/* 已選的人即使不符合搜尋也保留，下拉才不會跳回「請選擇」 */}
              {selected && !shownPeople.includes(selected) && <option value={personKey}>{personOptionLabel(selected)}</option>}
              {shownPeople.map((p) => <option key={`${p.kind}:${p.id}`} value={`${p.kind}:${p.id}`}>{personOptionLabel(p)}</option>)}
            </select>
          </label>
          {matchedPeople.length > PERSON_OPTION_MAX && <p className="perm-text">只列出前 {PERSON_OPTION_MAX} 位，請輸入關鍵字縮小範圍。</p>}
        </div>

        {selected && <PersonDetail person={selected} policy={policy} onToggle={(roleId) => toggleDirect(selected, roleId)} gaps={gapsOf(selected)} />}
      </div>
    </div>

    {/* 共用一顆儲存鈕；固定在底部，捲到哪都看得到是否還有未儲存的變更 */}
    <div className={`perm-savebar${dirty ? ' is-dirty' : ''}`} role="region" aria-label="儲存權限">
      <span className="perm-savebar-status" aria-live="polite">
        {draft ? '角色編輯中：按「完成」後再按「儲存」才會生效。' : dirty ? '有未儲存的變更，按「儲存」後才會生效。' : converted.length > 0 ? '舊設定尚未改用角色格式，按「儲存」套用（權限不變）。' : '所有變更皆已儲存。'}
      </span>
      <div className="perm-savebar-actions">
        {dirty && <button type="button" className="btn btn-ghost btn-sm" onClick={discard} disabled={saving}>放棄變更</button>}
        <button type="button" className="btn btn-primary btn-sm" onClick={() => void save()} disabled={saving || !!draft || (!dirty && converted.length === 0)}>
          {saving ? '儲存中…' : '儲存'}
        </button>
      </div>
    </div>
    {draft && <p className="perm-text" style={{ textAlign: 'right', margin: 0 }}>請先在角色編輯器按「完成」或「取消」，再儲存。</p>}

    <Dialog
      isOpen={!!pendingDelete}
      title={`刪除角色「${pendingDelete?.name ?? ''}」？`}
      confirmText="刪除"
      confirmVariant="danger"
      onClose={() => setPendingDelete(null)}
      onConfirm={confirmDelete}
    >
      {pendingDelete && (targetSummary(pendingDelete, accountLabel)
        ? <>「{targetSummary(pendingDelete, accountLabel)}」將失去這個角色的能力（其他角色提供的不受影響）。按頁面底部「儲存」後生效。</>
        : <>這個角色沒有套用給任何人，刪除不影響現有權限。</>)}
    </Dialog>
  </div>;
}

function PersonDetail({ person, policy, onToggle, gaps }: {
  person: Person;
  policy: TenantPolicyView;
  onToggle: (roleId: string) => void;
  gaps: string[];
}) {
  const caps = policy.capabilities;
  const held = rolesOf(policy, person);
  const effective = effectiveCapabilities(policy, person);
  const byCategory = (Object.keys(CATEGORY_LABELS) as (keyof typeof CATEGORY_LABELS)[])
    .map((key) => ({ key, items: effective.filter((e) => categoryOf(e.scope) === key) }))
    .filter((g) => g.items.length > 0);

  return <div className="person-detail">
    <div className="perm-text">
      {person.kind === 'guest' ? '網站訪客只會取得「所有人」與「訪客／未指定部門」部門的角色。' : `部門：${formatDepartment(person.department)}`}
    </div>

    <section aria-label="角色">
      <h4>角色</h4>
      <div className="role-check-grid">
        {policy.bundles.map((role) => {
          const sources = held.find((h) => h.role.id === role.id)?.sources ?? [];
          const direct = sources.some((s) => s.via === 'direct');
          const inherited = sources.filter((s) => s.via !== 'direct');
          const locked = person.kind === 'guest' || (inherited.length > 0 && !direct);
          // 個人層級只能增減直接指派，扣不掉部門或所有人給的角色，所以這些列要看得出不能操作的原因
          const hint = person.kind === 'user' && inherited.length > 0
            ? (direct ? '取消直接指派後，仍會從其他來源取得' : '不能在這裡取消，請到此角色的「給誰」調整')
            : '';
          return <label key={role.id} className={`role-check${locked ? ' is-locked' : ''}`}>
            <Checkbox checked={sources.length > 0} disabled={locked} onChange={() => onToggle(role.id)} />
            <span>{role.name}{sources.length > 0 && <span className="role-check-sub">{sources.map(sourceText).join('、')}</span>}
              {hint && <span className="role-check-sub">{hint}</span>}</span>
          </label>;
        })}
      </div>
      {person.kind === 'user'
        ? <p className="perm-text">勾選＝直接指派給此人。來自部門或所有人的角色要到該角色的「給誰」調整。</p>
        : <p className="perm-text">網站訪客沒有帳號，不能直接指派角色。要開放給訪客，請到該角色的「給誰」選擇所有人或「訪客／未指定部門」部門。</p>}
    </section>

    <section aria-label="最後擁有的能力">
      <h4>最後擁有的能力</h4>
      {gaps.map((g) => <p key={g} className="perm-warn">{g}</p>)}
      {byCategory.length === 0 ? <p className="perm-text">目前沒有任何能力。</p> : byCategory.map((g) => (
        <div key={g.key} className="person-cap-group">
          <div className="field-label">{CATEGORY_LABELS[g.key]}</div>
          <ul className="person-caps">
            {g.items.map((e) => <li key={e.scope}>{capabilityLabel(caps, e.scope)}<span className="role-check-sub">來自：{e.roles.join('、')}</span></li>)}
          </ul>
        </div>
      ))}
    </section>
  </div>;
}

/**
 * 通用服務群組：預設最小權限（關閉），一鍵開給所有登入員工（不含網站訪客）或關閉。
 * 內容就是一個普通角色（id 固定），要調整能力請按「編輯內容」。
 */
function GeneralServicesCard({ policy, disabled, onToggle, onCreate, onEdit }: {
  policy: TenantPolicyView;
  disabled: boolean;
  onToggle: (on: boolean) => void;
  onCreate: () => void;
  onEdit: () => void;
}) {
  const role = policy.bundles.find((b) => b.id === GENERAL_SERVICES_ROLE_ID);
  const on = policy.memberBundles.includes(GENERAL_SERVICES_ROLE_ID);
  const caps = policy.capabilities;
  return <div className="card general-services">
    <div className="card-head">
      <div>
        <div className="card-title">通用服務</div>
        <div className="card-desc">預設關閉（最小權限）。開啟後，所有登入員工都能使用下列能力；網站訪客不包含在內。</div>
      </div>
      {role && (
        <label className="role-check general-services-switch">
          <Checkbox checked={on} disabled={disabled} onChange={() => onToggle(!on)} aria-label="開放通用服務給所有登入員工" />
          <span>{on ? '已開放給所有登入員工' : '未開放'}</span>
        </label>
      )}
    </div>
    <div className="card-body">
      {role ? <>
        <div className="perm-text">
          包含：<CollapsibleList items={role.scopes} max={6} render={(scope) => capabilityLabel(caps, scope)} empty="（尚未選擇能力）" />
        </div>
        <div className="general-services-actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onEdit} disabled={disabled}>編輯內容</button>
          <span className="perm-text">切換或編輯後，按頁面底部「儲存」才會生效。</span>
        </div>
      </> : <>
        <p className="perm-text">此租戶還沒有通用服務群組。建立後預設關閉，內容為填表申請、知識庫問答、智慧代理與所有表單，可再調整。</p>
        <button type="button" className="btn btn-sm" onClick={onCreate} disabled={disabled}>建立通用服務群組</button>
      </>}
    </div>
  </div>;
}
