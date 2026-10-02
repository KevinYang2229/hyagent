/**
 * 待確認動作（純函式）：寫入工具被 LLM 提議時，存成 session.pendingAction，
 * 由使用者在確認卡片上確認後才由後端執行（見 pending-action.service）。
 *
 * 卡片摘要從工具的 inputSchema 推導：欄位 title → description → key 當標籤，
 * 讓自建 MCP 只要把 schema 寫好，卡片就能讀。
 */
import { randomUUID } from 'node:crypto';
import type { ConfirmCard, ConfirmCardField, PendingActionView } from '@hyagent/shared';
import type { ToolDef } from '@/modules/tools/tool.types';

export const PENDING_ACTION_TTL_MS = 10 * 60 * 1000;
export const CARD_VALUE_MAX_CHARS = 500;

export interface PendingAction {
  id: string;
  toolId: string;
  /** 已通過 Ajv 的參數；確認後原封不動執行 */
  input: Record<string, unknown>;
  summary: ConfirmCard;
  expiresAt: string;
}

interface PropSchema {
  title?: unknown;
  description?: unknown;
  'x-display'?: unknown;
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function truncate(s: string): string {
  return s.length > CARD_VALUE_MAX_CHARS ? `${s.slice(0, CARD_VALUE_MAX_CHARS)}…` : s;
}

function isPrimitive(v: unknown): v is string | number | boolean {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

function formatValue(value: unknown, prop: PropSchema | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return truncate(prop?.['x-display'] === 'html' ? stripHtml(value) : value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value) && value.every(isPrimitive)) return truncate(value.map(String).join('、'));
  return truncate(JSON.stringify(value));
}

function labelOf(key: string, prop: PropSchema | undefined): string {
  if (typeof prop?.title === 'string' && prop.title) return prop.title;
  if (typeof prop?.description === 'string' && prop.description) return prop.description;
  return key;
}

export function buildConfirmCard(
  tool: Pick<ToolDef, 'description' | 'confirmTitle' | 'inputSchema'>,
  input: Record<string, unknown>,
): ConfirmCard {
  const props = (tool.inputSchema.properties ?? {}) as Record<string, PropSchema>;
  const known = Object.keys(props).filter((k) => k in input);
  const extra = Object.keys(input).filter((k) => !(k in props));
  const fields: ConfirmCardField[] = [];
  for (const key of [...known, ...extra]) {
    const value = formatValue(input[key], props[key]);
    if (value === undefined) continue;
    fields.push({ label: labelOf(key, props[key]), value });
  }
  return { title: tool.confirmTitle ?? tool.description, fields };
}

export function createPendingAction(tool: ToolDef, input: Record<string, unknown>, now = Date.now()): PendingAction {
  return {
    id: randomUUID(),
    toolId: tool.id,
    input,
    summary: buildConfirmCard(tool, input),
    expiresAt: new Date(now + PENDING_ACTION_TTL_MS).toISOString(),
  };
}

export function isPendingActionExpired(action: PendingAction, now = Date.now()): boolean {
  return Date.parse(action.expiresAt) <= now;
}

export function toPendingActionView(action: PendingAction): PendingActionView {
  return { id: action.id, summary: action.summary, expiresAt: action.expiresAt };
}

// 確認/取消語意判斷：取消優先於確認（例如「確認」被「不要，先不要確認」蓋過時，先擋取消詞）。
// 需「整句就是明確的確認」才算（避免『OK 謝謝先這樣』這類夾帶確認詞卻非確認意圖的訊息誤觸）。
const CONFIRM_RE =
  /^(好的?[，,]?\s*)?(請\s*)?(幫我\s*)?(確認寄出|確定寄出|確認執行|確定執行|確認|確定|寄出|送出|執行|同意寄出|同意|可以寄出?|可以|寄|好的?|OK|ok)$/;
const CANCEL_RE = /(不要|先不要|別|取消|不寄|暫停|改)/;

export function isConfirmationText(text: string): boolean {
  const s = text.trim().replace(/[。.,，!！~\s]+$/u, '');
  if (!s || CANCEL_RE.test(s)) return false;
  return CONFIRM_RE.test(s);
}
