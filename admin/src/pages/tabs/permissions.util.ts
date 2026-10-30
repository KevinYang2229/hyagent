import type { ScopeDef, TenantPolicyView } from '../../api';

/**
 * 權限頁與角色編輯器共用的能力分類。
 * 知識庫標籤（kb:）獨立成一類：它決定「誰查得到哪些文件」，與 Email／ERP 這類外部動作性質不同，
 * 混在一起時管理者從知識庫頁過來會找不到。
 */
export type CapabilityCategory = 'service' | 'form' | 'kb' | 'external';

export const CATEGORY_LABELS: Record<CapabilityCategory, string> = {
  service: '服務',
  form: '表單',
  kb: '知識庫標籤',
  external: '外部能力',
};

export function categoryOf(id: string): CapabilityCategory {
  if (id.startsWith('service:')) return 'service';
  if (id.startsWith('form:')) return 'form';
  if (id.startsWith('kb:')) return 'kb';
  return 'external';
}

export function groupCapabilities(capabilities: ScopeDef[]): { key: CapabilityCategory; label: string; items: ScopeDef[] }[] {
  return (Object.keys(CATEGORY_LABELS) as CapabilityCategory[]).map((key) => ({
    key,
    label: CATEGORY_LABELS[key],
    items: capabilities.filter((s) => categoryOf(s.id) === key),
  }));
}

export function isCapabilityCategory(value: string | null | undefined): value is CapabilityCategory {
  return !!value && value in CATEGORY_LABELS;
}

/** 權限頁會送出的欄位；用來比對是否有未儲存變更 */
type EditablePolicy = Pick<
  TenantPolicyView,
  'grantedScopes' | 'groups' | 'accounts' | 'bundles' | 'groupBundles' | 'accountBundles'
>;

/** 清單順序與空陣列不影響授權結果，正規化後再比，避免「勾了又取消」被誤判為有變更 */
function normalize(p: EditablePolicy): string {
  const map = (m: Record<string, string[]>) =>
    Object.fromEntries(
      Object.entries(m)
        .filter(([, v]) => v.length > 0)
        .map(([k, v]) => [k, [...v].sort()] as const)
        .sort(([a], [b]) => a.localeCompare(b)),
    );
  return JSON.stringify({
    grantedScopes: [...p.grantedScopes].sort(),
    groups: map(p.groups),
    accounts: map(p.accounts),
    bundles: p.bundles.map((b) => ({ ...b, scopes: [...b.scopes].sort() })),
    groupBundles: map(p.groupBundles),
    accountBundles: map(p.accountBundles),
  });
}

export function policyChanged(a: EditablePolicy, b: EditablePolicy): boolean {
  return normalize(a) !== normalize(b);
}
