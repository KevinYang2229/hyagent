/** Email 連接器抽象。真 SMTP 由 smtp.connector 實作；stub 供 demo/測試零依賴。 */
export interface EmailSendInput {
  to: string;
  subject: string;
  html: string;
}
export interface EmailSendResult {
  messageId: string;
  status: 'sent' | 'queued' | 'failed';
}
export interface EmailConnector {
  readonly name: string;
  send(input: EmailSendInput): Promise<EmailSendResult>;
}
