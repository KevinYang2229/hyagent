/** 相機與結果頁之間傳遞辨識結果（照片與結果物件太大，不放路由參數）。 */
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import type { ShelfResult } from '@/api/types';
import type { CouponView } from './coupon';
import type { Photo } from './types';

export interface ShelfEntry {
  photo: Photo;
  result: ShelfResult;
}

export interface CouponEntry {
  /** 掃條碼時沒有照片 */
  photo?: Photo;
  view: CouponView;
}

interface VisionResults {
  shelf: ShelfEntry | null;
  setShelf(v: ShelfEntry | null): void;
  coupon: CouponEntry | null;
  setCoupon(v: CouponEntry | null): void;
}

const Ctx = createContext<VisionResults | null>(null);

export function VisionResultProvider({ children }: { children: ReactNode }) {
  const [shelf, setShelf] = useState<ShelfEntry | null>(null);
  const [coupon, setCoupon] = useState<CouponEntry | null>(null);
  const value = useMemo(() => ({ shelf, setShelf, coupon, setCoupon }), [shelf, coupon]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useVisionResults(): VisionResults {
  const v = useContext(Ctx);
  if (!v) throw new Error('useVisionResults 必須在 VisionResultProvider 內使用');
  return v;
}
