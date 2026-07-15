import { lazy, Suspense, useEffect, useState, type CSSProperties } from 'react';
import { api, type Usage } from '../../api';

const TokenGauge = lazy(() => import('../../components/TokenGauge'));

const th: CSSProperties = { textAlign: 'left', padding: '8px 10px', borderBottom: '1px solid var(--border-color)', fontWeight: 500, whiteSpace: 'nowrap' };
const td: CSSProperties = { padding: '6px 10px', borderBottom: '1px solid var(--border-color)', verticalAlign: 'top' };

export default function UsageTab({ tenantId, onError }: { tenantId: string; onError: (e: unknown) => void }) {
  const [usage, setUsage] = useState<Usage | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .getUsage(tenantId)
      .then((u) => {
        if (!cancelled) setUsage(u);
      })
      .catch(onError);
    return () => {
      cancelled = true;
    };
  }, [tenantId, onError]);

  if (!usage) {
    return (
      <div className="card">
        <div className="empty">載入中…</div>
      </div>
    );
  }

  const items: { label: string; value: number }[] = [
    { label: '對話數', value: usage.conversations ?? 0 },
    { label: '訊息數', value: usage.messages ?? 0 },
    { label: '送出數', value: usage.submissions ?? 0 },
  ];

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <Suspense fallback={<div className="card"><div className="empty">載入圖表…</div></div>}>
        <TokenGauge tokens={usage.llmTokens ?? 0} />
      </Suspense>
      <div className="stats">
        {items.map((it) => (
          <div key={it.label} className="stat">
            <div className="stat-label">{it.label}</div>
            <div className="stat-value">{it.value.toLocaleString()}</div>
          </div>
        ))}
      </div>

      {usage.cost && usage.cost.byModel.length > 0 && (
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Token 用量與預估成本</div>
              <div className="card-desc">
                平台金鑰 ${usage.cost.platformUsd.toFixed(4)}（應收） ／ 自帶金鑰 $
                {usage.cost.tenantUsd.toFixed(4)}（參考） ／ 合計 ${usage.cost.totalUsd.toFixed(4)} USD
              </div>
            </div>
          </div>
          <div className="card-body" style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13.5 }}>
              <thead>
                <tr>
                  <th style={th}>模型</th>
                  <th style={th}>金鑰</th>
                  <th style={th}>Input</th>
                  <th style={th}>Output</th>
                  <th style={th}>Cache 讀</th>
                  <th style={th}>預估成本</th>
                </tr>
              </thead>
              <tbody>
                {usage.cost.byModel.map((m) => (
                  <tr key={`${m.keySource}|${m.model}`}>
                    <td style={td}>{m.model}</td>
                    <td style={td}>{m.keySource === 'tenant' ? '自帶' : '平台'}</td>
                    <td style={td}>{m.inputTokens.toLocaleString()}</td>
                    <td style={td}>{m.outputTokens.toLocaleString()}</td>
                    <td style={td}>{m.cacheReadTokens.toLocaleString()}</td>
                    <td style={td}>{m.usd === null ? '無單價資料' : `$${m.usd.toFixed(4)}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
