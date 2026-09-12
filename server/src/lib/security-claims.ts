/** Atomic, durable claims. Never fail open or expire submission claims automatically. */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '@/config/env';
import { dataFile } from './data-dir';
import { connectDb } from './db';

function filename(key: string): string {
  const dir = dataFile('oa-agent-security-claims');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, createHash('sha256').update(key).digest('hex'));
}

export const securityClaims = {
  async claim(key: string): Promise<boolean> {
    if (env.DATA_BACKEND === 'db') {
      const db = await connectDb();
      const count = await db.$executeRaw`INSERT INTO security_claims (key) VALUES (${key}) ON CONFLICT (key) DO NOTHING`;
      return count === 1;
    }
    try {
      const fd = fs.openSync(filename(key), 'wx', 0o600);
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw err;
    }
  },
  async has(key: string): Promise<boolean> {
    if (env.DATA_BACKEND === 'db') {
      const db = await connectDb();
      const rows = await db.$queryRaw<Array<{ key: string }>>`SELECT key FROM security_claims WHERE key = ${key}`;
      return rows.length > 0;
    }
    try { fs.statSync(filename(key)); return true; }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  },
};
