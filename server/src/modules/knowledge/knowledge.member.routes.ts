/**
 * 登入者的開場推薦詞。
 *
 * 存在的理由只有一個：免登入的 GET /api/widget/config 拿不到身分，只能用訪客判準
 * （resolveGuestScopes，部門固定為 '—'）決定 knowledgeEnabled。管理者把知識庫指派給
 * 某個部門時，該部門成員在對話裡問得到答案（serviceRegistry.enabledFor → resolveScopes），
 * 開場 chip 卻因為訪客判準為 false 而整排消失。這支端點讓前端在登入後改用本人的權限覆蓋。
 *
 * 判準刻意直接用 serviceRegistry.enabledFor，而不是自己比對 scope 字串——對話守門走哪條路，
 * 這裡就走哪條路，兩者不該有第二種解讀。
 *
 * 句子集合仍是 publicSuggestedPrompts（訪客可見語料生成的公開集合），見該函式註解。
 */
import { Router } from 'express';
import { AppError } from '@/utils/app-error';
import { serviceRegistry } from '@/modules/conversation/service.registry';
import { knowledgeAgentService } from './knowledge.agent-service';
import { publicSuggestedPrompts } from './prompt-feed';

export const knowledgeMemberRouter = Router();

knowledgeMemberRouter.get('/suggested-prompts', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  // 與 skills.routes 同一組身分檢查：token 的租戶與 pk 解出的租戶不一致時一律拒絕
  if (!req.user || !req.tenant || (req.user.tenantId && req.user.tenantId !== req.tenant.id)) {
    throw AppError.unauthorized('Invalid identity');
  }
  const tenantId = req.tenant.id;
  const knowledgeEnabled = serviceRegistry
    .enabledFor(tenantId, req.user.sub)
    .some((service) => service.id === knowledgeAgentService.id);
  res.json({
    data: {
      knowledgeEnabled,
      suggestedPrompts: knowledgeEnabled ? publicSuggestedPrompts(tenantId) : [],
    },
  });
});
