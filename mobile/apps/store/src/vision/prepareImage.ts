/** 上傳前處理：長邊縮到 1600（較小不放大）、轉 JPEG 品質 0.8，確保在 5MB 上限內。 */
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import type { Photo } from './types';

export const MAX_EDGE = 1600;

export function resizeFor(width: number, height: number, max: number = MAX_EDGE): { width: number } | { height: number } | null {
  if (Math.max(width, height) <= max) return null;
  return width >= height ? { width: max } : { height: max };
}

export async function prepareImage(src: Photo): Promise<Photo> {
  const ctx = ImageManipulator.manipulate(src.uri);
  const r = resizeFor(src.width, src.height);
  if (r) ctx.resize(r);
  const img = await ctx.renderAsync();
  const out = await img.saveAsync({ compress: 0.8, format: SaveFormat.JPEG });
  return { uri: out.uri, width: out.width, height: out.height };
}
