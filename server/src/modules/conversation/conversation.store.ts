/**
 * Session store（MVP）：記憶體 Map ＋ 磁碟持久化。
 *
 * 持久化原因：dev 用 `tsx watch`，存檔（甚至 Google Drive 背景同步碰檔）都會重啟
 * 進程，純記憶體 store 會讓進行中的對話消失。改寫到 OS 暫存目錄的 JSON 檔，
 * 跨重啟仍留得住，使用者得以持續對話、完成表單。
 *
 * 檔案放 os.tmpdir()（專案目錄之外）：避免落在 tsx 監看路徑或 Drive 同步範圍而引發
 * 重啟迴圈。之後接 Prisma / Redis 只要換掉這層，介面不變。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { dataFile } from '@/lib/data-dir';
import { logger } from '@/lib/logger';
import { AppError } from '@/utils/app-error';
import type { Session } from './conversation.types';

const STORE_FILE = dataFile('oa-agent-sessions.json');

const sessions = new Map<string, Session>();

// 啟動時載入既有 session（壞檔則略過，等同空 store）
try {
  if (fs.existsSync(STORE_FILE)) {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8')) as Session[];
    for (const s of raw) sessions.set(s.id, s);
    logger.info({ count: sessions.size, file: STORE_FILE }, 'sessions restored from disk');
  }
} catch (err) {
  logger.warn({ err, file: STORE_FILE }, 'failed to restore sessions; starting empty');
}

// 將整個 map 寫回磁碟（持久化失敗不影響當前請求流程）
function persist(): void {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify([...sessions.values()]));
  } catch (err) {
    logger.warn({ err, file: STORE_FILE }, 'failed to persist sessions');
  }
}

export const conversationStore = {
  create(tenantId: string, userId: string, formId: string): Session {
    const session: Session = {
      id: randomUUID(),
      tenantId,
      userId,
      formId,
      values: {},
      status: 'collecting',
      messages: [],
      createdAt: new Date().toISOString(),
    };
    sessions.set(session.id, session);
    persist();
    return session;
  },

  get(id: string, tenantId: string, userId: string): Session {
    const session = sessions.get(id);
    if (!session) throw AppError.notFound('Conversation not found');
    // 租戶隔離：跨租戶一律當作不存在（不洩漏其他租戶有此 id）。
    // 既有磁碟資料無 tenantId → 視為預設租戶，維持向後相容。
    if ((session.tenantId ?? 'default') !== tenantId) throw AppError.notFound('Conversation not found');
    if (session.userId !== userId) throw AppError.forbidden('Not your conversation');
    return session;
  },

  /**
   * 將 session 目前狀態 flush 到磁碟。
   * 呼叫端拿到的是 map 內同一個物件參照、會就地 mutate，故在每輪/每次變更後呼叫此方法。
   */
  save(_session?: Session): void {
    persist();
  },
};
