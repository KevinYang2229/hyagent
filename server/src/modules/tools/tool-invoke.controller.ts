/**
 * 直接呼叫唯讀工具（不經 AI）：給 App 的首頁摘要、列表、掃條碼查券等用。
 * 只放行 agent 可用的唯讀工具；寫入動作一律走確認流程（propose → confirm）。
 */
import type { Request, Response } from 'express';
import { z } from 'zod';
import { logger } from '@/lib/logger';
import { resolveScopes } from '@/modules/authz/resolve-scopes';
import { buildDisplayBlock } from '@/modules/display/display-block';
import { McpToolCallError } from '@/modules/mcp/mcp.connection';
import { isWriteTool, makeToolContext, toolRegistry, unwrapToolOutput, type ToolDef } from '@/modules/tools';
import { AppError } from '@/utils/app-error';

export const invokeParamSchema = z.object({ toolId: z.string().trim().min(1).max(200) });
export const invokeBodySchema = z.object({ input: z.record(z.unknown()).default({}) }).strict();

export const TOOL_UNAVAILABLE_MESSAGE = '相關服務暫時無法使用，請稍後再試';

function notFound(toolId: string): AppError {
  return new AppError(404, 'TOOL_NOT_FOUND', `找不到工具：${toolId}`);
}

export const toolInvokeController = {
  async invoke(req: Request, res: Response): Promise<void> {
    const tenantId = req.tenant?.id ?? 'default';
    const userId = req.user?.sub ?? '';
    if (!resolveScopes({ tenantId, userId }).includes('service:agent')) {
      throw AppError.forbidden('沒有使用智慧代理的權限');
    }
    const toolId = String(req.params.toolId);
    const { input } = req.body as z.infer<typeof invokeBodySchema>;
    const ctx = makeToolContext({ tenantId, userId });
    await toolRegistry.prepare(ctx);

    let tool: ToolDef;
    try {
      tool = toolRegistry.resolve(toolId, ctx);
    } catch {
      throw notFound(toolId);
    }
    // agentExposed 邊界與 propose 相同：未開放給 agent 的工具視同不存在
    if (!tool.agentExposed) throw notFound(toolId);
    if (isWriteTool(tool)) throw new AppError(422, 'NOT_A_READ_TOOL', '只能直接呼叫唯讀工具；寫入動作請走確認流程');

    let out: unknown;
    try {
      // 唯讀直呼不寫稽核：首頁每分鐘輪詢會擠掉真正的寫入稽核（寫入一律走 propose → confirm，照常稽核）
      out = await toolRegistry.invoke(toolId, input, ctx, { audit: false });
    } catch (err) {
      if (err instanceof McpToolCallError) {
        // 錯誤細節可能含內部主機／網址：只記在伺服器 log，對外回固定訊息
        logger.warn({ err, toolId, tenantId }, 'direct tool invoke failed: MCP unavailable');
        throw new AppError(503, 'TOOL_UNAVAILABLE', TOOL_UNAVAILABLE_MESSAGE);
      }
      throw err;
    }
    const { data, display } = unwrapToolOutput(out);
    const block = display !== undefined ? buildDisplayBlock(display, data) : undefined;
    res.status(200).json({ data: { result: data, ...(block ? { block } : {}) } });
  },
};
