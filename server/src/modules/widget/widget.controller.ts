/**
 * 公開 widget 設定：依 resolveTenant 解出的租戶回外觀。
 * widget iframe 載入時讀取（帶 ?key=pk_…）；未設外觀則回內建預設。
 */
import type { Request, Response } from 'express';
import type { TenantAppearance } from '@hyagent/shared';
import { resolveGuestScopes } from '@/modules/authz/resolve-scopes';
import { publicSuggestedPrompts } from '@/modules/knowledge/prompt-feed';

const DEFAULT_APPEARANCE: Required<Pick<TenantAppearance, 'theme' | 'position'>> = {
  theme: 'light',
  position: 'br',
};

export const widgetController = {
  async getConfig(req: Request, res: Response): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    const appearance: TenantAppearance = { ...DEFAULT_APPEARANCE, ...(req.tenant?.appearance ?? {}) };
    // 此路由只掛 resolveTenant、無 requireAuth：讀到這份設定的一律是訪客（未建檔帳號），
    // 故判準必須與訪客在對話裡實際拿得到的能力同一套——resolveGuestScopes 的聯集模型
    // （租戶層 grantedScopes ∪ 訪客部門零散授權 ∪ 訪客部門角色能力），也就是對話建立後
    // serviceRegistry.enabledFor(tenantId, '') 走的那條路。
    //
    // 先前這裡只看租戶層 grantedScopes，看不到部門層的任何授予：管理者用「角色能力」把
    // service:knowledge 指派給訪客部門、權限頁維持「未開通」時，訪客問得到答案，chip 與
    // 推薦詞卻整排不出現。反向不會外洩——只指派給一般部門時訪客部門仍解不到這個 scope。
    //
    // 權威來源是 grantedScopes（opt-in）。先前這裡讀的是 disabledServices（舊 opt-out 模型），
    // 但 scope-migration 反轉模型後就沒人再寫那個欄位了（後台 PermissionsTab 只寫 grantedScopes、
    // 新租戶根本沒有該欄位），於是 knowledgeEnabled 恆為 true——知識庫關掉了 chip 還在。
    // grantedScopes 不存在＝該租戶還沒跑過開機遷移，此時才退回舊欄位。
    const knowledgeEnabled = req.tenant?.grantedScopes
      ? resolveGuestScopes(req.tenant.id).includes('service:knowledge')
      : !(req.tenant?.disabledServices ?? []).includes('knowledge');
    // 依索引內容生成的推薦問句；恆為陣列（無內容時為空陣列），順序固定網站在前、檔案在後，
    // 前端依陣列長度決定是否顯示 chip（無寫死後備句）。
    // 整組語系一起回傳、不在後端挑：widget 語系可於執行期切換，後端挑定就切不動了。
    // 句子集合與登入後的 GET /api/knowledge/suggested-prompts 共用 publicSuggestedPrompts
    // （含索引狀態與 ACL 守門）；此處另守 knowledgeEnabled，避免內部文件生成的問句在服務
    // 關閉後仍透過這個免登入端點外洩。
    const suggestedPrompts = knowledgeEnabled && req.tenant ? publicSuggestedPrompts(req.tenant.id) : [];
    res.status(200).json({ data: { appearance, knowledgeEnabled, suggestedPrompts } });
  },
};
