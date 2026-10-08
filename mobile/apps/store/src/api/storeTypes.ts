/** 門市領域的回應型別：貨架／優惠券辨識、今日重點、補貨單。 */
import type { DisplayBlock } from '@hyagent/shared';

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
