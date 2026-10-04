/**
 * 門市 Demo 工具：以原始 JSON Schema 宣告（含 readOnly、x-unit 等 HyAgent 確認卡片用的關鍵字），
 * 由低階 MCP Server 提供，並自行以 Ajv 驗證參數。
 */
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import type { HyAgentCaller } from '@hyagent/mcp-kit';
import { coupons, dateAfter, products, promotions, type Product } from './data';
import { matchProduct } from './match';

export interface StoreState {
  replenishments: { id: string; items: unknown[]; arrivalDate: string; by: string; tenantId: string }[];
}

export function createStoreState(): StoreState {
  return { replenishments: [] };
}

export interface StoreToolContext {
  now: () => Date;
  publicBaseUrl: string;
  /** 有圖片的商品 id → 檔名；測試可傳 Set（檔名預設 <id>.png） */
  imageIds: Map<string, string> | Set<string>;
  caller: HyAgentCaller;
  state: StoreState;
}

export interface StoreToolResult {
  structuredContent?: Record<string, unknown>;
  display?: Record<string, unknown>;
  text?: string;
  isError?: boolean;
}

export interface StoreTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  run(args: Record<string, unknown>, ctx: StoreToolContext): StoreToolResult;
}

function imageUrl(p: Product, ctx: StoreToolContext): string | undefined {
  const file = ctx.imageIds instanceof Map ? ctx.imageIds.get(p.id) : ctx.imageIds.has(p.id) ? `${p.id}.png` : undefined;
  return file ? `${ctx.publicBaseUrl.replace(/\/+$/, '')}/assets/${file}` : undefined;
}

function inventoryRow(p: Product, ctx: StoreToolContext): Record<string, unknown> {
  const suggested = Math.max(0, p.safetyStock - p.stock);
  const image = imageUrl(p, ctx);
  return {
    productId: p.id,
    name: p.name,
    category: p.category,
    ...(image ? { image } : {}),
    stock: p.stock,
    safetyStock: p.safetyStock,
    suggested,
    status: p.stock < p.safetyStock * 0.5 ? '庫存偏低' : '正常',
    expiryDate: dateAfter(ctx.now(), p.expiryInDays),
    expiring: p.expiryInDays <= 1,
  };
}

function fail(text: string): StoreToolResult {
  return { isError: true, text };
}

const INVENTORY_DISPLAY = {
  type: 'table',
  title: '商品庫存',
  rows: 'items',
  columns: [
    { key: 'name', label: '商品名稱', image: 'image' },
    { key: 'stock', label: '目前庫存', unit: '個' },
    { key: 'suggested', label: '建議補貨', unit: '個', format: 'delta' },
    { key: 'status', label: '狀態', badge: { 庫存偏低: 'danger', 正常: 'success' } },
  ],
};

