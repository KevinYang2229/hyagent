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

/**
 * 解析「build 時 bake 進 bundle」的網址類環境變數，回傳去掉結尾斜線的值。
 *
 * Vite 的 `import.meta.env.VITE_*` 在「有定義但值為空」時拿到的是空字串而不是
 * undefined——Dockerfile 的 `ENV X=$X`（build arg 沒帶值）與 .env 的 `X=` 都會
 * 落在這個情況。`??` 只擋 null/undefined，攔不到空字串，預設值形同失效：
 * PREVIEW_ORIGIN 變成 '' 之後 postMessage 會直接丟
 * `SyntaxError: Invalid target origin '' in a call to 'postMessage'`。
 * 這裡把空字串／純空白／純斜線一律當成未設定。
 */
export function resolveOriginEnv(raw: string | undefined, fallback: string): string {
  return (raw ?? '').trim().replace(/\/+$/, '') || fallback;
}
