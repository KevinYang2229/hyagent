/**
 * 附件儲存區：記憶體 Map（metadata + 二進位內容）＋ db 模式 write-through。
 *
 * 設計取捨：
 * - 表單值（session.values.attachments）只存輕量 metadata（id/name/mime/size），隨
 *   conversation.store 持久化；檔案 bytes 不該進那份 JSON，獨立放這裡。
 * - db 模式：bytes 同步寫入 Postgres attachments 表（write-through），重啟/重佈後檔案
 *   仍在——供將來真 OA 送出時取用。單檔上限 10MB（upload middleware 守），量大改接
 *   S3/R2 時只換這層。孤兒列（session 已清）由 conversation.store 的清理作業回收。
 * - 讀取（get）維持記憶體：目前無任何呼叫端讀 bytes；真 OA 串接需要跨重啟讀檔時，
 *   把 get 改成 async 從 DB 撈即可（介面接縫已留）。
 * - 以 sessionId 分群，方便對話取消／送出後一次清掉該對話的所有暫存附件。
 */
import { randomUUID } from 'node:crypto';
import type { Attachment } from '@hyagent/shared';
import { DbWriteQueue } from '@/lib/db';
import { env } from '@/config/env';

export type { Attachment };

/** 儲存區內單一附件（metadata + 內容） */
interface StoredAttachment extends Attachment {
  sessionId: string;
  buffer: Buffer;
}

const files = new Map<string, StoredAttachment>();

const writeQueue = new DbWriteQueue('attachments');

export const attachmentStore = {
  /** 存入一個檔案，回傳對外的 metadata（不含 buffer） */
  save(
    sessionId: string,
    input: { name: string; mime: string; buffer: Buffer },
  ): Attachment {
    const id = randomUUID();
    const stored: StoredAttachment = {
      id,
      sessionId,
      name: input.name,
      mime: input.mime,
      size: input.buffer.length,
      buffer: input.buffer,
    };
    files.set(id, stored);
    if (env.DATA_BACKEND === 'db') {
      writeQueue.enqueue(async (db) => {
        await db.attachmentRow.create({
          data: {
            id,
            sessionId,
            name: stored.name,
            mime: stored.mime,
            size: stored.size,
            content: stored.buffer,
          },
        });
      });
    }
    return toMeta(stored);
  },

  /** 取單一附件（含內容）；不存在或不屬於該對話則回 undefined */
  get(sessionId: string, id: string): StoredAttachment | undefined {
    const item = files.get(id);
    if (!item || item.sessionId !== sessionId) return undefined;
    return item;
  },

  /** 刪除單一附件；回傳是否刪除成功（存在且屬於該對話） */
  remove(sessionId: string, id: string): boolean {
    const item = files.get(id);
    if (!item || item.sessionId !== sessionId) return false;
    if (env.DATA_BACKEND === 'db') {
      writeQueue.enqueue(async (db) => {
        await db.attachmentRow.deleteMany({ where: { id, sessionId } });
      });
    }
    return files.delete(id);
  },

  /** 清掉某對話的所有暫存附件（取消／送出後呼叫，避免記憶體累積） */
  clearSession(sessionId: string): void {
    for (const [id, item] of files) {
      if (item.sessionId === sessionId) files.delete(id);
    }
    if (env.DATA_BACKEND === 'db') {
      writeQueue.enqueue(async (db) => {
        await db.attachmentRow.deleteMany({ where: { sessionId } });
      });
    }
  },
};

function toMeta(item: StoredAttachment): Attachment {
  return { id: item.id, name: item.name, mime: item.mime, size: item.size };
}
