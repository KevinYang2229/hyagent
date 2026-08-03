/**
 * 公開 widget 設定：依 resolveTenant 解出的租戶回外觀。
 * widget iframe 載入時讀取（帶 ?key=pk_…）；未設外觀則回內建預設。
 */
import type { Request, Response } from 'express';
import type { TenantAppearance } from '@oa-agent/shared';
import { knowledgeStore } from '@/modules/knowledge/knowledge.store';

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
    // 依索引內容生成的推薦問句；未生成時為 undefined，前端回落 i18n 預設句。
    // 整組語系一起回傳、不在後端挑：widget 語系可於執行期切換，後端挑定就切不動了
    const meta = req.tenant ? knowledgeStore.getMeta(req.tenant.id) : undefined;
    // 世代防護只堵得住 refreshSuggestedPrompts 彼此之間的競態，堵不住刪索引／爬取失敗
    // 這兩個外部寫入端（它們不遞增世代，也不清 suggestedPrompts）：LLM 若在這兩者之後
    // 才寫回，過期問句會留在 meta 裡、跨重啟存活。故一律以 status === 'ready' 為準，
    // 與 admin 卡片的門檻（僅 ready 時顯示）一致；同時比照 admin 卡片守 knowledgeEnabled，
    // 避免內部文件（docx/pdf）生成的問句在服務關閉後仍透過這個免登入端點外洩。
    const suggestedPrompts =
      knowledgeEnabled && meta?.status === 'ready' && meta.chunkCount > 0
        ? meta.suggestedPrompts
        : undefined;
    res.status(200).json({ data: { appearance, knowledgeEnabled, suggestedPrompts } });
  },
};
