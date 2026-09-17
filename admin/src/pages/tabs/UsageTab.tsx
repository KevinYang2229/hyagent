import { lazy, Suspense, useEffect, useState, type CSSProperties } from 'react';
import { api, type Tenant, type Usage } from '../../api';
import { formatTokens } from '../../components/tokenGauge.util';
import { recentMonths, tokenBreakdown } from '../../components/usageSummary.util';

const TokenGauge = lazy(() => import('../../components/TokenGauge'));

const th: CSSProperties = { textAlign: 'left', padding: '8px 10px', borderBottom: '1px solid var(--border-color)', fontWeight: 500, whiteSpace: 'nowrap' };
const td: CSSProperties = { padding: '6px 10px', borderBottom: '1px solid var(--border-color)', verticalAlign: 'top' };

export default function UsageTab({ tenant, onError }: { tenant: Tenant; onError: (e: unknown) => void }) {
  const [usage, setUsage] = useState<Usage | null>(null);
  const tenantId = tenant.id;

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

  const conversations = usage.conversations ?? 0;
  const messages = usage.messages ?? 0;
  const submissions = usage.submissions ?? 0;
  const ratio = (a: number, b: number) => (b > 0 ? a / b : 0);
  const items: { label: string; value: number; hint: string; sub: [string, string, string] }[] = [
    {
      label: '對話數',
      value: conversations,
      hint: '使用者開啟的對話段數',
      sub: ['平均每段 ', ratio(messages, conversations).toFixed(1), ' 則訊息'],
    },
    {
      label: '訊息數',
      value: messages,
      hint: '使用者送出的提問則數（不含 AI 回覆）',
      sub: ['平均每則分攤 ', formatTokens(ratio(usage.llmTokens ?? 0, messages)), ' tokens'],
    },
    {
      label: '送出數',
      value: submissions,
      hint: '經對話完成並送出的表單件數',
      sub: ['占對話 ', `${(ratio(submissions, conversations) * 100).toFixed(1)}%`, ''],
    },
  ];

  // 本月用量 vs 配額（配額守門對照的是月度分桶，不是 lifetime 累計）
  const month = new Date().toISOString().slice(0, 7);
  const monthUsed = usage.monthlyLlmTokens?.[month] ?? 0;
  const quota = tenant.quotaMonthlyLlmTokens ?? 0;
  const quotaPct = quota > 0 ? Math.min(100, (monthUsed / quota) * 100) : 0;

  // 與 Token 組成、月度分桶、配額同一口徑：LLM（輸入＋輸出＋Cache 讀取）＋向量化
  const totalTokens = (usage.llmTokens ?? 0) + (usage.embeddingTokens ?? 0);
  const parts = tokenBreakdown(usage);
  const partsTotal = parts.reduce((acc, p) => acc + p.value, 0);
  const trend = recentMonths(usage.monthlyLlmTokens, 6);
  const trendMax = Math.max(1, ...trend.map((t) => t.tokens));
  const perConversation = usage.conversations > 0 ? totalTokens / usage.conversations : 0;

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">本月 AI 用量（{month}）</div>
            <div className="card-desc">
              {quota > 0
                ? `${monthUsed.toLocaleString()} / ${quota.toLocaleString()} tokens（${quotaPct.toFixed(1)}%）；達上限時對話 API 回 429`
                : `${monthUsed.toLocaleString()} tokens；未設配額（不限），可於「設定」頁設定月度上限`}
            </div>
          </div>
        </div>
        {quota > 0 && (
          <div className="card-body">
            <div
              style={{
                height: 8,
                borderRadius: 4,
                background: 'var(--border-color)',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  width: `${quotaPct}%`,
                  height: '100%',
                  borderRadius: 4,
                  background: quotaPct >= 90 ? '#dc2626' : quotaPct >= 70 ? '#d97706' : 'var(--primary-color, #2563eb)',
                  transition: 'width .3s',
                }}
              />
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-body usage-overview">
          <div>
            <Suspense fallback={<div className="empty">載入圖表…</div>}>
              <TokenGauge tokens={totalTokens} />
            </Suspense>
            <div className="card-desc" style={{ textAlign: 'center' }}>
              不分月份的歷來總量（含向量化）
              <br />
              本月用量見上方「本月 AI 用量」
            </div>
          </div>

          <div className="usage-side">
            <div className="usage-kpis">
              <div className="usage-kpi">
                <div className="stat-label">平均每段對話</div>
                <div className="usage-kpi-value">{formatTokens(perConversation)} tokens</div>
              </div>
              <div className="usage-kpi">
                <div className="stat-label">累計預估成本</div>
                <div className="usage-kpi-value">{usage.cost ? `$${usage.cost.totalUsd.toFixed(2)}` : '—'}</div>
              </div>
            </div>

            <div>
              <div className="usage-section-title">Token 組成</div>
              <div className="usage-split" role="img" aria-label={parts.map((p) => `${p.label} ${p.value}`).join('、')}>
                {partsTotal > 0 &&
                  parts
                    .filter((p) => p.value > 0)
                    .map((p) => (
                      <span
                        key={p.key}
                        title={`${p.label}：${p.value.toLocaleString()}`}
                        style={{ flexGrow: p.value, background: `var(--series-${parts.indexOf(p) + 1})` }}
                      />
                    ))}
              </div>
              <div className="usage-legend">
                {parts.map((p, i) => (
                  <div key={p.key} className="usage-legend-item">
                    <span className="usage-swatch" style={{ background: `var(--series-${i + 1})` }} />
                    {p.label}
                    <b>
                      {formatTokens(p.value)}
                      {partsTotal > 0 && ` · ${Math.round((p.value / partsTotal) * 100)}%`}
                    </b>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <div className="usage-section-title">近 6 個月（— 表示該月無紀錄）</div>
              <div className="usage-bars">
                {trend.map((t) => (
                  <div
                    key={t.month}
                    className={`usage-bar${t.month === month ? ' is-current' : ''}`}
                    title={`${t.month}：${t.tokens.toLocaleString()} tokens`}
                  >
                    <span className="usage-bar-value">{t.tokens > 0 ? formatTokens(t.tokens) : '—'}</span>
                    <div className="usage-bar-fill" style={{ height: `${(t.tokens / trendMax) * 80}%` }} />
                    <span className="usage-bar-month">{Number(t.month.slice(5))}月</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="stats">
        {items.map((it) => (
          <div key={it.label} className="stat">
            <div className="stat-label">{it.label}</div>
            <div className="stat-value">{it.value.toLocaleString()}</div>
            <div className="stat-hint">{it.hint}</div>
            <div className="stat-sub">
              {it.sub[0]}
              <b>{it.sub[1]}</b>
              {it.sub[2]}
            </div>
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
