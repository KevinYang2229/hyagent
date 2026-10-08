/** 貨架辨識結果的顯示邏輯（純函式）。 */
import type { ShelfFinding, ShelfResult, ShelfStatus } from '@/api/storeTypes';
import { colors } from '@hyagent/app-core/theme/tokens';

export const STATUS_META: Record<ShelfStatus, { label: string; color: string; soft: string }> = {
  out_of_stock: { label: '缺貨', color: colors.danger, soft: colors.dangerSoft },
  expiring: { label: '即期品', color: colors.warning, soft: colors.warningSoft },
  misplaced: { label: '擺放錯誤', color: colors.misplaced, soft: colors.misplacedSoft },
  ok: { label: '擺放正確', color: colors.primary, soft: colors.primarySoft },
};

export const ISSUE_ORDER = ['out_of_stock', 'expiring', 'misplaced'] as const;

export function groupFindings(findings: ShelfFinding[]): Record<(typeof ISSUE_ORDER)[number], ShelfFinding[]> {
  return {
    out_of_stock: findings.filter((f) => f.status === 'out_of_stock'),
    expiring: findings.filter((f) => f.status === 'expiring'),
    misplaced: findings.filter((f) => f.status === 'misplaced'),
  };
}

export function issueCount(findings: ShelfFinding[]): number {
  return findings.filter((f) => f.status !== 'ok').length;
}

export function daysLeft(expiry: string, today: string): number {
  return Math.round((Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

export function findingDetail(f: ShelfFinding, today: string): string {
  switch (f.status) {
    case 'out_of_stock':
      return f.suggestedQty ? `建議補貨 ${f.suggestedQty} 個` : '建議補貨';
    case 'expiring':
      return f.expiryDate ? `有效期限：${f.expiryDate.replace(/-/g, '/')}（剩 ${daysLeft(f.expiryDate, today)} 天）` : '即將到期';
    case 'misplaced':
      return f.note ?? '擺放位置不正確';
    default:
      return '';
  }
}

export interface Frame {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 圖片以 contain 方式放進容器時實際占的區域 */
export function fitContain(imgW: number, imgH: number, boxW: number, boxH: number): Frame | null {
  if (!(imgW > 0 && imgH > 0 && boxW > 0 && boxH > 0)) return null;
  const scale = Math.min(boxW / imgW, boxH / imgH);
  const width = imgW * scale;
  const height = imgH * scale;
  return { left: (boxW - width) / 2, top: (boxH - height) / 2, width, height };
}

export function boxRect(box: ShelfFinding['box'], frame: Frame): Frame {
  return {
    left: frame.left + box.x * frame.width,
    top: frame.top + box.y * frame.height,
    width: box.w * frame.width,
    height: box.h * frame.height,
  };
}

export function replenishmentCount(result: ShelfResult): number {
  const items = result.replenishment?.input.items;
  return Array.isArray(items) ? items.length : 0;
}

/** 框選上的標籤文字：即期品附上期限（MM/DD） */
export function boxTagText(f: ShelfFinding): string {
  const label = STATUS_META[f.status].label;
  if (f.status === 'expiring' && f.expiryDate) return `${label} ${f.expiryDate.slice(5).replace('-', '/')}`;
  return label;
}
