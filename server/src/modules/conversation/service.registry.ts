/**
 * Agent 服務註冊表（掛載點）：把各獨立服務掛進來，供 intent-router 分派。
 *
 * 泛化自 form-submit.registry 的查表概念——但這裡註冊的是「對話服務」而非送出函式。
 * 新增服務（未來 Workflow）只要實作 AgentService 並在此 register 即可。
 */
import { knowledgeAgentService } from '@/modules/knowledge/knowledge.agent-service';
import { resolveScopes } from '@/modules/authz/resolve-scopes';
import type { AgentService } from './agent-service.types';
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
  /** 該使用者在該租戶可用的服務：alwaysEnabled 恆在；其餘需 resolveScopes 含其 serviceScope。 */
  enabledFor(tenantId: string, userId: string): AgentService[] {
    const scopes = new Set(resolveScopes({ tenantId, userId }));
    return [...registry.values()].filter(
      (s) => s.alwaysEnabled || (s.serviceScope !== undefined && scopes.has(s.serviceScope)),
    );
  },
};
