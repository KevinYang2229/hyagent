import { useCallback, useEffect, useMemo, useState } from 'react';
import { useToast } from '@hyagent/ui';
import { api, type DbiDataSource, type McpServerListView } from '../../../api';
import AuditSection from './AuditSection';
import CatalogSection from './CatalogSection';
import DataSourcesSection from './DataSourcesSection';
import PoliciesSection from './PoliciesSection';
import PreviewSection from './PreviewSection';
import { dbiServersFor } from './database.util';
import { staleApprovals } from '../../mcpForm.util';

type Section = 'sources' | 'catalog' | 'policies' | 'preview' | 'audit';
const SECTIONS: { key: Section; label: string }[] = [
  { key: 'sources', label: '資料來源' },
  { key: 'catalog', label: 'Catalog 審核' },
  { key: 'policies', label: '存取政策' },
  { key: 'preview', label: '查詢預覽' },
  { key: 'audit', label: '查詢稽核' },
];

/**
 * 資料庫查詢（Database Intelligence）：讓 AI 在受控權限內查詢客戶既有資料庫。
 * 設定都存在客戶端的 db-intelligence 服務，這裡經 HyAgent server 轉發管理。
 */
export default function DatabaseTab({ tenantId, onError }: { tenantId: string; onError: (e: unknown) => void }) {
  const toast = useToast();
  const [view, setView] = useState<McpServerListView | null>(null);
  const [serverId, setServerId] = useState<string | null>(null);
  const [section, setSection] = useState<Section>('sources');
  const [sources, setSources] = useState<DbiDataSource[] | null>(null);
  const [reviewing, setReviewing] = useState<string | null>(null);

  const servers = useMemo(() => dbiServersFor(view, tenantId), [view, tenantId]);
  const current = serverId && servers.some((s) => s.id === serverId) ? serverId : (servers[0]?.id ?? null);

  useEffect(() => {
    api.listMcpServers().then(setView, onError);
  }, [onError]);

  const loadSources = useCallback(async () => {
    if (!current) return;
    try {
      setSources(await api.dbiListDataSources(current, tenantId));
    } catch (e) {
      setSources([]);
      onError(e);
    }
  }, [current, tenantId, onError]);

  useEffect(() => {
    setSources(null);
    void loadSources();
  }, [loadSources]);

  if (!view) {
    return (
      <div className="card">
        <div className="empty">載入中…</div>
      </div>
    );
  }

  if (!current) {
    return (
      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">資料庫查詢</div>
            <div className="card-desc">讓 AI 在受控權限內查詢客戶既有的資料庫，不必為每種問題開發 API。</div>
          </div>
        </div>
        <div className="empty">
          尚未登記 Database Intelligence 服務。請到「MCP 服務」登記 db-intelligence 服務並重新整理工具清單，再到「權限」分頁授予 <span className="code-pill">mcp:&lt;serverId&gt;</span>。
        </div>
      </div>
    );
  }

  const currentView = view.servers.find((s) => s.config.id === current);
  const staleTools = currentView ? staleApprovals(currentView) : [];

  return (
    <div className="settings-stack">
      {staleTools.length > 0 && (
        <div className="banner banner-err" role="alert" style={{ marginBottom: 0 }}>
          <div>
            <strong>AI 查詢目前需要使用者逐次確認，且確認後看不到結果。</strong>
            工具 {staleTools.join('、')} 的唯讀核准已失效（服務更新後工具定義已變更），請到左側「MCP 服務」重新核准。
          </div>
        </div>
      )}
      <div className="toolbar">
        <div className="tabs" style={{ marginBottom: 0 }}>
          {SECTIONS.map((s) => (
            <button key={s.key} className={`tab${section === s.key ? ' active' : ''}`} onClick={() => setSection(s.key)}>
              {s.label}
            </button>
          ))}
        </div>
        <span style={{ flex: 1 }} />
        {servers.length > 1 && (
          <select className="select" style={{ maxWidth: 240 }} aria-label="Database Intelligence 服務" value={current} onChange={(e) => setServerId(e.target.value)}>
            {servers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}（{s.id}）
              </option>
            ))}
          </select>
        )}
      </div>

      {!sources ? (
        <div className="card">
          <div className="empty">載入中…</div>
        </div>
      ) : (
        <>
          {section === 'sources' && (
            <DataSourcesSection
              serverId={current}
              tenantId={tenantId}
              sources={sources}
              reload={loadSources}
              onReview={(id) => {
                setReviewing(id);
                setSection('catalog');
              }}
              onError={onError}
            />
          )}
          {section === 'catalog' && (
            <CatalogSection serverId={current} sources={sources} dataSourceId={reviewing} onSelect={setReviewing} onChanged={loadSources} onError={onError} />
          )}
          {section === 'policies' && <PoliciesSection serverId={current} tenantId={tenantId} sources={sources} onSaved={(m) => toast.success(m)} onError={onError} />}
          {section === 'preview' && <PreviewSection serverId={current} tenantId={tenantId} sources={sources} onError={onError} />}
          {section === 'audit' && <AuditSection serverId={current} tenantId={tenantId} onError={onError} />}
        </>
      )}
    </div>
  );
}
