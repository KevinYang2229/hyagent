/**
 * Form Designer 管理 API：租戶表單的 列出 / 取得 / 建立 / 更新 / 刪除 / 匯出。
 * 全部受 requireAdmin 保護。寫入前以 validateDefinition 把關 8 層自洽性。
 */
import type { Request, Response } from 'express';
import { formScopeId } from '@/modules/authz/scope-catalog';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { AppError } from '@/utils/app-error';
import {
  getBaseDefinition,
  getDefinition,
  listDefinitions,
} from './form.registry';
import { formStore } from './form.store';
import type { Definition } from './form.types';
import { validateDefinition } from './form.validator';

function ensureTenant(id: string): string {
  if (!tenantStore.getTenant(id)) throw AppError.notFound('租戶不存在');
  return id;
}

/** 把 Definition 拆回 schemas/<formId>/ 的多檔形狀（供匯出、commit 進 repo） */
function toSchemaFiles(def: Definition): Record<string, unknown> {
  const files: Record<string, unknown> = {
    'data.schema.json': def.data,
    'field.schema.json': def.field,
    'validation.schema.json': def.validation,
    'agent.schema.json': def.agent,
  };
  if (def.layout) files['layout.schema.json'] = def.layout;
  if (def.workflow) files['workflow.schema.json'] = def.workflow;
  if (def.policy) files['policy.schema.json'] = def.policy;
  if (def.oa) files['oa.schema.json'] = def.oa;
  return files;
}

function assertValid(def: Definition): void {
  const issues = validateDefinition(def);
  if (issues.length > 0) {
    throw AppError.unprocessable('表單 schema 驗證未通過', issues);
  }
}

export const formAdminController = {
  /** 列出該租戶可見的表單（base + 自建），標示來源與是否可編輯/刪除 */
  async list(req: Request, res: Response): Promise<void> {
    const tenantId = ensureTenant(String(req.params.id));
    const data = listDefinitions(tenantId).map((d) => {
      const isOverride = !!formStore.getOverride(tenantId, d.formId);
      const isBase = !!getBaseDefinition(d.formId);
      return {
        formId: d.formId,
        title: d.data.title ?? d.formId,
        description: d.agent.description,
        // base：內建共用；tenant：租戶自建；override：覆寫了同名 base
        source: isOverride ? (isBase ? 'override' : 'tenant') : 'base',
        editable: isOverride, // 只有租戶自有的可改/刪；base 需先「複製為租戶版」
      };
    });
    res.status(200).json({ data });
  },

  /** 取得單一完整 Definition（租戶覆寫優先、base 後備） */
  async get(req: Request, res: Response): Promise<void> {
    const tenantId = ensureTenant(String(req.params.id));
    const def = getDefinition(tenantId, String(req.params.formId));
    res.status(200).json({ data: def });
  },

  /** 建立：該租戶尚無同 formId 覆寫時才允許（避免誤覆蓋；要改用 PUT） */
  async create(req: Request, res: Response): Promise<void> {
    const tenantId = ensureTenant(String(req.params.id));
    const def = req.body as Definition;
    if (formStore.getOverride(tenantId, def.formId)) {
      throw AppError.conflict(`表單 ${def.formId} 已存在，請改用更新`);
    }
    assertValid(def);
    const saved = formStore.saveDefinition(tenantId, def);
    // 新建表單自動授予該租戶對應的 form:<id> scope，Designer 建的表單立即可用
    const t = tenantStore.getTenant(tenantId);
    const granted = new Set(t?.grantedScopes ?? []);
    granted.add(formScopeId(def.formId));
    tenantStore.updateTenant(tenantId, { grantedScopes: [...granted] });
    res.status(201).json({ data: saved });
  },

  /** 更新（upsert）：路由 formId 必須與 body.formId 一致 */
  async update(req: Request, res: Response): Promise<void> {
    const tenantId = ensureTenant(String(req.params.id));
    const formId = String(req.params.formId);
    const def = req.body as Definition;
    if (def.formId !== formId) {
      throw AppError.unprocessable('body.formId 與路由 formId 不一致');
    }
    assertValid(def);
    const saved = formStore.saveDefinition(tenantId, def);
    res.status(200).json({ data: saved });
  },

  /** 刪除租戶自有定義；base 不可刪（刪除後若有同名 base 會自動回退顯示 base） */
  async remove(req: Request, res: Response): Promise<void> {
    const tenantId = ensureTenant(String(req.params.id));
    const formId = String(req.params.formId);
    const ok = formStore.deleteDefinition(tenantId, formId);
    if (!ok) throw AppError.notFound('租戶無此自建表單');
    // 撤銷該表單的授予，避免留下孤兒 form:<id>（否則日後編輯權限會被自己的舊授予擋 400）
    const scope = formScopeId(formId);
    const granted = tenantStore.getTenant(tenantId)?.grantedScopes;
    if (granted?.includes(scope)) {
      tenantStore.updateTenant(tenantId, { grantedScopes: granted.filter((s) => s !== scope) });
    }
    res.status(200).json({ data: { formId } });
  },

  /** 匯出成 schemas/<formId>/ 多檔 JSON（供開發者 commit 進 repo） */
  async export(req: Request, res: Response): Promise<void> {
    const tenantId = ensureTenant(String(req.params.id));
    const def = getDefinition(tenantId, String(req.params.formId));
    res.status(200).json({ data: { formId: def.formId, files: toSchemaFiles(def) } });
  },
};
