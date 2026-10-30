/** 回覆中的畫面區塊（目前只有表格）：資料來自工具，不經 AI 轉述。 */
import { useTranslation } from 'react-i18next';
import type { DisplayBlock, TableColumn } from '@hyagent/shared';

function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  // 避免 Excel 把 =、+、-、@ 開頭的文字當公式執行（CSV injection）
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 表格轉 CSV：表頭帶單位、數值不帶單位，方便在 Excel 中計算 */
export function tableToCsv(block: DisplayBlock): string {
  const header = block.columns.map((c) => csvCell(c.unit ? `${c.label}（${c.unit}）` : c.label));
  const lines = block.rows.map((row) => block.columns.map((c) => csvCell(row[c.key])).join(','));
  return [header.join(','), ...lines].join('\r\n');
}

function downloadCsv(block: DisplayBlock): void {
  // 加 BOM，Excel 才會用 UTF-8 開啟中文
  const blob = new Blob(['\uFEFF', tableToCsv(block)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const date = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `${(block.title || 'table').replace(/[\\/:*?"<>|]+/g, '_')}-${date}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function renderCell(col: TableColumn, row: Record<string, string | number | null>) {
  const v = row[col.key];
  if (col.badge && v !== null && v !== undefined) {
    const key = String(v);
    const tone = Object.prototype.hasOwnProperty.call(col.badge, key) ? col.badge[key] : 'neutral';
    return <span className="block-badge" data-tone={tone}>{String(v)}</span>;
  }
  if (col.format === 'delta') {
    if (typeof v === 'number' && v > 0) return <span className="block-delta">{`+${v}${col.unit ? ` ${col.unit}` : ''}`}</span>;
    return <span className="block-muted">–</span>;
  }
  if (v === null || v === undefined || v === '') return <span className="block-muted">–</span>;
  return `${v}${col.unit ? ` ${col.unit}` : ''}`;
}

export function DisplayBlockView({ block }: { block: DisplayBlock }) {
  const { t } = useTranslation();
  return (
    <div className="display-block" data-testid="display-block">
      {block.title && <div className="display-block-title">{block.title}</div>}
      <div className="display-block-scroll">
        <table className="display-table">
          <thead>
            <tr>{block.columns.map((c) => <th key={c.key}>{c.label}</th>)}</tr>
          </thead>
          <tbody>
            {block.rows.map((row, i) => (
              <tr key={i}>
                {block.columns.map((c) => (
                  <td key={c.key}>
                    <span className="display-cell">
                      {c.image && typeof row[c.image] === 'string' && /^https?:\/\//i.test(row[c.image] as string) && <img src={row[c.image] as string} alt="" className="display-thumb" />}
                      {renderCell(c, row)}
                    </span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {block.rows.length > 0 && (
        <div className="display-block-actions">
          <button type="button" className="display-block-export" onClick={() => downloadCsv(block)}>
            {t('block.downloadCsv')}
          </button>
        </div>
      )}
    </div>
  );
}
