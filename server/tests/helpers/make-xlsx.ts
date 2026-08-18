/**
 * 測試用最小 xlsx 產生器。
 *
 * 直接用 exceljs 寫檔，而不是像 make-docx 那樣手組 OOXML：exceljs 的讀與寫是兩條獨立的
 * 程式路徑，寫出來的仍是真正的 zip 容器（含 sharedStrings、hyperlink relationship、
 * mergeCells），測試讀得懂輸入長什麼樣，調一個儲存格也不必重新產二進位 fixture。
 */
import { Workbook, type CellValue } from 'exceljs';

export interface SheetSpec {
  name: string;
  rows: CellValue[][];
  /** 隱藏工作表（查表資料／計算暫存的實務形態） */
  hidden?: boolean;
  /** 合併範圍，如 'A2:A4' */
  merges?: string[];
  /**
   * 只設樣式、不填值的儲存格位址，如 'F1'。
   * 用來重現「格式設定殘留把 columnCount 撐大到超出實際資料範圍」的常見情況。
   */
  styledBlanks?: string[];
}

export async function makeXlsx(...sheets: SheetSpec[]): Promise<Buffer> {
  const wb = new Workbook();
  for (const spec of sheets) {
    const ws = wb.addWorksheet(spec.name);
    for (const row of spec.rows) ws.addRow(row);
    for (const addr of spec.styledBlanks ?? []) ws.getCell(addr).font = { bold: true };
    for (const range of spec.merges ?? []) ws.mergeCells(range);
    if (spec.hidden) ws.state = 'hidden';
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
