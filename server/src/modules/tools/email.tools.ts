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
  handler: (input: EmailSendInput): Promise<EmailSendResult> => getConnector('email').send(input),
});
