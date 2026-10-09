/**
 * LIB ONE 產品目錄：產品線、功能條列、分類標語依 lib-one.com 官網整理；產品照從官網擷取，放在 assets/products。
 * 一句話介紹（summary）是依功能條列改寫的摘要；比較表只列官網功能條列看得出來的項目，不寫官網沒有的規格。
 * AI 回答的依據是後端知識庫，這份目錄只負責畫面上的卡片、篩選與比較。
 */
import type { ImageSourcePropType } from 'react-native';

export type CategoryId = 'entry' | 'circulation' | 'space' | 'operations';

/** MaterialCommunityIcons 圖示名稱：沒有產品照時的替代圖；catalog.test 會檢查都存在 */
export type ArtIcon =
  | 'turnstile-outline' | 'boom-gate' | 'book-arrow-left' | 'monitor' | 'locker-multiple'
  | 'seat' | 'television-guide' | 'tablet-dashboard' | 'battery-charging-high'
  | 'desktop-tower-monitor' | 'cellphone-nfc' | 'cog-transfer' | 'book-sync';

export interface Category {
  id: CategoryId;
  no: string;
  title: string;
  titleEn: string;
  /** 官網分類標語 */
  tagline: string;
  /** 首頁卡片的兩行說明 */
  lines: [string, string];
  icon: ArtIcon;
  /** 首頁卡片的代表產品（用它的產品照） */
  cover: string;
  /** 帶進 HyAgent 的問題 */
  question: string;
}

export type HighlightIcon = 'book-multiple' | 'clock-outline' | 'gesture-tap' | 'puzzle-outline' | 'shield-check-outline' | 'lightning-bolt' | 'calendar-clock' | 'radar' | 'view-dashboard-outline';

export interface Product {
  id: string;
  category: CategoryId;
  name: string;
  nameEn: string;
  summary: string;
  /** 官網功能條列 */
  features: string[];
  /** 詳細頁的圖示亮點（最多 4 個） */
  highlights: { icon: HighlightIcon; label: string }[];
  /** 比較表欄位：key 對 SPEC_ROWS，值 true 顯示勾、字串照寫、缺少顯示 — */
  specs: Partial<Record<SpecKey, string | boolean>>;
  icon: ArtIcon;
  image?: ImageSourcePropType;
  /** 對話回覆比對用的別名（產品名稱與英文名稱之外） */
  aliases?: string[];
}

export const CATEGORIES: Category[] = [
  {
    id: 'entry', no: '01', title: '出入館', titleEn: 'Arrival & Access', tagline: '從入口開始，讓辨識、通行與服務自然接續。',
    lines: ['智慧閘門・借閱通關', '辨識與通行管理'], icon: 'turnstile-outline', cover: 'access-gate',
    question: 'LIB ONE 的出入館設備有哪些？',
  },
  {
    id: 'circulation', no: '02', title: '借還書', titleEn: 'Borrow & Return', tagline: '把高頻借還流程，安排成讀者可以自己完成的日常。',
    lines: ['自助借還書機・預約取書櫃', '讀者自助完成借還'], icon: 'book-arrow-left', cover: 'kiosk',
    question: '有哪些自助借還書設備？',
  },
  {
    id: 'space', no: '03', title: '空間設備服務', titleEn: 'Space Services', tagline: '讓預約、資訊與設備服務，成為閱讀空間的一部分。',
    lines: ['座位預約・資訊顯示', 'HyRead 展示・設備充電'], icon: 'seat', cover: 'hyread-kiosk',
    question: 'LIB ONE 有哪些空間設備服務？',
  },
  {
    id: 'operations', no: '04', title: '館務作業', titleEn: 'Library Operations', tagline: '以清楚的工作節點，承接館員每天的流通與館藏作業。',
    lines: ['館員工作站・RFID 工作站', '流通與館藏作業'], icon: 'desktop-tower-monitor', cover: 'workstation',
    question: 'LIB ONE 怎麼協助館員處理館務作業？',
  },
];

