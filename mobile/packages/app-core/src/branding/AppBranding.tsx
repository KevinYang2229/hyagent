/**
 * 各 App 的品牌與領域素材：共用元件（對話、確認彈窗）透過這裡取得吉祥物、語音範例與商品圖，
 * 不直接 import 某個 App 的素材。App 在根 layout 用 AppBrandingProvider 注入；沒注入時用中性預設。
 */
import { createContext, useContext, type ComponentType, type ReactNode } from 'react';
import type { ImageSourcePropType } from 'react-native';

export type MascotPose = 'wave' | 'mic' | 'idle';

export interface ImageLookup {
  productId?: unknown;
  name?: unknown;
  image?: unknown;
}

export interface ConfirmCompanion {
  text: string;
  image: ImageSourcePropType;
  label: string;
}

/** 對話元件（輸入列、使用者泡泡、複製／編輯按鈕）的主色 */
export interface BrandAccent {
  primary: string;
  primaryDark: string;
  primarySoft: string;
}

export interface AppBranding {
  /** 對話泡泡與助理面板旁的角色；沒有就不顯示 */
  Mascot?: ComponentType<{ pose: MascotPose; size: number }>;
  /** 助理面板「你可以說：」的範例句 */
  voiceExamples: string[];
  /** 表格與確認彈窗的縮圖來源；沒有就只用後端給的 http(s) 網址 */
  resolveImage(item: ImageLookup): ImageSourcePropType | undefined;
  /** 確認彈窗標頭：助理名稱與頭像 */
  confirmHeader?: { name: string; image: ImageSourcePropType };
  /** 平板寬度時確認彈窗旁的角色；依標題決定要不要出現 */
  confirmCompanion?(title: string): ConfirmCompanion | null;
  /** 對話元件主色；沒有就用 theme/tokens 的綠色 */
  accent?: BrandAccent;
}

/** 沒有本機素材時，後端給的 http(s) 圖片網址照用。 */
export function remoteImage(item: ImageLookup): ImageSourcePropType | undefined {
  return typeof item.image === 'string' && /^https?:\/\//i.test(item.image) ? { uri: item.image } : undefined;
}

export const defaultBranding: AppBranding = {
  voiceExamples: [],
  resolveImage: remoteImage,
};

const AppBrandingContext = createContext<AppBranding>(defaultBranding);

export function AppBrandingProvider({ value, children }: { value: AppBranding; children: ReactNode }) {
  return <AppBrandingContext.Provider value={value}>{children}</AppBrandingContext.Provider>;
}

export function useAppBranding(): AppBranding {
  return useContext(AppBrandingContext);
}
