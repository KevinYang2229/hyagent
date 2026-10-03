/**
 * 影像辨識：照片 → LLM（強制呼叫回報工具，取得固定格式）→ 經 Tool Registry 呼叫門市 MCP 補齊資料。
 * 照片只在記憶體處理；MCP 不可用時仍回傳辨識結果並附 warnings。
 */
import { z } from 'zod';
import { env } from '@/config/env';
import { getLLMProvider, type LLMProvider, type LLMResult } from '@/lib/llm';
import { logger } from '@/lib/logger';
import { buildDisplayBlock } from '@/modules/display/display-block';
import { makeToolContext, toolRegistry, unwrapToolOutput, type ToolContext } from '@/modules/tools';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { usageStore } from '@/modules/usage/usage.store';
import { AppError } from '@/utils/app-error';
import { COUPON_SYSTEM, REPORT_COUPON_TOOL, REPORT_SHELF_TOOL, SHELF_SYSTEM } from './prompts';
import type { CouponResult, ShelfFinding, ShelfResult, VisionMediaType } from './vision.types';

interface Principal {
  tenantId: string;
  userId: string;
}
interface ImageInput {
  mediaType: VisionMediaType;
  data: Buffer;
}

const DEFAULT_REPLENISH_QTY = 10;
/** 門市 product_lookup 單次最多 30 個名稱（maxItems），超過要分批 */
export const PRODUCT_LOOKUP_BATCH = 30;
/** 單張照片最多採用幾筆辨識結果；LLM 回得更多時截斷而非失敗 */
export const MAX_SHELF_ITEMS = 50;
/** 門市 replenishment_create 單張單最多 30 項 */
const MAX_REPLENISH_ITEMS = 30;

const shelfReportSchema = z.object({
  items: z.array(
    z.object({
      name: z.string().trim().min(1),
      status: z.enum(['out_of_stock', 'misplaced', 'ok']),
      box: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
      note: z.string().optional(),
    }),
  ),
});
const couponReportSchema = z.object({
  code: z.string().optional(),
  title: z.string().optional(),
  expiry: z.string().optional(),
});

function toolId(name: string): string {
  return `mcp.${env.VISION_STORE_SERVER_ID}.${name}`;
}

// 夾到 [0,1] 並四捨五入到 4 位小數，避免浮點誤差（0.1 變 0.0999…）
const clamp = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 1e4) / 1e4;

/** 夾回 [0,1]：左上角先夾，寬高再夾到不超出右下邊界 */
export function clampBox(b: { x: number; y: number; w: number; h: number }): ShelfFinding['box'] {
  const x = clamp(b.x);
  const y = clamp(b.y);
  return { x, y, w: clamp(Math.min(b.w + Math.min(b.x, 0), 1 - x)), h: clamp(Math.min(b.h + Math.min(b.y, 0), 1 - y)) };
}

async function report<T>(
  principal: Principal,
  system: string,
  tool: typeof REPORT_SHELF_TOOL,
  image: ImageInput,
  instruction: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const llm: LLMProvider = getLLMProvider(tenantStore.getTenant(principal.tenantId)?.llmConfig);
  let result: LLMResult;
  try {
    result = await llm.createMessage({
      system,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', mediaType: image.mediaType, data: image.data.toString('base64') },
          { type: 'text', text: instruction },
        ],
      }],
      tools: [tool],
      toolChoice: { name: tool.name },
      maxTokens: 2048,
    });
  } catch (err) {
    logger.warn({ err }, 'vision llm call failed');
    throw new AppError(502, 'VISION_FAILED', '影像辨識服務暫時無法使用，請稍後再試');
  }
  usageStore.recordLLMUsage(principal.tenantId, result);
  const call = result.toolCalls.find((c) => c.name === tool.name);
  const parsed = call ? schema.safeParse(call.input) : undefined;
  if (!parsed?.success) {
    logger.warn({ tool: tool.name, text: result.text.slice(0, 200) }, 'vision report missing or malformed');
    throw new AppError(502, 'VISION_FAILED', '無法辨識這張照片，請重新拍攝');
  }
  return parsed.data;
}

/** 呼叫門市工具；工具不可用或失敗時回 undefined 並寫入 warnings */
async function callStore(ctx: ToolContext, name: string, input: Record<string, unknown>, warnings: string[]): Promise<{ data: unknown; display?: unknown } | undefined> {
  try {
    return unwrapToolOutput(await toolRegistry.invoke(toolId(name), input, ctx));
  } catch (err) {
    warnings.push(`門市資料（${name}）暫時無法取得：${(err as Error).message}`);
    return undefined;
  }
}

