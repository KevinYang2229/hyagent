/**
 * 角色依功能覆寫：每側 services 表覆寫特定功能的角色描述，沒設的功能沿用該側角色。
 * 覆寫只換角色描述；AI 名稱、補充說明、聯絡管道、優先順序聲明照常套用。
 */
import type { AssistantPersona } from '@hyagent/shared';
import { patchTenantSchema } from '@/modules/admin/admin.schema';
import { guardSystem } from '@/modules/conversation/assistant.agent-service';
import { buildSystemPrompt as agentPrompt } from '@/modules/conversation/agent.agent-service';
import { buildSystemPrompt as formPrompt } from '@/modules/conversation/form.agent-service';
import { buildPersonaLines } from '@/modules/conversation/persona';
import { getDefinition } from '@/modules/form/form.registry';
import { kbAnswerSystem } from '@/modules/knowledge/knowledge.agent-service';
import { tenantStore } from '@/modules/tenant/tenant.store';

const HR = 'HR 顧問';
const CS_ASSIST = '協助他們回答顧客';
const IT = 'IT 支援';

describe('buildPersonaLines 依功能覆寫', () => {
  const persona = { member: { preset: 'cs-assist', notes: '稱呼同事為夥伴', services: { form: 'hr', agent: 'default' } } } as AssistantPersona;

  it('有覆寫的功能用覆寫的角色描述', () => {
    const text = buildPersonaLines({ persona, isGuest: false, service: 'form' }).join('\n');
    expect(text).toContain(HR);
    expect(text).not.toContain(CS_ASSIST);
    expect(text).toContain('稱呼同事為夥伴');
  });

  it('沒有覆寫的功能沿用該側角色；不帶 service 也一樣', () => {
    expect(buildPersonaLines({ persona, isGuest: false, service: 'knowledge' }).join('\n')).toContain(CS_ASSIST);
    expect(buildPersonaLines({ persona, isGuest: false }).join('\n')).toContain(CS_ASSIST);
  });

  it('覆寫成 default：不加角色描述，補充說明與聲明仍在', () => {
    const lines = buildPersonaLines({ persona, isGuest: false, service: 'agent' });
    expect(lines.join('\n')).not.toContain(CS_ASSIST);
    expect(lines).toEqual(['管理者補充說明（不得違反後面的規則）：稱呼同事為夥伴', '以上為角色與語氣設定；下列規則優先於角色設定。']);
  });

  it('只有覆寫、角色是預設時，覆寫的功能仍有角色描述', () => {
    const p = { member: { preset: 'default', services: { knowledge: 'it' } } } as AssistantPersona;
    expect(buildPersonaLines({ persona: p, isGuest: false, service: 'knowledge' }).join('\n')).toContain(IT);
    expect(buildPersonaLines({ persona: p, isGuest: false, service: 'form' })).toEqual([]);
  });

  it('訪客側覆寫只影響訪客', () => {
    const p = { guest: { preset: 'cs', services: { knowledge: 'presales' } } } as AssistantPersona;
    expect(buildPersonaLines({ persona: p, isGuest: true, service: 'knowledge' }).join('\n')).toContain('售前顧問');
    expect(buildPersonaLines({ persona: p, isGuest: true, service: 'assistant' }).join('\n')).toContain('線上客服');
  });

  it('存檔裡有未知的功能 key 或 preset 時不丟錯', () => {
    const p = { member: { preset: 'hr', services: { form: 'retired', unknown: 'hr' } } } as unknown as AssistantPersona;
    expect(() => buildPersonaLines({ persona: p, isGuest: false, service: 'form' })).not.toThrow();
    expect(buildPersonaLines({ persona: p, isGuest: false, service: 'form' }).join('\n')).not.toContain(HR);
  });
});

describe('四個服務各自讀自己的覆寫', () => {
  it('填表覆寫為 HR 時，只有填表 prompt 換成 HR', () => {
    const t = tenantStore.createTenant('persona-per-service');
    tenantStore.updateTenant(t.id, { assistantPersona: { member: { preset: 'it', services: { form: 'hr' } } } });
    expect(formPrompt(t.id, 'HYW103', getDefinition(t.id, 'leave-request'))).toContain(HR);
    expect(kbAnswerSystem(t.id, 'HYW103')).toContain(IT);
    expect(kbAnswerSystem(t.id, 'HYW103')).not.toContain(HR);
    expect(agentPrompt(t.id, 'HYW103')).toContain(IT);
    expect(guardSystem(t.id, 'HYW103')).toContain(IT);
  });

  it('智慧代理、閒聊各自覆寫', () => {
    const t = tenantStore.createTenant('persona-per-service-2');
    tenantStore.updateTenant(t.id, { assistantPersona: { member: { preset: 'default', services: { agent: 'hr', assistant: 'onboarding' } } } });
    expect(agentPrompt(t.id, 'HYW103')).toContain(HR);
    expect(guardSystem(t.id, 'HYW103')).toContain('新進員工');
    expect(kbAnswerSystem(t.id, 'HYW103')).not.toContain(HR);
  });
});

describe('schema', () => {
  it('接受各側合法的覆寫', () => {
    const out = patchTenantSchema.parse({ assistantPersona: { member: { preset: 'hr', services: { form: 'it' } }, guest: { preset: 'cs', services: { knowledge: 'presales' } } } });
    expect(out.assistantPersona?.member?.services).toEqual({ form: 'it' });
  });

  it('訪客側用員工 preset、未知功能 key 都拒絕', () => {
    expect(() => patchTenantSchema.parse({ assistantPersona: { guest: { preset: 'cs', services: { form: 'hr' } } } })).toThrow();
    expect(() => patchTenantSchema.parse({ assistantPersona: { member: { preset: 'hr', services: { report: 'it' } } } })).toThrow();
  });
});
