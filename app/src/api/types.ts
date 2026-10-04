/** App 用到的後端回應型別；確認卡片、表格、使用者等共用型別來自 @hyagent/shared。 */
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

export type ShelfStatus = 'out_of_stock' | 'expiring' | 'misplaced' | 'ok';

export interface ShelfFinding {
  name: string;
  productId?: string;
  status: ShelfStatus;
  /** 0–1 相對座標 */
  box: { x: number; y: number; w: number; h: number };
  stock?: number;
  image?: string;
  suggestedQty?: number;
  expiryDate?: string;
  note?: string;
}

export interface ShelfResult {
  mode: 'shelf';
  findings: ShelfFinding[];
  counts: { outOfStock: number; expiring: number; misplaced: number };
  replenishment?: { toolId: string; input: Record<string, unknown> };
  warnings?: string[];
}

export interface CouponResult {
  mode: 'coupon';
  extracted: { code?: string; title?: string; expiry?: string };
  result?: Record<string, unknown>;
  block?: DisplayBlock;
  message?: string;
  warnings?: string[];
}

export interface InvokeResult<T> {
  result: T;
  block?: DisplayBlock;
}

export interface StoreTodaySummary {
  lowStock: { count: number; names: string[] };
  expiring: { count: number; names: string[] };
  equipmentAlerts: { count: number; items: { name: string; issue: string }[] };
  replenishmentsToday: { count: number };
}

export interface ReplenishmentOrder {
  id: string;
  createdAt: string;
  arrivalDate: string;
  itemCount: number;
  summary: string;
  items: { productId: string; name: string; quantity: number }[];
}