function tomorrow(): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: env.REPORT_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** 以門市資料補齊商品編號、庫存、到期日；任何一步失敗或格式異常都只加 warning */
async function enrichFromStore(ctx: ToolContext, findings: ShelfFinding[], warnings: string[]): Promise<void> {
  const names = findings.map((f) => f.name);
  const byQuery = new Map<string, string>();
  const byIndex: (string | undefined)[] = [];
  for (let start = 0; start < names.length; start += PRODUCT_LOOKUP_BATCH) {
    const out = await callStore(ctx, 'product_lookup', { names: names.slice(start, start + PRODUCT_LOOKUP_BATCH) }, warnings);
    if (!out) continue;
    const matches = (out.data as { matches?: unknown } | undefined)?.matches;
    if (!Array.isArray(matches)) {
      warnings.push('門市資料格式異常（product_lookup）');
      continue;
    }
    matches.forEach((m: { query?: string; productId?: string } | null, i) => {
      if (!m?.productId) return;
      if (typeof m.query === 'string') byQuery.set(m.query, m.productId);
      byIndex[start + i] = m.productId;
    });
  }
  findings.forEach((f, i) => {
    const id = byQuery.get(f.name) ?? byIndex[i];
    if (id) f.productId = id;
  });

  const ids = [...new Set(findings.map((f) => f.productId).filter((x): x is string => !!x))];
  if (ids.length === 0) return;
  const inv = await callStore(ctx, 'inventory_query', { productIds: ids }, warnings);
  if (!inv) return;
  const items = (inv.data as { items?: unknown } | undefined)?.items;
  if (!Array.isArray(items)) {
    warnings.push('門市資料格式異常（inventory_query）');
    return;
  }
  const byId = new Map((items as Record<string, unknown>[]).map((it) => [it.productId as string, it]));
  for (const f of findings) {
    const it = f.productId ? byId.get(f.productId) : undefined;
    if (!it) continue;
    if (typeof it.name === 'string') f.name = it.name;
    if (typeof it.stock === 'number') f.stock = it.stock;
    if (typeof it.suggested === 'number') f.suggestedQty = it.suggested;
    if (typeof it.expiryDate === 'string') f.expiryDate = it.expiryDate;
    // 即期判斷來自門市資料，不靠照片
    if (it.expiring === true && f.status === 'ok') f.status = 'expiring';
  }
}

export async function analyzeShelf(principal: Principal, image: ImageInput): Promise<ShelfResult> {
  const reported = await report(principal, SHELF_SYSTEM, REPORT_SHELF_TOOL, image, '請分析這張貨架照片。', shelfReportSchema);
  const ctx = makeToolContext(principal);
  await toolRegistry.prepare(ctx);
  const warnings: string[] = [];

  // 不因 LLM 回太多項而整個失敗：只取前 MAX_SHELF_ITEMS 筆
  const findings: ShelfFinding[] = reported.items.slice(0, MAX_SHELF_ITEMS).map((i) => ({
    name: i.name,
    status: i.status,
    box: clampBox(i.box),
    ...(i.note ? { note: i.note } : {}),
  }));

  if (findings.length > 0) await enrichFromStore(ctx, findings, warnings);

  const counts = {
    outOfStock: findings.filter((f) => f.status === 'out_of_stock').length,
    expiring: findings.filter((f) => f.status === 'expiring').length,
    misplaced: findings.filter((f) => f.status === 'misplaced').length,
  };

  const seen = new Set<string>();
  const replItems = findings
    .filter((f) => f.status === 'out_of_stock' && f.productId && typeof f.stock === 'number' && !seen.has(f.productId) && seen.add(f.productId))
    .slice(0, MAX_REPLENISH_ITEMS)
    .map((f) => ({
      productId: f.productId!,
      name: f.name,
      stock: f.stock!,
      quantity: f.suggestedQty && f.suggestedQty > 0 ? Math.min(f.suggestedQty, 200) : DEFAULT_REPLENISH_QTY,
    }));

  return {
    mode: 'shelf',
    findings,
    counts,
    ...(replItems.length > 0
      ? { replenishment: { toolId: toolId('replenishment_create'), input: { items: replItems, arrivalDate: tomorrow() } } }
      : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

export async function analyzeCoupon(principal: Principal, image: ImageInput): Promise<CouponResult> {
  const reported = await report(principal, COUPON_SYSTEM, REPORT_COUPON_TOOL, image, '請讀出這張優惠券上的資訊。', couponReportSchema);
  const code = reported.code?.replace(/\s+/g, '').toUpperCase() || undefined;
  const extracted = {
    ...(code ? { code } : {}),
    ...(reported.title?.trim() ? { title: reported.title.trim() } : {}),
    ...(reported.expiry?.trim() ? { expiry: reported.expiry.trim() } : {}),
  };
  if (!code) return { mode: 'coupon', extracted, message: '讀不到券號，請掃條碼或手動輸入' };

  const ctx = makeToolContext(principal);
  await toolRegistry.prepare(ctx);
  const warnings: string[] = [];
  const out = await callStore(ctx, 'coupon_check', { code }, warnings);
  if (!out) return { mode: 'coupon', extracted, warnings, message: '暫時無法查詢優惠券，請稍後再試' };
  const block = out.display !== undefined ? buildDisplayBlock(out.display, out.data) : undefined;
  return {
    mode: 'coupon',
    extracted,
    result: out.data as Record<string, unknown>,
    ...(block ? { block } : {}),
  };
}
