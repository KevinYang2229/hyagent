/**
 * 租戶管理者檢視公鑰紀錄時，看不到別人的來源 IP：
 * KeyOperator.ip 只保留給「操作者就是自己」的紀錄，其餘拿掉 ip、留 via。
 * 超級管理者與 x-admin-key 的回應不變。回傳新物件，不改動 store 內的紀錄。
 */
import type { AdminPrincipal } from '@/middlewares/require-admin';
import type { KeyOperator, TenantPublicKey } from '@/modules/tenant/tenant.types';

type Locals = { adminPrincipal?: AdminPrincipal } | undefined;

function redactOperator(op: KeyOperator | undefined, self: string): KeyOperator | undefined {
  if (!op || op.via === self || op.ip === undefined) return op;
  const { ip: _ip, ...rest } = op;
  return rest;
}

export function redactKeyOperators<K extends TenantPublicKey>(key: K, locals: Locals): K;
export function redactKeyOperators<K extends TenantPublicKey>(key: K | undefined, locals: Locals): K | undefined;
export function redactKeyOperators<K extends TenantPublicKey>(key: K | undefined, locals: Locals): K | undefined {
  const principal = locals?.adminPrincipal;
  if (!key || principal?.kind !== 'tenant-admin') return key;
  const self = `tenant-admin:${principal.account.id}`;
  const next: K = { ...key };
  const created = redactOperator(key.createdBy, self);
  const revoked = redactOperator(key.revokedBy, self);
  if (created) next.createdBy = created;
  if (revoked) next.revokedBy = revoked;
  return next;
}

export function redactKeyList<K extends TenantPublicKey>(keys: K[], locals: Locals): K[] {
  return keys.map((k) => redactKeyOperators(k, locals));
}
