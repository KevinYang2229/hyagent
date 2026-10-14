/**
 * Email 工具：把 EmailConnector.send 包成工具。scope email:write。
 * 暴露給 Agent 但標為寫入：Agent 呼叫時只會建立確認卡片，使用者確認後才由後端寄出。
 */
import { assertEmailEgress } from '@/lib/egress-policy';
import { getConnector } from '@/lib/connectors';
import type { EmailSendInput, EmailSendResult } from '@/lib/email/types';
import { registerTool } from './tool.registry';

registerTool({
  id: 'email.send',
  description: '寄送一封 HTML 通知信給指定收件者。',
  confirmTitle: '寄送 Email',
  inputSchema: {
    type: 'object',
    properties: {
      to: { type: 'string', title: '收件人' },
      subject: { type: 'string', title: '主旨' },
      html: { type: 'string', title: '內文', 'x-display': 'html' },
    },
    required: ['to', 'subject', 'html'],
    additionalProperties: false,
  },
  scopes: ['email:write'],
  agentExposed: true,
  effect: 'write',
  audit: true,
  // Do not copy blocked input (which may contain a secret) into the audit trail.
  auditSummary: () => '寄送 Email',
  handler: (input: EmailSendInput, ctx): Promise<EmailSendResult> => {
    assertEmailEgress(input, ctx.tenantId);
    return getConnector('email').send(input);
  },
});
