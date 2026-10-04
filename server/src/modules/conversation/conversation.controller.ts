import type { Request, Response } from 'express';
import { AppError } from '@/utils/app-error';
import { conversationService } from './conversation.service';
import type { ConfirmBody, MessageInput, ProposeBody, StartInput, UpdateFieldsInput } from './conversation.schema';

// app.ts 已在本路由掛 requireAuth，req.user.sub 一定存在——這是權限計算的身分來源，
// 不是可信輸入。x-user-id / demo-user 只是這條路由建好、requireAuth 尚未掛上時期的
// 遺留 fallback，實際上是死碼（requireAuth 沒過就進不到這裡），留著也不構成安全風險，
// 但在一個剛把身分變成權限依據的分支裡，字面讀起來容易被誤讀成「可用 header 指定身分」。
function resolveUserId(req: Request): string {
  return req.user?.sub ?? req.header('x-user-id') ?? 'demo-user';
}

// 租戶由 resolveTenant middleware 注入；未帶 key 落到預設租戶（向後相容）
function resolveTenantId(req: Request): string {
  return req.tenant?.id ?? 'default';
}

export const conversationController = {
  async start(req: Request, res: Response): Promise<void> {
    const tenantId = resolveTenantId(req);
    const userId = resolveUserId(req);
    const { message, formId, lang } = req.body as StartInput;
    const { session, turn } = await conversationService.start(
      tenantId,
      userId,
      message,
      formId,
      lang,
    );
    res.status(201).json({
      data: {
        id: session.id,
        formId: session.formId,
        status: session.status,
        values: session.values,
        reply: turn?.reply ?? null,
        suggestions: turn?.suggestions ?? [],
        ...(turn?.report ? { report: turn.report } : {}),
        // 第一則訊息就可能查出表格或提議寫入：與 sendMessage 一樣帶回，否則前端看不到
        ...(turn?.pendingAction ? { pendingAction: turn.pendingAction } : {}),
        ...(turn?.blocks ? { blocks: turn.blocks } : {}),
      },
    });
  },

  async sendMessage(req: Request, res: Response): Promise<void> {
    const tenantId = resolveTenantId(req);
    const userId = resolveUserId(req);
    const { message, lang } = req.body as MessageInput;
    const turn = await conversationService.sendMessage(
      tenantId,
      userId,
      String(req.params.id),
      message,
      lang,
    );
    // turn 已是 runTurn 回傳的完整 TurnResult，report 若有值已隨物件帶入，這裡不需另外挑欄位
    res.status(200).json({ data: turn });
  },

  /** 確認送出（不經 LLM，確認畫面按「送出」用）；回傳含 submission 的 turn */
  async submit(req: Request, res: Response): Promise<void> {
    const tenantId = resolveTenantId(req);
    const userId = resolveUserId(req);
    const turn = await conversationService.submit(tenantId, userId, String(req.params.id));
    res.status(200).json({ data: turn });
  },

  /** 確認卡片「確認」（不經 LLM）；body.input 為使用者修改後的參數（選填） */
  async confirmAction(req: Request, res: Response): Promise<void> {
    const { input } = req.body as ConfirmBody;
    const turn = await conversationService.confirmAction(
      resolveTenantId(req),
      resolveUserId(req),
      String(req.params.id),
      String(req.params.actionId),
      input,
    );
    res.status(200).json({ data: turn });
  },

  /** 不經 AI 直接提議寫入動作 */
  async proposeAction(req: Request, res: Response): Promise<void> {
    const { toolId, input } = req.body as ProposeBody;
    const data = await conversationService.proposeAction(
      resolveTenantId(req),
      resolveUserId(req),
      String(req.params.id),
      toolId,
      input,
    );
    res.status(200).json({ data });
  },

  /** 確認卡片「取消」 */
  async cancelAction(req: Request, res: Response): Promise<void> {
    const turn = conversationService.cancelAction(
      resolveTenantId(req),
      resolveUserId(req),
      String(req.params.id),
      String(req.params.actionId),
    );
    res.status(200).json({ data: turn });
  },

  async updateFields(req: Request, res: Response): Promise<void> {
    const tenantId = resolveTenantId(req);
    const userId = resolveUserId(req);
    const { fields } = req.body as UpdateFieldsInput;
    const result = conversationService.updateFields(
      tenantId,
      userId,
      String(req.params.id),
      fields,
    );
    res.status(200).json({ data: result });
  },

  async get(req: Request, res: Response): Promise<void> {
    const tenantId = resolveTenantId(req);
    const userId = resolveUserId(req);
    const session = conversationService.get(tenantId, userId, String(req.params.id));
    res.status(200).json({
      data: {
        id: session.id,
        formId: session.formId,
        status: session.status,
        values: session.values,
        submission: session.submission,
      },
    });
  },

  async cancel(req: Request, res: Response): Promise<void> {
    const tenantId = resolveTenantId(req);
    const userId = resolveUserId(req);
    const session = conversationService.cancel(tenantId, userId, String(req.params.id));
    res.status(200).json({ data: { id: session.id, status: session.status } });
  },

  /** 上傳附件（multipart，欄位名 file）；回傳附件 metadata 供前端加入表單值 */
  async uploadAttachment(req: Request, res: Response): Promise<void> {
    const tenantId = resolveTenantId(req);
    const userId = resolveUserId(req);
    const file = req.file;
    if (!file) throw AppError.unprocessable('缺少上傳檔案（欄位名須為 file）');
    const meta = conversationService.addAttachment(tenantId, userId, String(req.params.id), {
      name: file.originalname,
      mime: file.mimetype,
      buffer: file.buffer,
    });
    res.status(201).json({ data: meta });
  },

  /** 刪除附件 */
  async deleteAttachment(req: Request, res: Response): Promise<void> {
    const tenantId = resolveTenantId(req);
    const userId = resolveUserId(req);
    conversationService.removeAttachment(
      tenantId,
      userId,
      String(req.params.id),
      String(req.params.attachmentId),
    );
    res.status(200).json({ data: { id: String(req.params.attachmentId) } });
  },
};
