/** 相機與結果頁之間傳遞辨識結果（照片與結果物件太大，不放路由參數）；登出時清空。 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useSignedOutReset } from '@hyagent/app-core/auth/useSignedOutReset';
import type { ShelfResult } from '@/api/storeTypes';
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
  // 登出就丟掉上一位使用者的辨識結果（含照片）
  const clear = useCallback(() => {
    setShelf(null);
    setCoupon(null);
  }, []);
  useSignedOutReset(clear);
  const value = useMemo(() => ({ shelf, setShelf, coupon, setCoupon }), [shelf, coupon]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useVisionResults(): VisionResults {
  const v = useContext(Ctx);
  if (!v) throw new Error('useVisionResults 必須在 VisionResultProvider 內使用');
  return v;
}
