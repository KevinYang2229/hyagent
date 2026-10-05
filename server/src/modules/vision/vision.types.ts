import type { DisplayBlock } from '@hyagent/shared';

export type VisionMediaType = 'image/jpeg' | 'image/png' | 'image/webp';
export type ShelfStatus = 'out_of_stock' | 'expiring' | 'misplaced' | 'ok';

export interface ShelfFinding {
  name: string;
  productId?: string;
  status: ShelfStatus;
  /** 0–1 相對座標（左上角 x,y 與寬高） */
  box: { x: number; y: number; w: number; h: number };
  stock?: number;
  /** 門市商品圖片網址（僅 http(s)），供確認卡片顯示縮圖 */
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
