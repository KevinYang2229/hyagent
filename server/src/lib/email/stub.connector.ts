/** StubEmailConnector：不連 SMTP，記錄寄件並回合成 messageId，供 demo/測試檢視。 */
import { randomUUID } from 'node:crypto';
import { logger } from '@/lib/logger';
import type { EmailConnector, EmailSendInput, EmailSendResult } from './types';

/** 記憶體保存寄件，方便 demo 後檢視 / 測試斷言 */
export const stubSentEmails: EmailSendInput[] = [];

export const stubEmailConnector: EmailConnector = {
  name: 'stub',
  async send(input: EmailSendInput): Promise<EmailSendResult> {
    stubSentEmails.push(input);
    const messageId = `STUB-${randomUUID().slice(0, 8).toUpperCase()}`;
    logger.info({ messageId, to: input.to, subject: input.subject }, '[email:stub] sent');
    return { messageId, status: 'sent' };
  },
};
