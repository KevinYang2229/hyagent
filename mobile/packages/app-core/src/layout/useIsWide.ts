import { useWindowDimensions } from 'react-native';

/** 寬度達此值走平板左右兩欄，否則單欄 */
export const WIDE_BREAKPOINT = 900;

export function isWide(width: number): boolean {
  return width >= WIDE_BREAKPOINT;
}

export function useIsWide(): boolean {
  const { width } = useWindowDimensions();
  return isWide(width);
}
