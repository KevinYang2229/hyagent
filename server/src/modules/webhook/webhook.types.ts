/**
 * Webhook（表單結果回拋）型別。
 *
 * 每租戶可登記一或多個端點；表單送出成功後，以行內非同步方式投遞事件（含 HMAC 簽章）。
 */
import type { SubmissionInfo } from '@hyagent/shared';
import type { FormValues } from '@/modules/form/form.types';

export type WebhookEventType = 'form.submitted';

export interface WebhookEndpoint {
  id: string;
  tenantId: string;
  /** 接收端 URL */
  url: string;
  /** HMAC 簽章密鑰（接收端用同一把驗章） */
  secret: string;
  /** 訂閱的事件型別；空陣列／未設＝全部 */
  events?: WebhookEventType[];
  createdAt: string;
  /** 停用時間；有值則不再投遞 */
  disabledAt?: string;
}

export interface WebhookEvent {
  id: string;
  type: WebhookEventType;
  tenantId: string;
  createdAt: string;
  data: {
    conversationId: string;
    formId: string;
    userId: string;
    values: FormValues;
    submission: SubmissionInfo;
  };
}
