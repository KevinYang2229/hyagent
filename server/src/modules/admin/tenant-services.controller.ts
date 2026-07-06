/** 管理端：某租戶的服務/表單 catalog（含 enabled 狀態），供服務開關 UI 使用。 */
import type { Request, Response } from 'express';
import { serviceRegistry } from '@/modules/conversation/service.registry';
import { listDefinitions } from '@/modules/form/form.registry';
import { tenantStore } from '@/modules/tenant/tenant.store';

export const tenantServicesController = {
  async get(req: Request, res: Response): Promise<void> {
    const id = String(req.params.id);
    const t = tenantStore.getTenant(id);
    const disabledS = new Set(t?.disabledServices ?? []);
    const disabledF = new Set(t?.disabledForms ?? []);
    const services = serviceRegistry
      .all()
      // alwaysEnabled 服務（如範圍守門 assistant）不受 disabledServices 影響，
      // 回報值需反映執行期真相（enabledFor 亦強制開啟），避免 admin 顯示「已停用」的謊言。
      .map((s) => ({ id: s.id, label: s.label, enabled: s.alwaysEnabled ? true : !disabledS.has(s.id) }));
    const forms = listDefinitions(id).map((d) => ({
      formId: d.formId,
      title: d.data.title ?? d.agent.description,
      enabled: !disabledF.has(d.formId),
    }));
    res.json({ data: { services, forms } });
  },
};
