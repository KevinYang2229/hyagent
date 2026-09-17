import { useCallback, useEffect, useState } from 'react';
import { Checkbox, useToast } from '@hyagent/ui';
import { api, type ScopeDef, type TenantPolicyView } from '../../api';
import BundlesSection from './BundlesSection';
import { formatDepartment, UNKNOWN_DEPARTMENT } from '../../components/department.util';

/**
 * 權限分頁：以「能力」為中心——每個能力一列，直接選 未開通／全租戶／指定對象。
 * 對應資料模型（聯集）：全租戶＝grantedScopes；指定對象＝groups/accounts；未開通＝三處皆無。
 * 切到「全租戶」時清掉該能力的部門/帳號勾選（聯集下已無意義，留著徒增困惑）。
 */

type Mode = 'off' | 'all' | 'some';

/** 從清單加入/移除某 scope（回新陣列） */
function toggle(list: string[], scope: string): string[] {
  return list.includes(scope) ? list.filter((s) => s !== scope) : [...list, scope];
}

/** 把某 scope 從 groups/accounts 這類對照表的所有值中移除（回新物件） */
function stripScope(map: Record<string, string[]>, scope: string): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(map).map(([k, v]) => [k, v.filter((s) => s !== scope)]),
  );
}

const MODES: { value: Mode; label: string }[] = [
  { value: 'off', label: '未開通' },
  { value: 'all', label: '全租戶' },
  { value: 'some', label: '指定對象' },
];

/** 摘要最多列出幾個對象名稱，其餘以「等 N 個」帶過 */
const SUMMARY_MAX_NAMES = 3;

function summarizeTargets(names: string[]): string {
  if (names.length <= SUMMARY_MAX_NAMES) return names.join('、');
  return `${names.slice(0, SUMMARY_MAX_NAMES).join('、')} 等 ${names.length} 個`;
}

