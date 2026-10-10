/** 產品特色（稿：產品特色頁）。點卡片會請 HyAgent 介紹該特色。 */
import type { Ionicons } from '@expo/vector-icons';
import type { Tint } from '@/brand/theme';

export interface Feature {
  title: string;
  desc: string;
  icon: keyof typeof Ionicons.glyphMap;
  tint: Tint;
}

export const FEATURES: Feature[] = [
  { title: '彈性預約機制', desc: '提升空間使用彈性', icon: 'calendar-outline', tint: 'blue' },
  { title: '個人化選位', desc: '提供專屬的使用體驗', icon: 'person-outline', tint: 'green' },
  { title: '智慧環控', desc: '打造舒適的環境', icon: 'bulb-outline', tint: 'purple' },
  { title: '多元空間管理', desc: '討論室、自習室、視聽等', icon: 'grid-outline', tint: 'blue' },
  { title: '數據分析報表', desc: '掌握使用趨勢與價值', icon: 'bar-chart-outline', tint: 'blue' },
  { title: '即時資訊顯示', desc: '方便掌握空間狀態', icon: 'desktop-outline', tint: 'blue' },
  { title: '到場報到', desc: '確認實際使用，減少空佔', icon: 'checkmark-circle-outline', tint: 'green' },
  { title: '設備連動', desc: '依使用狀態連動燈光與空調', icon: 'options-outline', tint: 'orange' },
];

export function featureQuestion(feature: Feature): string {
  return `請介紹 SpaceMe 的「${feature.title}」`;
}