export const STORE_TOOLS: StoreTool[] = [
  {
    name: 'product_lookup',
    title: '比對商品',
    description: '把商品名稱（可能不完整或有錯字）比對成門市商品，回傳商品編號與比對分數。',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { names: { type: 'array', title: '商品名稱', items: { type: 'string' }, minItems: 1, maxItems: 30 } },
      required: ['names'],
      additionalProperties: false,
    },
    run(args) {
      const names = args.names as string[];
      return {
        structuredContent: {
          matches: names.map((q) => {
            const m = matchProduct(q);
            return m.product ? { query: q, productId: m.product.id, name: m.product.name, score: m.score } : { query: q, score: m.score };
          }),
        },
      };
    },
  },
  {
    name: 'inventory_query',
    title: '查詢庫存',
    description: '查詢門市商品庫存：可依關鍵字（商品名或類別，如「御飯糰」）、類別或商品編號查詢；回傳庫存、建議補貨量、到期日與是否即期。',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', title: '關鍵字' },
        category: { type: 'string', title: '類別' },
        productIds: { type: 'array', title: '商品編號', items: { type: 'string' }, maxItems: 50 },
      },
      additionalProperties: false,
    },
    run(args, ctx) {
      const kw = typeof args.keyword === 'string' ? args.keyword.trim() : '';
      const ids = Array.isArray(args.productIds) ? new Set(args.productIds as string[]) : undefined;
      const list = products.filter((p) => {
        if (ids && !ids.has(p.id)) return false;
        if (typeof args.category === 'string' && p.category !== args.category) return false;
        if (kw && !p.category.includes(kw) && !p.name.includes(kw) && !p.aliases.some((a) => a.includes(kw))) return false;
        return true;
      });
      return { structuredContent: { items: list.map((p) => inventoryRow(p, ctx)) }, display: INVENTORY_DISPLAY };
    },
  },
  {
    name: 'replenishment_create',
    title: '建立補貨單',
    description: '建立補貨單（寫入）。items 為要補貨的商品與數量，arrivalDate 為預計到貨日期。每個品項的 productId、image、name、stock 請照抄 inventory_query 的結果。',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          title: '補貨品項',
          minItems: 1,
          maxItems: 30,
          items: {
            type: 'object',
            properties: {
              productId: { type: 'string', title: '商品編號', readOnly: true, 'x-hidden': true },
              image: { type: 'string', readOnly: true, description: '商品圖片網址：照抄 inventory_query 結果的 image，沒有就省略' },
              name: { type: 'string', title: '商品名稱', readOnly: true, 'x-image': 'image' },
              stock: { type: 'integer', title: '目前庫存', readOnly: true, 'x-unit': '個' },
              quantity: { type: 'integer', title: '建議補貨數量', minimum: 1, maximum: 200, 'x-unit': '個' },
            },
            required: ['productId', 'name', 'stock', 'quantity'],
            additionalProperties: false,
          },
        },
        arrivalDate: { type: 'string', format: 'date', title: '預計到貨日期' },
      },
      required: ['items', 'arrivalDate'],
      additionalProperties: false,
    },
    run(args, ctx) {
      if (ctx.caller.system) return fail('系統身分不可建立補貨單');
      const items = args.items as { productId: string; image?: string; name: string; stock: number; quantity: number }[];
      const unknown = items.filter((i) => !products.some((p) => p.id === i.productId)).map((i) => i.productId);
      if (unknown.length > 0) return fail(`找不到商品：${unknown.join('、')}`);
      // productId 是使用者看不到的隱藏欄位：顯示的名稱、庫存必須與門市現值一致，不能只信任顯示值
      const mismatched = items
        .filter((i) => {
          const p = products.find((x) => x.id === i.productId)!;
          // 圖片會顯示在確認卡片上：只接受門市自己的商品圖，避免帶入任意網址
          return i.name !== p.name || i.stock !== p.stock || (i.image !== undefined && i.image !== imageUrl(p, ctx));
        })
        .map((i) => i.productId);
      if (mismatched.length > 0) return fail(`品項資料不一致：${mismatched.join('、')}`);
      const id = `R-${String(ctx.state.replenishments.length + 1).padStart(4, '0')}`;
      ctx.state.replenishments.push({ id, items, arrivalDate: args.arrivalDate as string, by: ctx.caller.userId, tenantId: ctx.caller.tenantId });
      return { structuredContent: { orderId: id, itemCount: items.length, arrivalDate: args.arrivalDate } };
    },
  },
  {
    name: 'promotion_list',
    title: '查詢促銷活動',
    description: '列出目前進行中的促銷活動；可依關鍵字或類別篩選，date 可指定查詢日期（YYYY-MM-DD，預設今天）。',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', title: '關鍵字' },
        category: { type: 'string', title: '類別' },
        date: { type: 'string', format: 'date', title: '日期' },
      },
      additionalProperties: false,
    },
    run(args, ctx) {
      const today = typeof args.date === 'string' ? args.date : dateAfter(ctx.now(), 0);
      const kw = typeof args.keyword === 'string' ? args.keyword.trim() : '';
      const list = promotions
        .map((p) => ({ ...p, validFrom: dateAfter(ctx.now(), p.validFromDays), validTo: dateAfter(ctx.now(), p.validToDays) }))
        .filter((p) => p.validFrom <= today && today <= p.validTo)
        .filter((p) => (typeof args.category === 'string' ? p.category === args.category : true))
        .filter((p) => (kw ? p.title.includes(kw) || p.description.includes(kw) || p.category.includes(kw) : true))
        .map((p) => ({ id: p.id, title: p.title, description: p.description, category: p.category, period: `${p.validFrom} ~ ${p.validTo}` }));
      return {
        structuredContent: { promotions: list },
        display: {
          type: 'table',
          title: '進行中的活動',
          rows: 'promotions',
          columns: [
            { key: 'title', label: '活動' },
            { key: 'description', label: '內容' },
            { key: 'period', label: '期間' },
          ],
        },
      };
    },
  },
  {
    name: 'coupon_check',
    title: '查詢優惠券',
    description: '依券號查詢優惠券能否使用、適用商品、期限與使用條件。',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { code: { type: 'string', title: '券號', minLength: 1, maxLength: 40 } },
      required: ['code'],
      additionalProperties: false,
    },
    run(args, ctx) {
      const code = (args.code as string).replace(/\s+/g, '').toUpperCase();
      const c = coupons.find((x) => x.code === code);
      if (!c) return { structuredContent: { code, valid: false, reason: '查無此券' } };
      const today = dateAfter(ctx.now(), 0);
      const from = dateAfter(ctx.now(), c.validFromDays);
      const to = dateAfter(ctx.now(), c.validToDays);
      const reason = c.used ? '已使用' : today < from ? '尚未開始' : today > to ? '已過期' : '可使用';
      const applicable = c.productIds
        ? products.filter((p) => c.productIds!.includes(p.id)).map((p) => p.name).join('、')
        : c.categories.join('、');
      const row = { code: c.code, title: c.title, valid: reason === '可使用', reason, applicableTo: applicable, validPeriod: `${from} ~ ${to}`, conditions: c.conditions };
      return {
        structuredContent: { ...row, rows: [row] },
        display: {
          type: 'table',
          title: '優惠券查詢結果',
          rows: 'rows',
          columns: [
            { key: 'title', label: '優惠券' },
            { key: 'reason', label: '狀態', badge: { 可使用: 'success', 已過期: 'danger', 已使用: 'danger', 尚未開始: 'warning' } },
            { key: 'applicableTo', label: '適用' },
            { key: 'validPeriod', label: '期限' },
            { key: 'conditions', label: '條件' },
          ],
        },
      };
    },
  },
];

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validators = new Map(STORE_TOOLS.map((t) => [t.name, ajv.compile(t.inputSchema)]));

export function callStoreTool(name: string, args: Record<string, unknown>, ctx: StoreToolContext): StoreToolResult {
  const tool = STORE_TOOLS.find((t) => t.name === name);
  if (!tool) return fail(`未知工具：${name}`);
  const validate = validators.get(name)!;
  if (!validate(args)) return fail(`參數不合法：${ajv.errorsText(validate.errors)}`);
  return tool.run(args, ctx);
}
