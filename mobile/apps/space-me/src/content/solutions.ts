/**
 * 解決方案目錄：解決方案頁的卡片、詳細頁與首頁入口都讀這裡。
 * 內容依設計稿整理；細節說明交給 HyAgent 依知識庫回答（每個項目都能一鍵詢問）。
 */
import type { Ionicons } from '@expo/vector-icons';
import type { PhotoKey } from '@/brand/assets';
import type { Tint } from '@/brand/theme';

type IconName = keyof typeof Ionicons.glyphMap;

export interface SolutionItem {
  title: string;
  desc: string;
  photo: PhotoKey;
}

export interface Solution {
  id: string;
  name: string;
  /** 篩選標籤上的短名 */
  chip: string;
  /** 卡片副標：適用空間 */
  tags: string[];
  icon: IconName;
  tint: Tint;
  photo: PhotoKey;
  headline: string;
  intro: string;
  items: SolutionItem[];
}

export const SOLUTIONS: Solution[] = [
  {
    id: 'library',
    name: '圖書館空間管理',
    chip: '圖書館空間管理',
    tags: ['討論室', '研究小間', '自習室', '視聽座位', '電腦座位'],
    icon: 'book-outline',
    tint: 'purple',
    photo: 'library',
    headline: '打造更有序、更高效的學習空間',
    intro: 'SpaceMe 專為圖書館設計智慧空間管理方案，協助館方提升空間使用效率，創造更佳的學習體驗。',
    items: [
      { title: '討論室', desc: '彈性預約機制，提升團隊學習效率', photo: 'roomDiscussion' },
      { title: '研究小間', desc: '提供安靜、專注的個人學習空間', photo: 'roomStudy' },
      { title: '自習室', desc: '個人化座位，優化自習體驗', photo: 'roomReading' },
    ],
  },
  {
    id: 'office',
    name: 'OfficeMe 智慧辦公空間',
    chip: 'OfficeMe',
    tags: ['彈性辦公', '會議室', '共享空間'],
    icon: 'business-outline',
    tint: 'blue',
    photo: 'office',
    headline: '讓辦公空間跟著工作方式調整',
    intro: 'OfficeMe 將 SpaceMe 的預約與管理能力帶進企業，支援彈性座位、會議室與共享空間，讓空間配置更有彈性。',
    items: [
      { title: '會議室', desc: '線上預約、到場報到，減少空佔', photo: 'roomDiscussion' },
      { title: '彈性座位', desc: '依當天需求選位，提升座位使用率', photo: 'office' },
      { title: '共享空間', desc: '跨部門共用，使用狀況一目了然', photo: 'roomStudy' },
    ],
  },
  {
    id: 'environment',
    name: '智慧環控方案',
    chip: '智慧環控',
    tags: ['燈光', '空調', '環境感測'],
    icon: 'leaf-outline',
    tint: 'green',
    photo: 'environment',
    headline: '結合環境設備，打造舒適的使用體驗',
    intro: '依預約與使用狀態連動燈光、空調等設備，並蒐集環境數據，兼顧舒適與節能。',
    items: [
      { title: '設備連動', desc: '有人使用才開啟，離開自動關閉', photo: 'environment' },
      { title: '環境感測', desc: '溫度、濕度與空氣品質即時掌握', photo: 'roomReading' },
      { title: '數據分析', desc: '掌握使用趨勢，優化空間配置', photo: 'library' },
    ],
  },
  {
    id: 'consulting',
    name: '專業顧問服務',
    chip: '專業顧問服務',
    tags: ['需求訪談', '空間規劃', '導入培訓'],
    icon: 'people-outline',
    tint: 'blue',
    photo: 'consulting',
    headline: '從規劃到導入，提供完善的顧問服務',
    intro: '顧問團隊依場域特性規劃空間與流程，協助系統導入、人員培訓與上線後的持續優化。',
    items: [
      { title: '需求訪談', desc: '了解場域現況與管理痛點', photo: 'consulting' },
      { title: '空間規劃', desc: '依使用情境配置空間類型與規則', photo: 'office' },
      { title: '導入與培訓', desc: '協助上線並培訓管理人員', photo: 'roomDiscussion' },
    ],
  },
];

export function findSolution(id: string | undefined): Solution | undefined {
  return SOLUTIONS.find((s) => s.id === id);
}

/** 解決方案頁的篩選：category 為解決方案 id（'all' 為全部），query 比對名稱、適用空間與項目。 */
export function filterSolutions(list: Solution[], category: string, query: string): Solution[] {
  const q = query.trim().toLowerCase();
  return list.filter((s) => {
    if (category !== 'all' && s.id !== category) return false;
    if (!q) return true;
    const haystack = [s.name, s.chip, s.headline, ...s.tags, ...s.items.map((i) => i.title)].join(' ').toLowerCase();
    return haystack.includes(q);
  });
}
