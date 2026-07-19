/**
 * Agent 服務註冊表（掛載點）：把各獨立服務掛進來，供 intent-router 分派。
 *
 * 泛化自 form-submit.registry 的查表概念——但這裡註冊的是「對話服務」而非送出函式。
 * 新增服務（未來 Workflow）只要實作 AgentService 並在此 register 即可。
 */
import { knowledgeAgentService } from '@/modules/knowledge/knowledge.agent-service';
import { resolveScopes } from '@/modules/authz/resolve-scopes';
import type { AgentService, SkillDescriptor } from './agent-service.types';
import type { Session } from './conversation.types';
import { formAgentService } from './form.agent-service';
import { assistantAgentService } from './assistant.agent-service';
import { agentAgentService } from './agent.agent-service';

const registry = new Map<string, AgentService>();

function register(service: AgentService): void {
  registry.set(service.id, service);
}

register(formAgentService);
register(knowledgeAgentService);
register(assistantAgentService);
register(agentAgentService);

export const serviceRegistry = {
  get(id: string): AgentService {
    const service = registry.get(id);
    if (!service) throw new Error(`unknown agent service: ${id}`);
    return service;
  },
  tryGet(id: string): AgentService | undefined {
    return registry.get(id);
  },
  all(): AgentService[] {
    return [...registry.values()];
  },
  /**
   * Skill 契約的正式化出口：把註冊的服務轉成可序列化的 SkillDescriptor 清單。
   * intents 依租戶而異（form 依啟用表單），故需帶租戶視角；userId 供 scope 解析用。
   */
  describe(tenantId: string, userId: string): SkillDescriptor[] {
    // intents() 只讀 session 的 tenantId/userId；其餘欄位不觸及，最小 stub 即可
    const viewpoint = { tenantId, userId } as Session;
    return [...registry.values()].map((s) => ({
      id: s.id,
      label: s.label,
      description: s.description,
      sticky: s.sticky,
      alwaysEnabled: s.alwaysEnabled ?? false,
      ...(s.serviceScope !== undefined ? { requiredScope: s.serviceScope } : {}),
      intents: s.intents(viewpoint).map((i) => ({
        id: i.id,
        description: i.description,
        keywords: i.keywords,
      })),
    }));
  },

  /** 該使用者在該租戶可用的服務：alwaysEnabled 恆在；其餘需 resolveScopes 含其 serviceScope。 */
  enabledFor(tenantId: string, userId: string): AgentService[] {
    const scopes = new Set(resolveScopes({ tenantId, userId }));
    return [...registry.values()].filter(
      (s) => s.alwaysEnabled || (s.serviceScope !== undefined && scopes.has(s.serviceScope)),
    );
  },
};
