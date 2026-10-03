/** 回覆中的畫面區塊（目前只有表格）：資料來自工具，不經 AI 轉述。 */
import type { DisplayBlock, TableColumn } from '@hyagent/shared';

function renderCell(col: TableColumn, row: Record<string, string | number | null>) {
  const v = row[col.key];
  if (col.badge && v !== null && v !== undefined) {
    const tone = col.badge[String(v)] ?? 'neutral';
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
    </div>
  );
}
