/**
 * 金鑰安全：API key 雜湊儲存 + 敏感欄位靜態加密（DATA_ENCRYPTION_KEY）。
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encryptSecret, decryptSecret, hashApiKey, isEncrypted } from '@/lib/crypto';
import { tenantStore } from '@/modules/tenant/tenant.store';

const TEST_ENC_KEY = 'a'.repeat(64);

/** 在獨立模組空間 + 指定 env 下重新載入 tenant.store（模擬一次開機） */
function bootStoreIsolated(envPatch: Record<string, string>): {
  store: typeof tenantStore;
  dataDir: string;
} {
  const dataDir = envPatch.OA_AGENT_DATA_DIR;
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(envPatch)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  let store!: typeof tenantStore;
  jest.isolateModules(() => {
    store = (require('@/modules/tenant/tenant.store') as typeof import('@/modules/tenant/tenant.store'))
      .tenantStore;
  });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return { store, dataDir };
}

describe('crypto 原語', () => {
  it('未設 DATA_ENCRYPTION_KEY：encrypt 原樣、decrypt 放行明文', () => {
    expect(encryptSecret('sk-ant-xxx')).toBe('sk-ant-xxx');
    expect(decryptSecret('sk-ant-xxx')).toBe('sk-ant-xxx');
  });

  it('設定金鑰後 roundtrip 不失真、密文帶 enc:v1: 前綴', () => {
    let enc!: typeof import('@/lib/crypto');
    process.env.DATA_ENCRYPTION_KEY = TEST_ENC_KEY;
    jest.isolateModules(() => {
      enc = require('@/lib/crypto') as typeof import('@/lib/crypto');
    });
    delete process.env.DATA_ENCRYPTION_KEY;
    const sealed = enc.encryptSecret('sk-ant-secret-00001');
    expect(enc.isEncrypted(sealed)).toBe(true);
    expect(sealed).not.toContain('sk-ant-secret');
    expect(enc.decryptSecret(sealed)).toBe('sk-ant-secret-00001');
    // 明文舊資料仍原樣放行
    expect(enc.decryptSecret('plain-legacy')).toBe('plain-legacy');
  });

  it('hashApiKey：確定性 64 hex，不同輸入不同輸出', () => {
    expect(hashApiKey('pk_abc')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiKey('pk_abc')).toBe(hashApiKey('pk_abc'));
    expect(hashApiKey('pk_abc')).not.toBe(hashApiKey('pk_abd'));
  });
});

describe('API key 雜湊儲存', () => {
  it('createApiKey 回傳原始金鑰、store 內只有雜湊、原始金鑰可驗證', () => {
    const t = tenantStore.createTenant('hash-test');
    const issued = tenantStore.createApiKey(t.id, 'secret');
    expect(issued.key).toMatch(/^sk_[0-9a-f]+$/); // 回傳值是原始金鑰
    const stored = tenantStore.getApiKey(issued.key);
    expect(stored).toBeDefined();
    expect(stored!.key).toBe(hashApiKey(issued.key)); // 內部存雜湊
    expect(stored!.key).not.toBe(issued.key);
  });

  it('種子金鑰 pk_default / sk_default 仍可驗證（雜湊比對）', () => {
    expect(tenantStore.getApiKey('pk_default')?.type).toBe('publishable');
    expect(tenantStore.getApiKey('sk_default')?.type).toBe('secret');
  });

  it('舊資料明文金鑰於載入時一次性轉為雜湊，仍可驗證', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oa-agent-keysec-'));
    const legacyKey = 'pk_legacy0123456789';
    writeFileSync(
      join(dir, 'oa-agent-tenants.json'),
      JSON.stringify({
        tenants: [{ id: 'legacy-t', name: '舊租戶', allowedOrigins: ['*'], createdAt: '2026-01-01T00:00:00.000Z' }],
        apiKeys: [{ key: legacyKey, tenantId: 'legacy-t', type: 'publishable', createdAt: '2026-01-01T00:00:00.000Z' }],
      }),
    );
    const { store } = bootStoreIsolated({ OA_AGENT_DATA_DIR: dir });
    const rec = store.getApiKey(legacyKey);
    expect(rec).toBeDefined();
    expect(rec!.key).toBe(hashApiKey(legacyKey));
    // 轉換後有重寫回磁碟：檔案裡不再有明文金鑰
    const onDisk = readFileSync(join(dir, 'oa-agent-tenants.json'), 'utf-8');
    expect(onDisk).not.toContain(legacyKey);
  });
});

describe('敏感欄位靜態加密（落地層）', () => {
  it('設定 DATA_ENCRYPTION_KEY：ssoSecret / BYO key 落地為密文、讀回為明文', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oa-agent-keysec-'));
    const { store } = bootStoreIsolated({ OA_AGENT_DATA_DIR: dir, DATA_ENCRYPTION_KEY: TEST_ENC_KEY });
    const t = store.createTenant('enc-test', [], 'sso-plain-secret');
    store.updateTenant(t.id, {
      llmConfig: { provider: 'anthropic', anthropicApiKey: 'sk-ant-byo-key-00001' },
    });

    // 記憶體一律明文（服務層直接可用）
    expect(store.getTenant(t.id)?.ssoSecret).toBe('sso-plain-secret');
    expect(store.getTenant(t.id)?.llmConfig?.anthropicApiKey).toBe('sk-ant-byo-key-00001');

    // 落地檔案不含明文、帶 enc:v1: 標記
    const onDisk = readFileSync(join(dir, 'oa-agent-tenants.json'), 'utf-8');
    expect(onDisk).not.toContain('sso-plain-secret');
    expect(onDisk).not.toContain('sk-ant-byo-key-00001');
    expect(onDisk).toContain('enc:v1:');

    // 模擬重開機：讀回解密後仍是明文
    const { store: rebooted } = bootStoreIsolated({
      OA_AGENT_DATA_DIR: dir,
      DATA_ENCRYPTION_KEY: TEST_ENC_KEY,
    });
    expect(rebooted.getTenant(t.id)?.ssoSecret).toBe('sso-plain-secret');
    expect(rebooted.getTenant(t.id)?.llmConfig?.anthropicApiKey).toBe('sk-ant-byo-key-00001');
  });

  it('未設金鑰時維持現狀：明文落地（dev 便利、向後相容）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oa-agent-keysec-'));
    const { store } = bootStoreIsolated({ OA_AGENT_DATA_DIR: dir });
    store.createTenant('plain-test', [], 'sso-visible');
    const onDisk = readFileSync(join(dir, 'oa-agent-tenants.json'), 'utf-8');
    expect(onDisk).toContain('sso-visible');
    expect(isEncrypted('sso-visible')).toBe(false);
  });
});
