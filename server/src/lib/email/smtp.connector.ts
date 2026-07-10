/** SmtpEmailConnector：以 nodemailer 依 env SMTP_* 寄信。EMAIL_CONNECTOR=smtp 時使用。 */
import nodemailer from 'nodemailer';
import { env } from '@/config/env';
import { logger } from '@/lib/logger';
import type { EmailConnector, EmailSendInput, EmailSendResult } from './types';

let transporter: nodemailer.Transporter | null = null;
function getTransporter(): nodemailer.Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    });
  }
  return transporter;
}

export const smtpEmailConnector: EmailConnector = {
  name: 'smtp',
  async send(input: EmailSendInput): Promise<EmailSendResult> {
    const info = await getTransporter().sendMail({
      from: env.MAIL_FROM,
      to: input.to,
      subject: input.subject,
      html: input.html,
    });
    logger.info({ messageId: info.messageId, to: input.to }, '[email:smtp] sent');
    return { messageId: info.messageId, status: 'sent' };
  },
};
