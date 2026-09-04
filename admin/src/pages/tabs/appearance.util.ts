/**
 * 外觀分頁的純函式。主色的「未設定預設值」必須與 widget（client）實際渲染的
 * 預設一致，否則後台顯示的色票和右側即時預覽會對不起來。
 */
import type { TenantAppearance } from '@hyagent/shared';

/**
 * widget 面板未設定 primaryColor 時實際採用的預設主色，依主題不同。
 * 來源是設計系統 `ui/index.css` 的 `--primary-color`（light / dark 兩組），
 * 改那裡要一併改這裡。
 */
export const WIDGET_DEFAULT_PRIMARY = {
  light: '#0060d5',
  dark: '#22bafb',
} as const;

/** 後台色票／即時預覽共用的主色：未設定時退回 widget 對應主題的預設值 */
export function resolvePrimaryColor(appearance: TenantAppearance): string {
  return appearance.primaryColor ?? WIDGET_DEFAULT_PRIMARY[appearance.theme ?? 'light'];
}
