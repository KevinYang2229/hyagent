/** 首頁常用情境：點擊帶入問題到 AI 對話。 */
export const SCENARIOS = [
  { label: '查詢庫存', icon: 'cart', color: '#FF9500', soft: '#FFF7E8', q: '幫我查庫存' },
  { label: '建立補貨單', icon: 'cube', color: '#FF8738', soft: '#FFF4EB', q: '幫我把庫存偏低的商品建立補貨單' },
  { label: '即期品管理', icon: 'cube', color: '#FF9900', soft: '#FFF8E8', q: '今天有哪些即期品？' },
  { label: '設備故障排除', icon: 'build', color: '#1689FF', soft: '#ECF6FF', q: '設備故障怎麼排除？' },
  { label: '促銷活動查詢', icon: 'megaphone', color: '#1689FF', soft: '#ECF6FF', q: '現在有什麼活動？' },
  { label: '會員活動', icon: 'person', color: '#9450EC', soft: '#F2E9FF', q: '現在有什麼會員活動？' },
  { label: '門市報表', icon: 'clipboard', color: '#007BFF', soft: '#ECF6FF', q: '幫我查詢今日門市營運報表' },
] as const;
