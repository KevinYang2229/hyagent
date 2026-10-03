/**
 * 由工具輸入 schema 推導可編輯確認表單（純函式）。
 *
 * 只用標準 JSON Schema 關鍵字與少數 x- 延伸：readOnly、format: date、enum、minimum／maximum、
 * x-display: html（唯讀）、x-unit、x-image（同列圖片欄位）、x-hidden（不顯示，視為唯讀）、x-enumLabels。
 * 這讓任何寫入工具只要 schema 寫好，就自動有可編輯卡片；前端不必為每個工具寫畫面。
 */
import type {
  ConfirmField,
  ConfirmFieldKind,
  ConfirmForm,
  ConfirmTableColumn,
} from '@hyagent/shared';
import type { ToolDef } from '@/modules/tools/tool.types';

export interface JsonSchemaLike {
  type?: unknown;
  title?: unknown;
  description?: unknown;
  readOnly?: unknown;
  format?: unknown;
  enum?: unknown;
  minimum?: unknown;
  maximum?: unknown;
  minItems?: unknown;
  items?: unknown;
  properties?: unknown;
  'x-display'?: unknown;
  'x-unit'?: unknown;
  'x-image'?: unknown;
  'x-hidden'?: unknown;
  'x-enumLabels'?: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function schemaProps(schema: unknown): Record<string, JsonSchemaLike> {
  if (!isRecord(schema) || !isRecord(schema.properties)) return {};
  const out: Record<string, JsonSchemaLike> = {};
  for (const [k, v] of Object.entries(schema.properties)) if (isRecord(v)) out[k] = v as JsonSchemaLike;
  return out;
}

/** 使用者不可修改：readOnly、x-hidden、或 html 內文。 */
export function isLockedProp(s: JsonSchemaLike): boolean {
  return s.readOnly === true || s['x-hidden'] === true || s['x-display'] === 'html';
}

/** 被其他欄位以 x-image 指為圖片來源的鍵（這些鍵不單獨成欄）。 */
export function imageKeysOf(props: Record<string, JsonSchemaLike>): Set<string> {
  const keys = new Set<string>();
  for (const s of Object.values(props)) if (typeof s['x-image'] === 'string') keys.add(s['x-image']);
  return keys;
}

export function labelOf(key: string, s: JsonSchemaLike | undefined): string {
  if (typeof s?.title === 'string' && s.title) return s.title;
  if (typeof s?.description === 'string' && s.description) return s.description;
  return key;
}

function kindOf(s: JsonSchemaLike): ConfirmFieldKind {
  if (Array.isArray(s.enum)) return 'select';
  if (s.type === 'number' || s.type === 'integer') return 'number';
  if (s.format === 'date') return 'date';
  return 'text';
}

function optionsOf(s: JsonSchemaLike): { value: string; label: string }[] | undefined {
  if (!Array.isArray(s.enum)) return undefined;
  const labels = isRecord(s['x-enumLabels']) ? s['x-enumLabels'] : {};
  return s.enum.map((v) => {
    const value = String(v);
    const label = Object.hasOwn(labels, value) && typeof labels[value] === 'string' ? (labels[value] as string) : value;
    return { value, label };
  });
}

/** 共同屬性：單位、上下限、選項（只放有值的鍵，讓輸出穩定） */
function extras(s: JsonSchemaLike): Pick<ConfirmTableColumn, 'unit' | 'min' | 'max' | 'options'> {
  const out: Pick<ConfirmTableColumn, 'unit' | 'min' | 'max' | 'options'> = {};
  if (typeof s['x-unit'] === 'string') out.unit = s['x-unit'];
  if (typeof s.minimum === 'number') out.min = s.minimum;
  if (typeof s.maximum === 'number') out.max = s.maximum;
  const options = optionsOf(s);
  if (options) out.options = options;
  return out;
}

function stripHtml(v: unknown): unknown {
  return typeof v === 'string' ? v.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : v;
}

function tableField(key: string, s: JsonSchemaLike, rows: unknown[]): ConfirmField | undefined {
  if (!isRecord(s.items)) return undefined;
  const itemProps = schemaProps(s.items);
  const hidden = imageKeysOf(itemProps);
  const columns: ConfirmTableColumn[] = [];
  for (const [k, p] of Object.entries(itemProps)) {
    if (p['x-hidden'] === true || hidden.has(k)) continue;
    const col: ConfirmTableColumn = { key: k, label: labelOf(k, p), kind: kindOf(p), editable: !isLockedProp(p), ...extras(p) };
    if (typeof p['x-image'] === 'string') col.image = p['x-image'];
    columns.push(col);
  }
  const objectRows = rows.filter(isRecord).map((r) => ({ ...r }));
  const hasIdentity = Object.values(itemProps).some((p) => p.readOnly === true || p['x-hidden'] === true);
  const minItems = typeof s.minItems === 'number' ? s.minItems : 0;
  return {
    kind: 'table',
    key,
    label: labelOf(key, s),
    selectable: hasIdentity && objectRows.length > minItems,
    columns,
    rows: objectRows,
  };
}

export function buildConfirmForm(
  tool: Pick<ToolDef, 'description' | 'confirmTitle' | 'inputSchema'>,
  input: Record<string, unknown>,
): ConfirmForm {
  const props = schemaProps(tool.inputSchema);
  const hiddenImages = imageKeysOf(props);
  const fields: ConfirmField[] = [];
  for (const [key, s] of Object.entries(props)) {
    if (!Object.hasOwn(input, key) || s['x-hidden'] === true || hiddenImages.has(key)) continue;
    const value = input[key];
    if (Array.isArray(value) && s.type === 'array') {
      const table = tableField(key, s, value);
      if (table) fields.push(table);
      continue;
    }
    if (isRecord(value) || Array.isArray(value)) continue; // 巢狀物件不提供編輯，摘要（summary）仍會顯示
    fields.push({
      kind: kindOf(s),
      key,
      label: labelOf(key, s),
      value: s['x-display'] === 'html' ? stripHtml(value) : value,
      editable: !isLockedProp(s),
      ...extras(s),
    });
  }
  return { title: tool.confirmTitle ?? tool.description, fields };
}
