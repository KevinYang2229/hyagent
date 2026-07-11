/** Email 工具：把 EmailConnector.send 包成工具。scope email:write；不暴露給 Agent（第一版不自主寄信）。 */
import { getConnector } from '@/lib/connectors';
import type { EmailSendInput, EmailSendResult } from '@/lib/email/types';
import { registerTool } from './tool.registry';

registerTool({
  id: 'email.send',
  description: '寄送一封 HTML 通知信給指定收件者。',
  inputSchema: {
    type: 'object',
    properties: {
      to: { type: 'string' },
      subject: { type: 'string' },
      html: { type: 'string' },
    },
    required: ['to', 'subject', 'html'],
    additionalProperties: false,
  },
  scopes: ['email:write'],
  audit: true,
  auditSummary: (input: EmailSendInput) => `收件人 ${input.to}｜主旨 ${input.subject}`,
  handler: (input: EmailSendInput): Promise<EmailSendResult> => getConnector('email').send(input),
});

/** email.propose：擬一封通知信草稿（不會立即寄出）；供 Agent 出示給使用者、待其確認後才送。 */
registerTool({
  id: 'email.propose',
  description: '擬一封通知信草稿（不會立即寄出）；供 Agent 出示給使用者、待其確認後才送。',
  inputSchema: {
    type: 'object',
    properties: {
      to: { type: 'string' },
      subject: { type: 'string' },
      html: { type: 'string' },
    },
    required: ['to', 'subject', 'html'],
    additionalProperties: false,
  },
  agentExposed: true,
  scopes: ['email:write'],
  // 不寄：只回草稿。實際寄出由 Agent 確認閘以 email.send 觸發。
  handler: (input: { to: string; subject: string; html: string }) =>
    Promise.resolve({ proposed: true, draft: input }),
});
