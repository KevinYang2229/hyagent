/**
 * 產品格狀卡的版面。
 *
 * 平板：橫放一列三張填滿寬度，直放一列兩張、沿用同一個卡寬（tabletCellWidth，以螢幕長短邊計算，與方向無關）。
 * 寬度固定後，只用卡片的「圖片高度」去適應螢幕高度，盡量一屏放完；放不下才回 fits=false，畫面改成可捲動。
 * 手機：一欄或兩欄依空間挑，寬度隨螢幕。
 */
export interface GridFit {
  columns: number;
  /** 平板的固定格寬（含外距）；手機為 undefined，改用百分比 */
  cellWidth?: number;
  artSize: number;
  /** 空間緊時卡片只留名稱，不顯示英文名與說明 */
  compact: boolean;
  fits: boolean;
}

/** 卡片文字區高度：完整（名稱＋英文＋兩行說明）／精簡（名稱＋英文） */
export const CARD_TEXT_FULL = 124;
export const CARD_TEXT_COMPACT = 90;
/** 平板一列最多幾張：橫放三張、直放兩張 */
export const MAX_COLUMNS_LANDSCAPE = 3;
export const MAX_COLUMNS_PORTRAIT = 2;
/** 產品清單左右內距合計 */
export const GRID_SIDE_PADDING = 30;

/**
 * 平板格寬（含外距）：橫放時三張剛好填滿；直放時同樣寬度排兩張。
 * 用螢幕長短邊計算，所以轉向前後一樣寬；若短邊放不下兩張（例如 iPad mini）就取兩者較小值。
 */
export function tabletCellWidth(screenW: number, screenH: number): number {
  const long = Math.max(screenW, screenH) - GRID_SIDE_PADDING;
  const short = Math.min(screenW, screenH) - GRID_SIDE_PADDING;
  return Math.floor(Math.min(long / MAX_COLUMNS_LANDSCAPE, short / MAX_COLUMNS_PORTRAIT));
}
/** 每張卡的外距（上下各一半） */
const CELL_GAP = 18;

/**
 * 平板卡片尺寸（寬、圖高、是否精簡）與方向無關：寬度見 tabletCellWidth；圖高取「橫放、直放兩種方向
 * 都一屏放得下 sizingCount 項」的較小值，轉向前後卡片完全一樣大。
 */
export function tabletCard({ sizingCount, screenW, screenH, chromeH }: { sizingCount: number; screenW: number; screenH: number; /** 清單以外佔掉的高度（品牌列、分類列、導覽列等） */ chromeH: number }) {
  const cellWidth = tabletCellWidth(screenW, screenH);
  const long = Math.max(screenW, screenH) - chromeH;
  const short = Math.min(screenW, screenH) - chromeH;
  const rowsLand = Math.ceil(sizingCount / MAX_COLUMNS_LANDSCAPE);
  const rowsPort = Math.ceil(sizingCount / MAX_COLUMNS_PORTRAIT);
  const cellH = Math.min(short / rowsLand, long / rowsPort) - CELL_GAP;
  const maxArt = (cellWidth - CELL_GAP) * 0.9;
  for (const compact of [false, true]) {
    const art = Math.min(cellH - (compact ? CARD_TEXT_COMPACT : CARD_TEXT_FULL), maxArt);
    if (art >= 110) return { cellWidth, artSize: Math.floor(art), compact };
  }
  return { cellWidth, artSize: 110, compact: true };
}

export function fitGrid({ count, width, height, wide, landscape = true, card }: {
  count: number; width: number; height: number; wide: boolean; landscape?: boolean;
  /** 平板固定卡片尺寸，見 tabletCard */
  card?: { cellWidth: number; artSize: number; compact: boolean };
}): GridFit {
  if (wide) {
    const columns = Math.max(1, Math.min(landscape ? MAX_COLUMNS_LANDSCAPE : MAX_COLUMNS_PORTRAIT, count));
    const c = card ?? { cellWidth: Math.floor(width / columns), artSize: 200, compact: false };
    const cardH = c.artSize + (c.compact ? CARD_TEXT_COMPACT : CARD_TEXT_FULL) + CELL_GAP;
    return { columns, ...c, fits: Math.ceil(count / columns) * cardH <= height + 1 };
  }
  let best: GridFit | null = null;
  for (const columns of [1, 2]) {
    if (columns > Math.max(count, 1)) continue;
    const rows = Math.ceil(count / columns);
    const cellH = height / rows - CELL_GAP;
    const cellW = width / columns - CELL_GAP;
    // 手機兩欄太窄放不下說明，一律用精簡卡（名稱可換兩行）
    for (const compact of columns > 1 ? [true] : [false, true]) {
      const art = Math.min(cellH - (compact ? CARD_TEXT_COMPACT : CARD_TEXT_FULL), cellW * 0.9, 240);
      if (art < 90) continue;
      if (!best || art > best.artSize) best = { columns, artSize: Math.floor(art), compact, fits: true };
      break;
    }
  }
  return best ?? { columns: 2, artSize: 140, compact: false, fits: false };
}
