/** Email 連接器：getConnector('email') 走 stub，send 回 STUB messageId 並記錄。 */
import { getConnector } from '@/lib/connectors';
import { stubSentEmails } from '@/lib/email/stub.connector';

describe('email 連接器（stub）', () => {
  beforeEach(() => {
    stubSentEmails.length = 0;
  });

  it("getConnector('email') 回具 send 的連接器", () => {
    const email = getConnector('email');
    expect(typeof email.send).toBe('function');
    expect(typeof email.name).toBe('string');
  });

  it('send 回 STUB messageId 並記錄寄件', async () => {
    const res = await getConnector('email').send({ to: 'a@x.com', subject: '嗨', html: '<p>hi</p>' });
    expect(res.messageId).toMatch(/^STUB-/);
    expect(res.status).toBe('sent');
    expect(stubSentEmails).toHaveLength(1);
    expect(stubSentEmails[0].to).toBe('a@x.com');
  });
});
