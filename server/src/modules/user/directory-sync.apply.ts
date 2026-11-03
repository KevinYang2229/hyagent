/**
 * 人員同步事件的套用邏輯（純函式，不碰儲存層與 Session）。
 * 規則見 docs/superpowers/specs/2026-11-03-directory-provisioning-sync-design.md §5。
 */
import { z } from 'zod';
import { isStorableText } from '@/modules/user/directory-text';
import type { DirectoryEntry } from '@/modules/tenant/tenant.types';

export type SyncResult = { eventId: string; status: 'applied' | 'stale' | 'rejected'; reason?: string };

const MAX_DIRECTORY_USERS = 10000;
const MAX_USER_ID_LENGTH = 200;
const MAX_FUTURE_SKEW_MS = 5 * 60_000;
const TOMBSTONE_TTL_MS = 30 * 86_400_000;

// 欄位限制與 user.admin.ts 的 profile 相同；strict 避免 OA 夾帶 origin／deputyIds 等內部欄位
const syncUser = z.object({
  id: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(200),
  department: z.string().trim().min(1).max(200),
  title: z.string().max(200).optional(),
  company: z.string().max(200).optional(),
  email: z.string().email().optional(),
}).strict();

function parseTime(v: unknown): number {
  return typeof v === 'string' ? Date.parse(v) : NaN;
}

export function applyDirectoryEvents(input: {
  users: DirectoryEntry[];
  tombstones: Record<string, string>;
  events: unknown[];
  nowMs: number;
}): {
  users: DirectoryEntry[];
  tombstones: Record<string, string>;
  results: SyncResult[];
  /** 呼叫端要清除個人授權並作廢 Session 的人（applied 的 delete，以及重送相同時間的 delete）。 */
  revokeUserIds: string[];
  changed: boolean;
} {
  const { nowMs } = input;
  // 工作副本：只替換項目、不改動輸入物件
  const users = new Map<string, DirectoryEntry>(input.users.map((u) => [u.id, u]));
  const tombstones: Record<string, string> = {};
  let changed = false;

  for (const [id, at] of Object.entries(input.tombstones)) {
    const ms = Date.parse(at);
    if (Number.isFinite(ms) && nowMs - ms <= TOMBSTONE_TTL_MS) tombstones[id] = at;
    else changed = true;
  }

  const results: SyncResult[] = [];
  const revoke = new Set<string>();

  /** 該人目前已知的最晚時間（syncedAt 與刪除紀錄取大），沒有則為 -Infinity。 */
  const knownAt = (id: string): number => {
    const synced = parseTime(users.get(id)?.syncedAt);
    const dead = parseTime(tombstones[id]);
    return Math.max(Number.isFinite(synced) ? synced : -Infinity, Number.isFinite(dead) ? dead : -Infinity);
  };

  for (const raw of input.events) {
    const ev = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const eventId = typeof ev.eventId === 'string' ? ev.eventId : '';
    const reject = (reason: string) => results.push({ eventId, status: 'rejected', reason });

    if (!eventId || (ev.type !== 'user.upserted' && ev.type !== 'user.deleted')) { reject('INVALID_EVENT'); continue; }
    const at = parseTime(ev.occurredAt);
    if (!Number.isFinite(at) || at > nowMs + MAX_FUTURE_SKEW_MS) { reject('INVALID_OCCURRED_AT'); continue; }
    const atIso = new Date(at).toISOString();

    if (ev.type === 'user.upserted') {
      const parsed = syncUser.safeParse(ev.user);
      if (!parsed.success) { reject('INVALID_USER'); continue; }
      const u = parsed.data;
      if (![u.id, u.name, u.department, u.title, u.company].every((v) => v === undefined || isStorableText(v))) { reject('INVALID_USER'); continue; }
      if (at <= knownAt(u.id)) { results.push({ eventId, status: 'stale' }); continue; }
      const current = users.get(u.id);
      if (!current && users.size >= MAX_DIRECTORY_USERS) { reject('DIRECTORY_FULL'); continue; }
      // 整筆更新：沒帶的 title／company／email 一律清除（移除 key，不留 undefined）
      const { title: _t, company: _c, email: _e, ...kept } = current ?? ({} as DirectoryEntry);
      users.set(u.id, {
        ...kept,
        id: u.id, name: u.name, department: u.department,
        ...(u.title !== undefined ? { title: u.title } : {}),
        ...(u.company !== undefined ? { company: u.company } : {}),
        ...(u.email !== undefined ? { email: u.email } : {}),
        ...(current ? {} : { origin: 'sync' as const }),
        syncedAt: atIso,
      });
      changed = true;
      results.push({ eventId, status: 'applied' });
      continue;
    }

    const userId = typeof ev.userId === 'string' ? ev.userId.trim() : '';
    if (!userId || userId.length > MAX_USER_ID_LENGTH || !isStorableText(userId)) { reject('INVALID_EVENT'); continue; }
    const known = knownAt(userId);
    if (at <= known) {
      // 重送相同時間的 delete 仍要清個人授權、作廢 Session（上次可能寫入失敗）；此人已不在目錄才有意義
      if (at === parseTime(tombstones[userId]) && !users.has(userId)) revoke.add(userId);
      results.push({ eventId, status: 'stale' });
      continue;
    }
    users.delete(userId);
    for (const [id, entry] of users) {
      if (entry.deputyIds?.includes(userId)) users.set(id, { ...entry, deputyIds: entry.deputyIds.filter((d) => d !== userId) });
    }
    tombstones[userId] = atIso;
    revoke.add(userId);
    changed = true;
    results.push({ eventId, status: 'applied' });
  }

  return { users: [...users.values()], tombstones, results, revokeUserIds: [...revoke], changed };
}
