/** 共用的後端回應型別；確認卡片、表格、使用者等共用型別來自 @hyagent/shared。各 App 的領域型別放在自己的程式裡。 */
import type { Applicant, DisplayBlock, PendingActionView, SessionStatus } from '@hyagent/shared';

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  user: Applicant;
}

export interface TurnData {
  status: SessionStatus;
  reply: string | null;
  suggestions?: string[];
  pendingAction?: PendingActionView;
  blocks?: DisplayBlock[];
  /** 確認端點回傳：執行是否成功 */
  actionOk?: boolean;
}

export interface StartData extends TurnData {
  id: string;
}

export interface UploadFile {
  uri: string;
  name: string;
  type: string;
}

export interface InvokeResult<T> {
  result: T;
  block?: DisplayBlock;
}
