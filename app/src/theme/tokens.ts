/** 設計 token：照平板設計稿（綠色主色、柔和圓角卡片）。 */
import type { DisplayTone } from '@hyagent/shared';

export const colors = {
  primary: '#2E7D5B',
  primaryDark: '#1D6B47',
  primarySoft: '#E3F3EA',
  bg: '#F4F8F6',
  surface: '#FFFFFF',
  border: '#E3E8E5',
  text: '#1F2D27',
  textMuted: '#5B6B63',
  danger: '#D93B30',
  dangerSoft: '#FDECEA',
  warning: '#E88A1A',
  warningSoft: '#FFF4E0',
  info: '#2F6FE4',
  infoSoft: '#E8F0FE',
  misplaced: '#7C3AED',
  misplacedSoft: '#F1E9FE',
  overlay: 'rgba(0,0,0,0.45)',
} as const;

export const radius = { sm: 8, md: 12, lg: 16, xl: 24, pill: 999 } as const;
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const font = { sm: 13, md: 15, lg: 17, xl: 20, xxl: 26 } as const;

export const shadow = {
  card: { shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 3 },
} as const;

export const toneColors: Record<DisplayTone, { fg: string; bg: string }> = {
  success: { fg: colors.primaryDark, bg: colors.primarySoft },
  warning: { fg: colors.warning, bg: colors.warningSoft },
  danger: { fg: colors.danger, bg: colors.dangerSoft },
  neutral: { fg: colors.textMuted, bg: '#EEF1EF' },
};
