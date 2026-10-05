/** 影像辨識的系統提示詞與回報工具定義（Demo 前依實際照片調校，見 scripts/vision-eval.ts）。 */
import type { LLMTool } from '@/lib/llm/types';

export const SHELF_SYSTEM = [
  '你是便利商店的貨架稽核助手。仔細看照片中的每一格貨架與每一件可辨識的商品。',
  '對每個可辨識的商品位置，回報：',
  '- name：商品名稱（盡量寫完整，如「鮭魚御飯糰」「三明治－火腿蛋」）。',
  '- status：out_of_stock＝該商品的位置空了或只剩極少；misplaced＝明顯放錯區（例如飯糰區出現便當）；ok＝正常。',
  '- box：該商品（或空位）在照片中的位置，0 到 1 的相對座標：x、y 為左上角，w、h 為寬高。',
  '- note：選填，簡短說明（例如「標價牌下方空位」）。',
  '看不清楚的不要猜；不要判斷有效期限。只能透過呼叫 report_shelf 回報結果。',
].join('\n');

export const REPORT_SHELF_TOOL: LLMTool = {
  name: 'report_shelf',
  description: '回報貨架辨識結果',
  inputSchema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            status: { type: 'string', enum: ['out_of_stock', 'misplaced', 'ok'] },
            box: {
              type: 'object',
              properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } },
              required: ['x', 'y', 'w', 'h'],
            },
            note: { type: 'string' },
          },
          required: ['name', 'status', 'box'],
        },
      },
    },
    required: ['items'],
  },
};

export const COUPON_SYSTEM = [
  '你是便利商店的優惠券辨識助手。照片是客人出示的優惠券（紙本或手機畫面）。',
  '讀出券上「印出來的文字」：code＝券號（通常是英數字），title＝券名，expiry＝有效期限（照券上寫法）。',
  '只讀印刷文字，不要解讀條碼或 QR code 圖形；讀不到的欄位就不要填，不要猜。',
  '只能透過呼叫 report_coupon 回報結果。',
].join('\n');

export const REPORT_COUPON_TOOL: LLMTool = {
  name: 'report_coupon',
  description: '回報優惠券辨識結果',
  inputSchema: {
    type: 'object',
    properties: { code: { type: 'string' }, title: { type: 'string' }, expiry: { type: 'string' } },
  },
};
