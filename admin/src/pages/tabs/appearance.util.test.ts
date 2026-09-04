import { describe, expect, it } from 'vitest';
import { resolveOriginEnv, resolvePrimaryColor, WIDGET_DEFAULT_PRIMARY } from './appearance.util';

describe('resolvePrimaryColor', () => {
  it('有設定就用設定值', () => {
    expect(resolvePrimaryColor({ primaryColor: '#ff0000' })).toBe('#ff0000');
  });

  // 先前後台寫死 #4f46e5，widget 實際渲染的是設計系統的 #0060d5，
  // 於是「未設定主色」的租戶一重整，色票和即時預覽就對不起來。
  it('未設定時用 widget 淺色主題的實際預設，不是後台自己的色', () => {
    expect(resolvePrimaryColor({})).toBe('#0060d5');
    expect(resolvePrimaryColor({ theme: 'light' })).toBe('#0060d5');
  });

  it('未設定且深色主題時用深色預設', () => {
    expect(resolvePrimaryColor({ theme: 'dark' })).toBe('#22bafb');
  });

  it('預設值需與設計系統 ui/index.css 的 --primary-color 同步', () => {
    expect(WIDGET_DEFAULT_PRIMARY).toEqual({ light: '#0060d5', dark: '#22bafb' });
  });
});

describe('resolveOriginEnv', () => {
  it('有值就用值，並去掉結尾斜線', () => {
    expect(resolveOriginEnv('https://widget.example.com/', 'http://localhost:5173')).toBe(
      'https://widget.example.com',
    );
  });

  it('沒定義時退回預設', () => {
    expect(resolveOriginEnv(undefined, 'http://localhost:5173')).toBe('http://localhost:5173');
  });

  // 這是線上後台「外觀」分頁炸掉的成因：Dockerfile 的 `ENV X=$X`（build arg 沒帶值）
  // 與 .env 的 `X=` 都會讓 Vite bake 出空字串而非 undefined，`??` 攔不到，
  // PREVIEW_ORIGIN 變成 ''，postMessage 就丟
  // SyntaxError: Invalid target origin '' in a call to 'postMessage'。
  it('有定義但為空字串時視同未設定，退回預設', () => {
    expect(resolveOriginEnv('', 'http://localhost:5173')).toBe('http://localhost:5173');
  });

  it('只有空白或只有斜線時也視同未設定', () => {
    expect(resolveOriginEnv('   ', 'http://localhost:5173')).toBe('http://localhost:5173');
    expect(resolveOriginEnv('/', 'http://localhost:5173')).toBe('http://localhost:5173');
  });
});