export const SPEC_ROWS = [
  { key: 'category', label: '服務分類' },
  { key: 'form', label: '外型' },
  { key: 'rfid', label: 'RFID 辨識' },
  { key: 'barcode', label: '條碼辨識' },
  { key: 'selfService', label: '讀者自助操作' },
  { key: 'multilingual', label: '多語介面' },
  { key: 'remote', label: '遠端／後台管理' },
  { key: 'stats', label: '統計紀錄' },
] as const;

export type SpecKey = (typeof SPEC_ROWS)[number]['key'];

export const PRODUCTS: Product[] = [
  {
    id: 'access-gate', category: 'entry', name: '智慧閘門', nameEn: 'Access Gate', icon: 'turnstile-outline',
    image: require('../../assets/products/access-gate.png'),
    summary: '多元讀者身分驗證，快速進出並支援無障礙通行，同時掌握進出方向與人流。',
    features: ['多元讀者身分驗證', '快速進出與無障礙通行', '進出方向與人流統計', '防夾、防尾隨與緊急開門', '可整合 HyLib、門禁與訪客系統'],
    highlights: [{ icon: 'shield-check-outline', label: '身分驗證' }, { icon: 'lightning-bolt', label: '快速進出' }, { icon: 'view-dashboard-outline', label: '人流統計' }, { icon: 'puzzle-outline', label: '系統整合' }],
    specs: { category: '出入館', form: '閘道式', selfService: true, stats: '進出人流' },
  },
  {
    id: 'checkout-gate', category: 'entry', name: '智慧借閱通關系統', nameEn: 'Smart Checkout Gate', icon: 'boom-gate',
    image: require('../../assets/products/checkout-gate.png'),
    summary: '自動辨識讀者與館藏，借閱與離館一次完成。',
    features: ['讀者與館藏自動辨識', '借閱與離館一次完成', 'HF / UHF RFID 與條碼辨識', '雙門互鎖與異常攔截', '無障礙通行與安全感測'],
    highlights: [{ icon: 'book-multiple', label: '自動辨識' }, { icon: 'lightning-bolt', label: '借閱即離館' }, { icon: 'shield-check-outline', label: '異常攔截' }, { icon: 'gesture-tap', label: '無障礙通行' }],
    specs: { category: '出入館', form: '閘道式', rfid: 'HF / UHF', barcode: true, selfService: true },
    aliases: ['借閱通關', '通關系統'],
  },
  {
    id: 'kiosk', category: 'circulation', name: '直立式自助借還書機', nameEn: 'Self-Service Kiosk', icon: 'monitor',
    image: require('../../assets/products/kiosk.png'),
    summary: '讀者自助借書、還書與續借，RFID 多本同時辨識，並提供多語與語音操作指引。',
    features: ['自助借書、還書與續借', 'RFID 多本同時辨識', '讀者帳戶即時查詢', '多語與語音操作指引', '電子 / 紙本收據與遠端管理', '中英日多語系介面'],
    highlights: [{ icon: 'book-multiple', label: '多本同時辨識' }, { icon: 'gesture-tap', label: '自助借還續' }, { icon: 'view-dashboard-outline', label: '帳戶查詢' }, { icon: 'puzzle-outline', label: '中英日介面' }],
    specs: { category: '借還書', form: '直立式', rfid: '多本同時辨識', selfService: true, multilingual: '中英日', remote: true },
    aliases: ['直立式自助借還'],
  },
  {
    id: 'desktop-kiosk', category: 'circulation', name: '桌上型自助借還書機', nameEn: 'Desktop Self-Service Kiosk', icon: 'tablet-dashboard',
    image: require('../../assets/products/desktop-kiosk.png'),
    summary: '與直立式相同的自助借還功能，桌上型機身適合櫃台或桌面空間。',
    features: ['自助借書、還書與續借', 'RFID 多本同時辨識', '讀者帳戶即時查詢', '多語與語音操作指引', '電子 / 紙本收據與遠端管理', '中英日多語系介面'],
    highlights: [{ icon: 'book-multiple', label: '多本同時辨識' }, { icon: 'gesture-tap', label: '自助借還續' }, { icon: 'view-dashboard-outline', label: '帳戶查詢' }, { icon: 'puzzle-outline', label: '中英日介面' }],
    specs: { category: '借還書', form: '桌上型', rfid: '多本同時辨識', selfService: true, multilingual: '中英日', remote: true },
    aliases: ['桌上型自助借還'],
  },
  {
    id: 'pickup-locker', category: 'circulation', name: '智慧預約取書櫃', nameEn: 'Smart Reserved Book Pickup Locker', icon: 'locker-multiple',
    image: require('../../assets/products/pickup-locker.png'),
    summary: '模組化擴充的預約取書櫃，燈號清楚導引取書，書格可彈性配置。',
    features: ['模組化擴充', '燈號清楚導引', '館務單一介面', '書格彈性配置', '場域整合設計', '讀者操作與隱私規劃'],
    highlights: [{ icon: 'view-dashboard-outline', label: '模組化擴充' }, { icon: 'gesture-tap', label: '燈號導引' }, { icon: 'puzzle-outline', label: '書格彈性' }, { icon: 'shield-check-outline', label: '隱私規劃' }],
    specs: { category: '借還書', form: '櫃體', selfService: '預約取書', remote: '館務單一介面' },
    aliases: ['取書櫃', '預約櫃'],
  },
  {
    id: 'space-kiosk', category: 'space', name: '直立式座位預約機', nameEn: 'Space Kiosk', icon: 'seat',
    image: require('../../assets/products/space-kiosk.png'),
    summary: '座位與討論室即時查詢、現場預約與報到，逾時未報到自動釋出。',
    features: ['座位與討論室即時查詢', '現場預約與驗證報到', '預約時段與資格規則管理', '逾時未報到自動釋出', '使用率與熱門時段統計'],
    highlights: [{ icon: 'view-dashboard-outline', label: '即時查詢' }, { icon: 'calendar-clock', label: '現場預約' }, { icon: 'clock-outline', label: '逾時釋出' }, { icon: 'radar', label: '使用率統計' }],
    specs: { category: '空間設備服務', form: '直立式', selfService: true, remote: '規則管理', stats: '使用率、熱門時段' },
    aliases: ['直立式座位預約'],
  },
  {
    id: 'desktop-space-kiosk', category: 'space', name: '桌上型座位預約機', nameEn: 'Desktop Space Kiosk', icon: 'tablet-dashboard',
    image: require('../../assets/products/desktop-space-kiosk.png'),
    summary: '與直立式相同的座位預約功能，桌上型機身適合櫃台與閱覽區入口。',
    features: ['座位與討論室即時查詢', '現場預約與驗證報到', '預約時段與資格規則管理', '逾時未報到自動釋出', '使用率與熱門時段統計'],
    highlights: [{ icon: 'view-dashboard-outline', label: '即時查詢' }, { icon: 'calendar-clock', label: '現場預約' }, { icon: 'clock-outline', label: '逾時釋出' }, { icon: 'radar', label: '使用率統計' }],
    specs: { category: '空間設備服務', form: '桌上型', selfService: true, remote: '規則管理', stats: '使用率、熱門時段' },
    aliases: ['桌上型座位預約'],
  },
  {
    id: 'display', category: 'space', name: '電子紙 / 數位資訊顯示設備', nameEn: 'Display', icon: 'television-guide',
    image: require('../../assets/products/display.png'),
    summary: '電子紙與數位看板整合，發布圖文、影音與網頁，介紹館藏、活動與空間資訊。',
    features: ['電子紙與數位看板整合', '圖文、影音與網頁發布', '多設備分群與排程播放', '館藏、活動與空間資訊介紹', '遠端更新與播放紀錄管理'],
    highlights: [{ icon: 'view-dashboard-outline', label: '看板整合' }, { icon: 'calendar-clock', label: '排程播放' }, { icon: 'lightning-bolt', label: '遠端更新' }, { icon: 'radar', label: '播放紀錄' }],
    specs: { category: '空間設備服務', form: '電子紙、數位看板', remote: '遠端更新', stats: '播放紀錄' },
    aliases: ['電子紙', '數位資訊顯示', '數位看板'],
  },
  {
    id: 'hyread-kiosk', category: 'space', name: 'HyRead 閱讀展示機', nameEn: 'HyRead Kiosk', icon: 'tablet-dashboard',
    image: require('../../assets/products/hyread-kiosk.png'),
    summary: '動態展示書封，讀者掃 QR Code 即可接續閱讀，主題與書單可彈性更新。',
    features: ['多元形態與彈性部署', '動態書封展示', '連網使用雲端服務', 'QR Code 接續閱讀', '主題與書單彈性更新'],
    highlights: [{ icon: 'book-multiple', label: '動態書封' }, { icon: 'gesture-tap', label: '掃碼接續閱讀' }, { icon: 'lightning-bolt', label: '雲端服務' }, { icon: 'calendar-clock', label: '書單更新' }],
    specs: { category: '空間設備服務', form: '多元形態', selfService: '掃碼閱讀', remote: '雲端服務' },
    aliases: ['HyRead 展示', 'HyRead 閱讀展示'],
  },
  {
    id: 'charging-cabinet', category: 'space', name: '多功能設備充電櫃', nameEn: 'Multifunction Device Charging Cabinet', icon: 'battery-charging-high',
    image: require('../../assets/products/charging-cabinet.png'),
    summary: '集中充電與安全保管，讀者自助借用設備，後台可盤點與追蹤紀錄。',
    features: ['多格數彈性選擇', '自助化借用流程', '集中充電與安全保管', '設備與櫃位彈性配置', '後台盤點與紀錄追蹤', '可介接既有系統', 'Gazer Lite / Pro 分級配置'],
    highlights: [{ icon: 'lightning-bolt', label: '集中充電' }, { icon: 'shield-check-outline', label: '安全保管' }, { icon: 'gesture-tap', label: '自助借用' }, { icon: 'puzzle-outline', label: '介接既有系統' }],
    specs: { category: '空間設備服務', form: '櫃體', selfService: '自助借用', remote: '後台盤點', stats: '借用紀錄' },
    aliases: ['充電櫃', '設備充電櫃'],
  },
  {
    id: 'workstation', category: 'operations', name: '館員工作站', nameEn: 'Workstation', icon: 'desktop-tower-monitor',
    image: require('../../assets/products/workstation.png'),
    summary: '借還、續借與帳戶作業的館員工作站，雙螢幕整合於機身，精巧機身減少桌面占用。',
    features: ['借還、續借與帳戶作業', '支援 RFID 與條碼辨識', '雙螢幕整合於機身，無需外接', '支援館務相關周邊裝置', '精巧機身減少桌面占用'],
    highlights: [{ icon: 'book-multiple', label: '借還續借' }, { icon: 'radar', label: 'RFID／條碼' }, { icon: 'view-dashboard-outline', label: '雙螢幕整合' }, { icon: 'puzzle-outline', label: '周邊裝置' }],
    specs: { category: '館務作業', form: '工作站', rfid: true, barcode: true },
  },
  {
    id: 'rfid-workstation', category: 'operations', name: 'RFID 工作站', nameEn: 'RFID Workstation', icon: 'cellphone-nfc',
    image: require('../../assets/products/rfid-workstation.png'),
    summary: '支援 RFID 與條碼辨識的館員作業站，模組化設計便於維修。',
    features: ['借還、續借與帳戶作業', '支援 RFID 與條碼辨識', '支援館務相關周邊裝置', '精巧機身減少桌面占用', '模組化設計便於維修'],
    highlights: [{ icon: 'book-multiple', label: '借還續借' }, { icon: 'radar', label: 'RFID／條碼' }, { icon: 'puzzle-outline', label: '周邊裝置' }, { icon: 'shield-check-outline', label: '模組化維修' }],
    specs: { category: '館務作業', form: '工作站', rfid: true, barcode: true },
  },
];

export function getCategory(id: string | undefined): Category | undefined {
  return CATEGORIES.find((c) => c.id === id);
}

export function getProduct(id: string | undefined): Product | undefined {
  return PRODUCTS.find((p) => p.id === id);
}

export function productsIn(category: CategoryId | undefined): Product[] {
  return category ? PRODUCTS.filter((p) => p.category === category) : PRODUCTS;
}
