/**
 * 批次匯入的租戶級互斥鎖。
 *
 * 同一個租戶同時被兩條匯入流程處理時，整份資料會被完整匯入兩次、embedding 也付兩次錢，
 * 而且完全無聲——理由見 db/migrations/0008 的註解。這支模組就是補上那道「還有別人在
 * 匯入嗎」的詢問。
 *
 * 以資料表而非 pg_advisory_lock 實作：advisory lock 是 session 級，Prisma 的連線池
 * 預設不只一條連線，lock 與 unlock 可能落在不同 session 上，長駐 watcher 會在第二輪
 * 把自己鎖死。代價是崩潰後的殘留鎖要靠 TTL 回收。
 */
import { hostname } from 'node:os';
import { env } from '@/config/env';
import { connectDb } from '@/lib/db';
import { logger } from '@/lib/logger';

/**
 * 心跳逾時：超過這段時間沒更新即視為持有者已死，鎖可被接管。
 *
 * 必須明顯大於「處理單一檔案的時間」——每處理完一個檔才更新一次心跳，而一個數千列的
 * 試算表含 embedding 可能跑上五分鐘。取 15 分鐘留三倍餘裕：訂太短會讓正常的長匯入被
 * 另一支接管（就是這道鎖要防的事本身），訂太長則是崩潰後要多等一陣子才能重跑。
 */
export const LOCK_TTL_MINUTES = 15;

/** 持有者識別；純供人排查「是誰卡住了」，不參與正確性判斷 */
function holderId(): string {
  return `${hostname()}:${process.pid}`;
}

export interface IngestLock {
  tenantId: string;
  holder: string;
}

/**
 * 嘗試取得該租戶的匯入鎖；被別人持有時回 null（呼叫端應跳過該租戶，不是報錯）。
 *
 * 取得與接管在同一個 INSERT ... ON CONFLICT 內完成，所以「檢查是否過期」與「搶下來」
 * 是一次原子操作——分成先 SELECT 再 UPDATE 的話，兩個 process 會同時看到過期的鎖、
 * 同時判定可以接管，這道鎖就等於沒做。
 */
export async function acquireIngestLock(tenantId: string): Promise<IngestLock | null> {
  if (env.DATA_BACKEND !== 'db') return { tenantId, holder: 'file-backend' }; // 單一 process，無從併發
  const db = await connectDb();
  const holder = holderId();
  const rows = await db.$queryRaw<{ holder: string }[]>`
    insert into knowledge_ingest_locks (tenant_id, holder)
    values (${tenantId}, ${holder})
    on conflict (tenant_id) do update
      set holder = excluded.holder, acquired_at = now(), heartbeat_at = now()
      where knowledge_ingest_locks.heartbeat_at
            < now() - make_interval(mins => ${LOCK_TTL_MINUTES}::int)
    returning holder
  `;
  // 沒有回傳列 = ON CONFLICT 的 where 沒過 = 鎖仍被活著的持有者握著
  return rows.length > 0 ? { tenantId, holder } : null;
}

/**
 * 更新心跳。每處理完一個檔呼叫一次，讓長匯入不會被 TTL 誤判成殘留。
 * 帶 holder 條件：鎖若已被接管就不該再更新它，否則等於把別人的鎖續期。
 */
export async function renewIngestLock(lock: IngestLock): Promise<void> {
  if (env.DATA_BACKEND !== 'db') return;
  const db = await connectDb();
  await db.$executeRaw`
    update knowledge_ingest_locks set heartbeat_at = now()
    where tenant_id = ${lock.tenantId} and holder = ${lock.holder}
  `;
}

/**
 * 釋放鎖。帶 holder 條件：只刪自己的，避免鎖被接管後把新持有者的鎖誤刪。
 * 釋放失敗不拋錯——匯入本身已經完成，把它變成失敗只會讓呼叫端誤判；殘留鎖由 TTL 回收。
 */
export async function releaseIngestLock(lock: IngestLock): Promise<void> {
  if (env.DATA_BACKEND !== 'db') return;
  try {
    const db = await connectDb();
    await db.$executeRaw`
      delete from knowledge_ingest_locks
      where tenant_id = ${lock.tenantId} and holder = ${lock.holder}
    `;
  } catch (err) {
    logger.warn(
      { err, tenantId: lock.tenantId },
      `匯入鎖釋放失敗，將於 ${LOCK_TTL_MINUTES} 分鐘後由 TTL 回收`,
    );
  }
}
