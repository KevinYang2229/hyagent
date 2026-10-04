/** 今日重點卡片：由門市 store_today_summary 結果組成；點擊帶問題進 AI 對話或到任務分頁。 */
import type { StoreTodaySummary } from '@/api/types';

export type CardAction = { kind: 'ask'; q: string } | { kind: 'tasks' };

export interface SummaryCard {
  key: 'lowStock' | 'expiring' | 'equipment' | 'replenishments';
  count: number;
  title: string;
  detail: string;
  tone: 'danger' | 'warning' | 'equipment' | 'info';
  icon: 'trending-down' | 'alarm-outline' | 'construct-outline' | 'clipboard-outline';
  action: CardAction;
}

export function summaryCards(s: StoreTodaySummary): SummaryCard[] {
  const eq = s.equipmentAlerts.items[0];
  return [
    {
      key: 'lowStock', count: s.lowStock.count, title: '商品庫存偏低', tone: 'danger', icon: 'trending-down',
      detail: s.lowStock.count > 0 ? s.lowStock.names.slice(0, 3).join('・') : '庫存都充足',
      action: { kind: 'ask', q: '哪些商品庫存偏低？' },
    },
    {
      key: 'expiring', count: s.expiring.count, title: '即期品需要處理', tone: 'warning', icon: 'alarm-outline',
      detail: s.expiring.count > 0 ? '有效期限 1 天內' : '目前沒有即期品',
      action: { kind: 'ask', q: '今天有哪些即期品？' },
    },
    {
      key: 'equipment', count: s.equipmentAlerts.count, title: '設備異常', tone: 'equipment', icon: 'construct-outline',
      detail: eq ? `${eq.name}${eq.issue}` : '設備運作正常',
      action: { kind: 'ask', q: eq ? `${eq.name}${eq.issue}怎麼處理？` : '設備故障怎麼排除？' },
    },
    {
      key: 'replenishments', count: s.replenishmentsToday.count, title: '今日補貨單', tone: 'info', icon: 'clipboard-outline',
      detail: '點此查看補貨單',
      action: { kind: 'tasks' },
    },
  ];
}

export function greeting(hour: number): string {
  if (hour < 11) return '早安';
  if (hour < 18) return '午安';
  return '晚安';
}

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];

export function formatMonthDay(d: Date): string {
  return `${d.getMonth() + 1}/${d.getDate()}（${WEEKDAY[d.getDay()]}）`;
}
