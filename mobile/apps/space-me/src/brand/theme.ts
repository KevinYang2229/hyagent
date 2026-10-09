/** SpaceMe 品牌色：照設計稿的亮藍主色、淡藍底與深藍標題。 */
export const sm = {
  blue: '#2F6BFF',
  blueDark: '#1F4FD8',
  blueSoft: '#EAF1FF',
  blueMist: '#F5F8FF',
  navy: '#0E1B45',
  ink: '#14213D',
  inkSoft: '#4A5675',
  muted: '#7A86A3',
  line: '#E3EAF7',
  card: '#FFFFFF',
  danger: '#D93B30',
} as const;

/** 解決方案與特色圖示的配色（圖示色、淺底色） */
export const tints = {
  purple: { fg: '#7A4DF0', bg: '#F1EBFF' },
  blue: { fg: '#2F6BFF', bg: '#EAF1FF' },
  green: { fg: '#2BAE73', bg: '#E5F7EE' },
  orange: { fg: '#F08A24', bg: '#FFF1E2' },
} as const;

export type Tint = keyof typeof tints;

export const shadow = {
  card: { shadowColor: '#1F3A8A', shadowOpacity: 0.08, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 3 },
} as const;
