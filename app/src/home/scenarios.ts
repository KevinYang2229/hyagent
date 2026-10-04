/** 首頁常用情境：點擊帶入問題到 AI 對話。 */
import { colors } from '@/theme/tokens';

export const SCENARIOS = [
  { label: '查詢庫存', icon: 'cart-outline', color: colors.warning, q: '幫我查庫存' },
  { label: '建立補貨單', icon: 'cube-outline', color: colors.warning, q: '哪些商品需要補貨？' },
  { label: '即期品管理', icon: 'time-outline', color: colors.warning, q: '今天有哪些即期品？' },
  { label: '設備故障排除', icon: 'construct-outline', color: colors.info, q: '設備故障怎麼排除？' },
  { label: '促銷活動查詢', icon: 'megaphone-outline', color: colors.info, q: '現在有什麼活動？' },
  { label: '會員活動', icon: 'people-outline', color: colors.misplaced, q: '現在有什麼會員活動？' },
] as const;