export default function PermissionsTab({
  tenantId,
  onError,
}: {
  tenantId: string;
  onError: (e: unknown) => void;
}) {
  const toast = useToast();
  const [policy, setPolicy] = useState<TenantPolicyView | null>(null);
  const [saving, setSaving] = useState(false);
  // 使用者明確選了「指定對象」但尚未勾任何人的能力：資料上三處皆無、推導會誤判成「未開通」，
  // 用此集合讓模式停留在指定對象、展開區得以顯示（勾了人之後自然由資料推導）。
  const [someOverride, setSomeOverride] = useState<Set<string>>(new Set());
  // 「指定對象」的勾選區預設收合、只顯示摘要；此集合記錄使用者展開編輯中的能力
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      setPolicy(await api.getTenantPolicy(tenantId));
    } catch (e) {
      onError(e);
    }
  }, [tenantId, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!policy)
    return (
      <div className="card">
        <div className="card-body">載入中…</div>
      </div>
    );

  const groups: { label: string; items: ScopeDef[] }[] = [
    { label: '服務', items: policy.capabilities.filter((s) => s.id.startsWith('service:')) },
    { label: '表單', items: policy.capabilities.filter((s) => s.id.startsWith('form:')) },
    {
      label: '外部能力',
      items: policy.capabilities.filter(
        (s) => !s.id.startsWith('service:') && !s.id.startsWith('form:'),
      ),
    },
  ].filter((g) => g.items.length > 0);

  /** 該能力目前的模式：全租戶 > 指定對象（含剛切換、尚未勾人）> 未開通 */
  const modeOf = (id: string): Mode => {
    if (policy.grantedScopes.includes(id)) return 'all';
    const inGroups = Object.values(policy.groups).some((v) => v.includes(id));
    const inAccounts = Object.values(policy.accounts).some((v) => v.includes(id));
    return inGroups || inAccounts || someOverride.has(id) ? 'some' : 'off';
  };

  /**
   * 角色授予對照：scope → 「角色名（被指派對象…）」。
   * 聯集模型下權限區的模式推導只看零散資料，看不到角色授予——不補提示會出現
   * 「顯示未開通、實際卻有權限」與「取消勾選卻關不掉」的認知落差。
   */
  const bundleGrants = (id: string): string[] =>
    policy.bundles
      .filter((b) => b.scopes.includes(id))
      .map((b) => {
        const deps = policy.departments
          .filter((d) => (policy.groupBundles[d] ?? []).includes(b.id))
          .map(formatDepartment);
        const users = policy.users
          .filter((u) => (policy.accountBundles[u.id] ?? []).includes(b.id))
          .map((u) => u.label);
        const targets = [...deps, ...users];
        return targets.length ? `${b.name}（${targets.join('、')}）` : '';
      })
      .filter(Boolean);

  // 「填表申請」是否有任何來源授予（零散或已被指派的角色）；form:* 缺它時為死授權，給軟警告
  const formServiceGranted =
    policy.grantedScopes.includes('service:form') ||
    Object.values(policy.groups).some((v) => v.includes('service:form')) ||
    Object.values(policy.accounts).some((v) => v.includes('service:form')) ||
    policy.bundles.some(
      (b) =>
        b.scopes.includes('service:form') &&
        (Object.values(policy.groupBundles).some((ids) => ids.includes(b.id)) ||
          Object.values(policy.accountBundles).some((ids) => ids.includes(b.id))),
    );

  const toggleExpanded = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const setMode = (id: string, mode: Mode) => {
    setSomeOverride((prev) => {
      const next = new Set(prev);
      if (mode === 'some') next.add(id);
      else next.delete(id);
      return next;
    });
    // 切到指定對象時直接展開勾選區，離開時收起
    setExpanded((prev) => {
      const next = new Set(prev);
      if (mode === 'some') next.add(id);
      else next.delete(id);
      return next;
    });
    setPolicy((p) => {
      if (!p) return p;
      const granted = p.grantedScopes.filter((s) => s !== id);
      if (mode === 'all') {
        // 全租戶：進 grantedScopes，並清掉部門/帳號的殘留勾選
        return {
          ...p,
          grantedScopes: [...granted, id],
          groups: stripScope(p.groups, id),
          accounts: stripScope(p.accounts, id),
        };
      }
      if (mode === 'off') {
        return { ...p, grantedScopes: granted, groups: stripScope(p.groups, id), accounts: stripScope(p.accounts, id) };
      }
      // some：離開 grantedScopes，保留（或開始）部門/帳號勾選
      return { ...p, grantedScopes: granted };
    });
  };

  const toggleDept = (dep: string, id: string) =>
    setPolicy((p) =>
      p ? { ...p, groups: { ...p.groups, [dep]: toggle(p.groups[dep] ?? [], id) } } : p,
    );
  const toggleAccount = (userId: string, id: string) =>
    setPolicy((p) =>
      p ? { ...p, accounts: { ...p.accounts, [userId]: toggle(p.accounts[userId] ?? [], id) } } : p,
    );

  const save = async () => {
    if (!policy) return;
    setSaving(true);
    try {
      const updated = await api.putTenantPolicy(tenantId, {
        grantedScopes: policy.grantedScopes,
        groups: policy.groups,
        accounts: policy.accounts,
        bundles: policy.bundles,
        groupBundles: policy.groupBundles,
        accountBundles: policy.accountBundles,
      });
      setPolicy(updated);
      toast.success('已儲存變更');
    } catch (e) {
      onError(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <BundlesSection
        policy={policy}
        onChange={(updater) => setPolicy((p) => (p ? updater(p) : p))}
      />

    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">權限</div>
          <div className="card-desc">
            每個能力可切換「未開通／全租戶／指定對象」；指定對象會列出已選部門與帳號，點「編輯對象」調整。（表單填寫與送出屬基礎功能，於此控制各表單可見性。）
          </div>
        </div>
      </div>

      {groups.map((g, gi) => (
        <div
          key={g.label}
          className="card-body"
          style={gi > 0 ? { borderTop: '1px solid var(--border-color)' } : undefined}
        >
          <div style={{ fontWeight: 500, marginBottom: 8 }}>{g.label}</div>
          <ul className="list">
            {g.items.map((s) => {
              const mode = modeOf(s.id);
              const pickedDeps = policy.departments.filter((d) =>
                (policy.groups[d] ?? []).includes(s.id),
              );
              const pickedUsers = policy.users.filter((u) =>
                (policy.accounts[u.id] ?? []).includes(s.id),
              );
              const grants = bundleGrants(s.id);
              const targetNames = [...pickedDeps.map(formatDepartment), ...pickedUsers.map((u) => u.label)];
              // 尚未勾任何對象時強制展開，避免摘要只剩警告、找不到勾選處
              const showPicker = mode === 'some' && (expanded.has(s.id) || targetNames.length === 0);
              return (
                <li key={s.id} className="row" style={{ display: 'block', padding: '10px 0' }}>
                  <div className="perm-row-head">
                    <div style={{ flex: '1 1 240px', minWidth: 0 }}>
                      <span style={{ fontWeight: 500 }}>{s.label}</span>
                      <span className="row-sub" style={{ marginLeft: 8 }}>
                        {s.id}
                      </span>
                      {mode === 'all' && <div className="perm-summary">租戶內所有人皆可使用</div>}
                      {mode === 'some' && targetNames.length > 0 && (
                        <div className="perm-summary">
                          指定對象：{summarizeTargets(targetNames)}
                          <button
                            type="button"
                            className="perm-summary-edit"
                            onClick={() => toggleExpanded(s.id)}
                            aria-expanded={showPicker}
                          >
                            {showPicker ? '收合' : '編輯對象'}
                          </button>
                        </div>
                      )}
                      {grants.length > 0 && (
                        <div className="perm-summary">另由角色授予：{grants.join('；')}</div>
                      )}
                      {s.id.startsWith('form:') &&
                        (mode !== 'off' || grants.length > 0) &&
                        !formServiceGranted && (
                          <div className="perm-summary">
                            ⚠️ 「填表申請」服務未開通，此表單的授權實際不可用。
                          </div>
                        )}
                    </div>
                    <div className="mode-seg" role="group" aria-label={`${s.label} 的授權模式`}>
                      {MODES.map((m) => (
                        <button
                          key={m.value}
                          type="button"
                          data-mode={m.value}
                          aria-pressed={mode === m.value}
                          onClick={() => mode !== m.value && setMode(s.id, m.value)}
                        >
                          {m.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {showPicker && (
                    <div style={{ marginTop: 10, marginLeft: 2, display: 'grid', gap: 6 }}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
                        <span className="row-sub" style={{ width: 34 }}>部門</span>
                        {policy.departments.map((dep) => (
                          <label key={dep} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                            <Checkbox
                              checked={(policy.groups[dep] ?? []).includes(s.id)}
                              onChange={() => toggleDept(dep, s.id)}
                            />
                            <span
                              style={{ fontSize: 13.5 }}
                              title={dep === UNKNOWN_DEPARTMENT ? '公開 widget 的訪客落在此桶' : undefined}
                            >
                              {formatDepartment(dep)}
                            </span>
                          </label>
                        ))}
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
                        <span className="row-sub" style={{ width: 34 }}>帳號</span>
                        {policy.users.map((u) => (
                          <label key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                            <Checkbox
                              checked={(policy.accounts[u.id] ?? []).includes(s.id)}
                              onChange={() => toggleAccount(u.id, s.id)}
                            />
                            <span style={{ fontSize: 13.5 }}>
                              {u.label}
                              <span className="row-sub" style={{ marginLeft: 4 }}>{u.id}</span>
                            </span>
                          </label>
                        ))}
                      </div>
                      {pickedDeps.length === 0 && pickedUsers.length === 0 && (
                        <div className="row-sub">⚠️ 尚未選擇任何對象——目前效果等同「未開通」。</div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}

      <div className="card-body" style={{ borderTop: '1px solid var(--border-color)' }}>
        <button className="btn btn-primary" onClick={save} disabled={saving}>
          儲存
        </button>
      </div>
    </div>
    </div>
  );
}
