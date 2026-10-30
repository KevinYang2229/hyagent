/**
 * 權限頁「只有角色」的檢視：把舊的直接授權（租戶層 grantedScopes、部門 groups、帳號 accounts）
 * 換算成等效角色，與既有角色一起回給後台。
 *
 * 只在讀取時換算、不寫回：管理員按「儲存」前資料庫完全不動，換算結果與原授權的有效權限相同
 * （見 tests/role-view.test.ts 的等效性檢查）。儲存後直接授權清空、改由角色承載。
 *
 * 換算規則：每個 scope 先算出「給誰」（所有人／哪些部門／哪些帳號），給同一群對象的 scopes
 * 合成一個角色、指派給那群對象。每個對象拿到的正好是原本直接給它的 scopes，不多不少。
 * 給所有人的 scope 不再重複指派給個別部門或帳號（所有人已涵蓋）。
 */
import type { SkillBundle } from './scope-policy';
import { isKbScope, isMcpScope } from './scope-catalog';

export interface DirectGrants {
  grantedScopes: string[];
  groups: Record<string, string[]>;
  accounts: Record<string, string[]>;
}

export interface RoleAssignments {
  bundles: SkillBundle[];
  groupBundles: Record<string, string[]>;
  accountBundles: Record<string, string[]>;
  tenantBundles: string[];
}

export interface RoleView extends RoleAssignments {
  /** 這次由舊直接授權換算出來的角色 id（後台據此提示「由舊設定轉換」） */
  convertedRoleIds: string[];
}

/** 所有人層不可含 kb:／mcp:（會開給網站訪客）；resolve 端本來就會濾掉，換算時同步排除 */
const allowedForEveryone = (scope: string): boolean => !isKbScope(scope) && !isMcpScope(scope);

/** 穩定的短雜湊：同一群對象每次讀取都得到同一個角色 id，GET→PUT 冪等 */
function shortHash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

const NAME_MAX_TARGETS = 3;

export function toRoleView(
  direct: DirectGrants,
  roles: RoleAssignments,
  labels: { department: (id: string) => string; account: (id: string) => string },
): RoleView {
  const everyone = new Set(direct.grantedScopes.filter(allowedForEveryone));
  // scope → 對象 key 清單（d:部門、a:帳號）
  const targetsOf = new Map<string, Set<string>>();
  const add = (scope: string, key: string) => {
    if (everyone.has(scope)) return;
    if (!targetsOf.has(scope)) targetsOf.set(scope, new Set());
    targetsOf.get(scope)!.add(key);
  };
  for (const [dep, scopes] of Object.entries(direct.groups)) for (const s of scopes) add(s, `d:${dep}`);
  for (const [user, scopes] of Object.entries(direct.accounts)) for (const s of scopes) add(s, `a:${user}`);

  // 同一群對象 → 一組 scopes
  const byTargets = new Map<string, string[]>();
  for (const [scope, keys] of targetsOf) {
    const signature = [...keys].sort().join('|');
    byTargets.set(signature, [...(byTargets.get(signature) ?? []), scope]);
  }

  const bundles = roles.bundles.map((b) => ({ ...b, scopes: [...b.scopes] }));
  const groupBundles = Object.fromEntries(Object.entries(roles.groupBundles).map(([k, v]) => [k, [...v]]));
  const accountBundles = Object.fromEntries(Object.entries(roles.accountBundles).map(([k, v]) => [k, [...v]]));
  const tenantBundles = [...roles.tenantBundles];
  const usedIds = new Set(bundles.map((b) => b.id));
  const convertedRoleIds: string[] = [];

  const newId = (signature: string): string => {
    let id = `legacy-${shortHash(signature)}`;
    for (let n = 2; usedIds.has(id); n += 1) id = `legacy-${shortHash(signature)}-${n}`;
    usedIds.add(id);
    return id;
  };

  if (everyone.size > 0) {
    const id = newId('everyone');
    bundles.push({ id, name: '全體人員', description: '由舊版「全租戶」設定轉換', scopes: [...everyone] });
    tenantBundles.push(id);
    convertedRoleIds.push(id);
  }

  for (const [signature, scopes] of byTargets) {
    const keys = signature.split('|');
    const names = keys.map((k) => (k.startsWith('d:') ? labels.department(k.slice(2)) : labels.account(k.slice(2))));
    const shown = names.length > NAME_MAX_TARGETS
      ? `${names.slice(0, NAME_MAX_TARGETS).join('、')} 等 ${names.length} 個`
      : names.join('、');
    const id = newId(signature);
    bundles.push({ id, name: `個別授權：${shown}`, description: '由舊版「指定對象」設定轉換', scopes });
    convertedRoleIds.push(id);
    for (const key of keys) {
      const target = key.slice(2);
      const map = key.startsWith('d:') ? groupBundles : accountBundles;
      map[target] = [...(map[target] ?? []), id];
    }
  }

  return { bundles, groupBundles, accountBundles, tenantBundles, convertedRoleIds };
}
