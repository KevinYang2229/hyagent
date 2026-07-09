/**
 * 公開 widget 設定：依 resolveTenant 解出的租戶回外觀。
 * widget iframe 載入時讀取（帶 ?key=pk_…）；未設外觀則回內建預設。
 */
import type { Request, Response } from 'express';
import type { TenantAppearance } from '@oa-agent/shared';

const DEFAULT_APPEARANCE: Required<Pick<TenantAppearance, 'theme' | 'position'>> = {
  theme: 'light',
  position: 'br',
};

export const widgetController = {
  async getConfig(req: Request, res: Response): Promise<void> {
    const appearance: TenantAppearance = { ...DEFAULT_APPEARANCE, ...(req.tenant?.appearance ?? {}) };
    // 已知的殘留缺口（cosmetic）：此路由只掛 resolveTenant、無 requireAuth，widget 載入時尚無終端使用者身分可查
    // scope，故沿用租戶層 disabledServices 判斷（僅影響提示文案是否顯示，非實際權限守門——
    // 真正的服務門檻在對話建立後由 serviceRegistry.enabledFor(tenantId, userId) 以 service:knowledge scope 把關）。
    const knowledgeEnabled = !(req.tenant?.disabledServices ?? []).includes('knowledge');
    res.status(200).json({ data: { appearance, knowledgeEnabled } });
  },
};
