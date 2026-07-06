import { useEffect, useState } from 'react';
import { api, type Usage } from '../../api';

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
    { label: 'Token 數', value: usage.llmTokens ?? 0 },
  ];

  return (
    <div className="stats">
      {items.map((it) => (
        <div key={it.label} className="stat">
          <div className="stat-label">{it.label}</div>
          <div className="stat-value">{it.value.toLocaleString()}</div>
        </div>
      ))}
    </div>
  );
}
