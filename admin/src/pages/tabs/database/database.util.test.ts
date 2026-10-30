import { describe, expect, it } from 'vitest';
import type { DbiCatalog, McpServerListView } from '../../../api';
import { buildCatalogReview, connectionSummary, dbiServersFor, diffSummary, parseList, unreviewedCount } from './database.util';

const catalog = (): DbiCatalog => ({
  dataSourceId: 'ds1',
  tenantId: 't1',
  version: 1,
  schemaVersion: 'x',
  published: false,
  updatedAt: '2026-10-30T00:00:00Z',
  datasets: [
    {
      id: 'public.projects',
      key: 'projects',
      schemaName: 'public',
      objectName: 'projects',
      kind: 'table',
      comment: null,
      description: null,
      descriptionStatus: 'none',
      synonyms: [],
      approvalStatus: 'pending',
      primaryKey: ['id'],
      metrics: [],
      columns: [
        { name: 'id', dataType: 'integer', typeCategory: 'numeric', nullable: false, comment: null, description: null, descriptionStatus: 'none', synonyms: [], sensitivity: 'internal', isQueryable: false, reviewStatus: 'new' },
        { name: 'name', dataType: 'text', typeCategory: 'text', nullable: false, comment: '忽略規則', description: null, descriptionStatus: 'none', synonyms: [], sensitivity: 'internal', isQueryable: false, reviewStatus: 'new' },
      ],
    },
  ],
  relationships: [{ id: 'm1', from: { dataset: 'public.projects', columns: ['id'] }, to: { dataset: 'public.x', columns: ['id'] }, origin: 'manual', approvalStatus: 'pending' }],
});

describe('buildCatalogReview', () => {
  it('沒有變更回 null', () => {
    expect(buildCatalogReview(catalog(), catalog())).toBeNull();
  });

  it('只送出有變更的欄位；空白描述送 null', () => {
    const edited = catalog();
    edited.datasets[0].approvalStatus = 'approved';
    edited.datasets[0].description = '  專案主檔 ';
    edited.datasets[0].columns[1].isQueryable = true;
    edited.datasets[0].columns[1].description = ' ';
    edited.datasets[0].columns[1].synonyms = ['名稱'];
    edited.relationships[0].approvalStatus = 'approved';
    const original = catalog();
    original.datasets[0].columns[1].description = '舊描述';
    expect(buildCatalogReview(original, edited)).toEqual({
      datasets: [{ id: 'public.projects', approvalStatus: 'approved', description: '專案主檔', columns: { name: { isQueryable: true, description: null, synonyms: ['名稱'] } } }],
      relationships: [{ id: 'm1', approvalStatus: 'approved' }],
    });
  });

  it('未審核欄位數', () => {
    expect(unreviewedCount(catalog())).toBe(2);
  });
});

describe('dbiServersFor', () => {
  const server = (id: string, ownerTenantId: string | null, tools: string[]) => ({
    config: { id, name: id, url: '', ownerTenantId, description: '', keywords: [], timeoutMs: 1, enabled: true, toolOverrides: {}, createdAt: '' },
    status: { state: 'ok' as const },
    tools: tools.map((name) => ({ name, llmName: name, effect: 'read' as const, declaredReadOnly: true, fingerprint: '', approvalValid: true, disabled: false })),
  });
  const view: McpServerListView = {
    signingEnabled: true,
    servers: [
      server('db-intelligence', null, []),
      server('custom-db', 't1', ['search_schema', 'execute_safe_query']),
      server('rooms', null, ['rooms_book']),
      server('other-tenant-db', 't2', ['search_schema', 'execute_safe_query']),
    ],
  };

  it('依工具判斷，未取得工具清單時看 serverId；排除其他租戶專屬的服務', () => {
    expect(dbiServersFor(view, 't1').map((s) => s.id)).toEqual(['db-intelligence', 'custom-db']);
    expect(dbiServersFor(null, 't1')).toEqual([]);
  });
});

describe('摘要', () => {
  it('parseList', () => {
    expect(parseList('public, hr\npublic，sales')).toEqual(['public', 'hr', 'sales']);
  });

  it('掃描差異', () => {
    expect(diffSummary({ fromVersion: 1, toVersion: 1, changed: false, addedDatasets: [], removedDatasets: [], addedColumns: [], removedColumns: [], changedColumns: [], addedRelationships: [], removedRelationships: [], invalidatedMetrics: [] })).toEqual(['結構沒有變更']);
    const lines = diffSummary({
      fromVersion: 2,
      toVersion: 3,
      changed: true,
      addedDatasets: [],
      removedDatasets: [],
      addedColumns: [{ dataset: 'public.projects', column: 'budget' }],
      removedColumns: [],
      changedColumns: [{ dataset: 'public.projects', column: 'actual_hours', from: 'numeric', to: 'text' }],
      addedRelationships: [],
      removedRelationships: [],
      invalidatedMetrics: [],
    });
    expect(lines).toEqual(['新增欄位 1 個（預設不可查詢，需審核）', '型別變更：public.projects.actual_hours（numeric → text），已退回不可查詢', 'Catalog 版本 v2 → v3']);
  });

  it('連線測試：可寫入的帳號要警告', () => {
    expect(connectionSummary({ ok: false, latencyMs: 3, error: 'auth_failed' })).toEqual({ ok: false, text: '帳號或密碼錯誤', warnings: [] });
    const r = connectionSummary({ ok: true, latencyMs: 5, serverVersion: 'PostgreSQL 17.2', defaultReadOnly: true, writableObjects: ['public.projects'] });
    expect(r.text).toBe('連線成功（PostgreSQL 17.2，5 ms）');
    expect(r.warnings[0]).toContain('public.projects');
    const maria = connectionSummary({ ok: true, latencyMs: 3, serverVersion: 'MariaDB 12.2.2', writableObjects: [], warnings: ['資料來源設定為 MySQL，但伺服器是 MariaDB，請修正資料庫類型'] });
    expect(maria).toEqual({ ok: true, text: '連線成功（MariaDB 12.2.2，3 ms）', warnings: ['資料來源設定為 MySQL，但伺服器是 MariaDB，請修正資料庫類型'] });
  });
});
