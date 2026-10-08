import type { ReplenishmentOrder, StoreTodaySummary } from '@/api/storeTypes';

export type TaskCategory = 'stock' | 'expiry' | 'equipment' | 'promotion';
export type TaskFilter = 'all' | 'pending' | 'submitted';
export interface StoreTask {
  id: string;
  title: string;
  category: TaskCategory;
  status: 'pending' | 'submitted';
  detail: string;
  question?: string;
  productName?: string;
  order?: ReplenishmentOrder;
}

/** 警示是待處理事項；送出補貨單不等於任務完成。 */
export function storeTasks(summary?: StoreTodaySummary, orders: ReplenishmentOrder[] = []): StoreTask[] {
  const tasks: StoreTask[] = [];
  if (summary) {
    for (const [category, data, fallback, question] of [
      ['stock', summary.lowStock, '缺貨商品需要補貨', '哪些商品庫存偏低？'],
      ['expiry', summary.expiring, '即期商品需要處理', '今天有哪些即期品？'],
    ] as const) {
      if (data.count > 0) {
        const names = data.names.length ? data.names : [fallback];
        names.forEach((name, index) => tasks.push({
          id: `${category}-${index}`, category, status: 'pending', title: name,
          productName: data.names.length ? name : undefined,
          detail: category === 'stock' ? '庫存偏低・需要補貨' : '即期品・確認效期與處理方式',
          question: data.names.length ? `${name}${category === 'stock' ? '庫存偏低，請幫我查詢並建議補貨數量' : '即將到期，應該怎麼處理？'}` : question,
        }));
      }
    }
    if (summary.equipmentAlerts.count > 0) {
      const equipment = summary.equipmentAlerts.items.length ? summary.equipmentAlerts.items : [{ name: '設備異常需要排除', issue: '請查詢設備狀況' }];
      equipment.forEach((item, index) => tasks.push({ id: `equipment-${index}`, category: 'equipment', status: 'pending', title: item.name, detail: item.issue, question: `${item.name}${item.issue}，請協助排除問題` }));
    }
  }
  orders.forEach((order) => tasks.push({ id: `order-${order.id}`, category: 'stock', status: 'submitted', title: order.summary || order.id, detail: `${order.id}・${order.itemCount} 項商品`, order, productName: order.items[0]?.name }));
  return tasks;
}

export function filterTasks(tasks: StoreTask[], filter: TaskFilter, category: TaskCategory | null): StoreTask[] {
  return tasks.filter((task) => (filter === 'all' || task.status === filter) && (!category || task.category === category));
}
