/**
 * OA 連接器抽象。真 OA API 規格未定，先以 stub 實作；介面固定，之後抽換真連接器不動上層。
 *
 * 送出採通用 submitForm：上層提供 formId、表單的 oa schema 與來源欄位（表單值 + 衍生 context），
 * 連接器內以 oa.mapper 依 schema 組 body / 解析回應。新增表單不必加方法。
 */

import type { Attachment, LeaveBalance, OASchema } from '@hyagent/shared';

export type { Attachment, LeaveBalance, OASchema };

export interface OASubmitResult {
  oaRequestId: string;
  status: 'accepted' | 'pending' | 'rejected';
  raw?: unknown;
}

/** 通用送出輸入：來源 = 表單值 merge 衍生欄位（如 userId / hours / region） */
export interface OASubmitInput {
  formId: string;
  oa: OASchema;
  source: Record<string, unknown>;
}

export interface OAConnector {
  readonly name: string;
  submitForm(input: OASubmitInput): Promise<OASubmitResult>;
  getLeaveBalance?(userId: string): Promise<LeaveBalance[]>;
}
