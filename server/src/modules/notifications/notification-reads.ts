import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { env } from '@/config/env';
import { dataFile } from '@/lib/data-dir';
import { connectDb } from '@/lib/db';

function pathFor(tenantId: string, userId: string) {
  const key = createHash('sha256').update(JSON.stringify([tenantId, userId])).digest('hex');
  return dataFile(`notification-reads/${key}.json`);
}
export async function readReceipts(tenantId: string, userId: string): Promise<Set<string>> {
  if (env.DATA_BACKEND === 'db') {
    const db = await connectDb();
    const rows = await db.$queryRaw<Array<{ notification_id: string }>>`
      select notification_id from notification_reads where tenant_id = ${tenantId} and user_id = ${userId}`;
    return new Set(rows.map((r) => r.notification_id));
  }
  const path = pathFor(tenantId, userId);
  return new Set(existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as string[] : []);
}
export async function markReceipts(tenantId: string, userId: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  if (env.DATA_BACKEND === 'db') {
    const db = await connectDb();
    await db.$executeRaw`
      insert into notification_reads (tenant_id, user_id, notification_id)
      select ${tenantId}, ${userId}, unnest(${ids}::text[])
      on conflict do nothing`;
    return;
  }
  // Synchronous read/merge/atomic rename avoids lost updates between concurrent requests.
  const path = pathFor(tenantId, userId);
  const current: string[] = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as string[] : [];
  const next = [...new Set([...current, ...ids])];
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
  renameSync(temporary, path);
}
