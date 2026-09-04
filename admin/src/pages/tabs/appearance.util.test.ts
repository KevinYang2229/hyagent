import { describe, expect, it } from 'vitest';
import { resolvePrimaryColor, WIDGET_DEFAULT_PRIMARY } from './appearance.util';

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
