/**
 * 租戶自助設定端點（Surface：對外整合方的工程師自己呼叫）。
 * 只認 sk_ 秘密金鑰：pk_ 會出現在瀏覽器端，絕不能拿來改設定或讀金鑰遮罩。
 */
import type { Request, Response } from 'express';
import { AppError } from '@/utils/app-error';
import type { PutLLMConfigInput } from './llm-config.schema';
import { llmConfigService } from './llm-config.service';

function requireSecretKeyTenant(req: Request): string {
  if (req.apiKeyType !== 'secret') {
    throw AppError.forbidden('此端點僅限 sk_ 秘密金鑰存取');
  }
  return req.tenant!.id;
}

export const tenantSelfController = {
  async getLlmConfig(req: Request, res: Response): Promise<void> {
    const tenantId = requireSecretKeyTenant(req);
    res.status(200).json({ data: llmConfigService.get(tenantId) });
  },

  async putLlmConfig(req: Request, res: Response): Promise<void> {
    const tenantId = requireSecretKeyTenant(req);
    const view = await llmConfigService.update(tenantId, req.body as PutLLMConfigInput, 'sk-api');
    res.status(200).json({ data: view });
  },
};
