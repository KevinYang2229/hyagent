/**
 * DATA_BACKEND（store 持久化後端切換）守門與 db row 映射。
 *
 * - env：db 模式必須帶 DATABASE_URL（boot fail-fast），預設維持 file 不影響既有部署。
 * - 映射：Tenant/ApiKey ↔ DB row 的 round-trip；undefined 欄位剔除語意與 file 後端一致。
 */
import { envSchema } from '@/config/env';
import {
  apiKeyFromRow,
  apiKeyToRow,
  tenantFromRow,
  tenantToRow,
} from '@/modules/tenant/tenant.store';
import type { Tenant, ApiKey } from '@/modules/tenant/tenant.types';
import { sessionFromRow, sessionToRow } from '@/modules/conversation/conversation.store';
import type { Session } from '@/modules/conversation/conversation.types';
import {
  submissionFromRow,
  submissionToRow,
  type SubmissionRecord,
} from '@/modules/workflow/submission.store';
import { auditFromRow, auditToRow, type AuditEntry } from '@/modules/audit/audit.store';

describe('DATA_BACKEND env 守門', () => {
  // 其他守門（LLM_PROVIDER=anthropic 需 key）的最小合法基底
  const base = { ANTHROPIC_API_KEY: 'test-anthropic-key' };

  it('預設 file，不需 DATABASE_URL', () => {
    const parsed = envSchema.parse(base);
    expect(parsed.DATA_BACKEND).toBe('file');
  });

  it('DATA_BACKEND=db 但缺 DATABASE_URL → 解析失敗（boot fail-fast）', () => {
    const result = envSchema.safeParse({ ...base, DATA_BACKEND: 'db' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join('.') === 'DATABASE_URL')).toBe(true);
    }
  });

  it('DATA_BACKEND=db + DATABASE_URL → 通過', () => {
    const parsed = envSchema.parse({
      ...base,
      DATA_BACKEND: 'db',
      DATABASE_URL: 'postgresql://user:pw@host:5432/postgres',
    });
    expect(parsed.DATA_BACKEND).toBe('db');
  });
});

describe('tenant ↔ db row 映射', () => {
  const fullTenant: Tenant = {
    id: 'abc123',
    name: '測試租戶',
    allowedOrigins: ['https://a.example.com', 'https://b.example.com'],
    publicKeys: [
      {
        kid: 'kid-round-trip',
        alg: 'RS256',
        publicKey: 'spki-pem-placeholder',
        status: 'active',
        createdAt: '2026-07-18T01:02:03.000Z',
      },
    ],
    clockSkewSeconds: 10,
    assertionLifetimeSeconds: 90,
    sessionExpiresIn: 7200,
    appearance: { primaryColor: '#123456' },
    disabledServices: ['knowledge'],
    disabledForms: ['business-trip-domestic'],
    grantedScopes: ['email:write'],
    scopesMigrated: true,
    llmConfig: { provider: 'openai', openaiApiKey: 'sk-xxx' },
    createdAt: '2026-07-18T01:02:03.000Z',
  };

  it('完整欄位 round-trip 不失真', () => {
    expect(tenantFromRow(tenantToRow(fullTenant))).toEqual(fullTenant);
  });

  it('穩定欄位開實體 column，其餘收進 config', () => {
    const row = tenantToRow(fullTenant);
    expect(row.id).toBe('abc123');
    expect(row.name).toBe('測試租戶');
    expect(row.createdAt.toISOString()).toBe('2026-07-18T01:02:03.000Z');
    const config = row.config as Record<string, unknown>;
    expect(config.id).toBeUndefined();
    expect(config.llmConfig).toEqual(fullTenant.llmConfig);
  });

  it('undefined 欄位（如 llmConfig 整包清除）與 file 後端同語意：序列化剔除', () => {
    const t: Tenant = { ...fullTenant, llmConfig: undefined };
    const row = tenantToRow(t);
    expect('llmConfig' in (row.config as Record<string, unknown>)).toBe(false);
    expect('llmConfig' in tenantFromRow(row)).toBe(false);
  });
});

describe('apiKey ↔ db row 映射', () => {
  it('未撤銷金鑰 round-trip：不帶 revokedAt 欄位', () => {
    const key: ApiKey = {
      key: 'sk_abc',
      tenantId: 'abc123',
      type: 'secret',
      createdAt: '2026-07-18T01:02:03.000Z',
    };
    const back = apiKeyFromRow(apiKeyToRow(key));
    expect(back).toEqual(key);
    expect('revokedAt' in back).toBe(false);
  });

  it('已撤銷金鑰 round-trip 保留 revokedAt', () => {
    const key: ApiKey = {
      key: 'pk_def',
      tenantId: 'abc123',
      type: 'publishable',
      createdAt: '2026-07-18T01:02:03.000Z',
      revokedAt: '2026-07-18T02:00:00.000Z',
    };
    expect(apiKeyFromRow(apiKeyToRow(key))).toEqual(key);
  });
});

describe('session ↔ db row 映射', () => {
  const session: Session = {
    id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    tenantId: 'abc123',
    userId: 'kevin',
    formId: 'leave-request',
    values: { leaveType: 'annual', startDate: '2026-07-20' },
    status: 'confirming',
    activeServiceId: 'form',
    locale: 'zh-TW',
    messages: [{ role: 'user', content: [{ type: 'text', text: '我要請假' }] }],
    createdAt: '2026-07-18T01:02:03.000Z',
  };

  it('round-trip 不失真（values / messages / status 全保留）', () => {
    expect(sessionFromRow(sessionToRow(session))).toEqual(session);
  });

  it('查詢欄位開實體 column；舊資料無 tenantId → 落 default（與讀取端一致）', () => {
    const row = sessionToRow(session);
    expect(row.tenantId).toBe('abc123');
    expect(row.userId).toBe('kevin');
    expect(row.formId).toBe('leave-request');
    expect(row.createdAt.toISOString()).toBe('2026-07-18T01:02:03.000Z');

    const legacy = { ...session, tenantId: undefined } as unknown as Session;
    expect(sessionToRow(legacy).tenantId).toBe('default');
  });
});

describe('submission ↔ db row 映射', () => {
  const rec: SubmissionRecord = {
    oaRequestId: 'STUB-123',
    formId: 'leave-request',
    formTitle: '請假單',
    userId: 'kevin',
    submittedAt: '2026-07-18T03:04:05.000Z',
  };

  it('round-trip 不失真，tenantId 掛在 row 上', () => {
    const row = submissionToRow('abc123', rec);
    expect(row.tenantId).toBe('abc123');
    expect(submissionFromRow(row)).toEqual(rec);
  });
});

describe('audit ↔ db row 映射', () => {
  it('成功紀錄 round-trip：不帶 error 欄位', () => {
    const entry: AuditEntry = {
      toolId: 'oa.submit',
      userId: 'kevin',
      at: '2026-07-19T01:02:03.000Z',
      ok: true,
      summary: '送出請假單',
    };
    const back = auditFromRow(auditToRow('abc123', entry));
    expect(back).toEqual(entry);
    expect('error' in back).toBe(false);
  });

  it('失敗紀錄 round-trip 保留 error', () => {
    const entry: AuditEntry = {
      toolId: 'email.send',
      userId: 'kevin',
      at: '2026-07-19T01:02:03.000Z',
      ok: false,
      summary: '寄信失敗',
      error: 'SMTP timeout',
    };
    expect(auditFromRow(auditToRow('abc123', entry))).toEqual(entry);
  });
});
