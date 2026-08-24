/**
 * Form 引擎：純函式（無 express / prisma），slot-filling 的確定性骨幹。
 *
 * 職責：欄位/整表的 Ajv 驗證、型別 coerce、跨欄商規評估、computeStatus、setField。
 * 完整性由此計算，不靠 LLM 自述 → 對話迴圈可終止、可離線單測。
 */
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { requiresExplicitConsent } from './field-links';
import type {
  BusinessRule,
  Definition,
  FieldIssue,
  FormValues,
  JsonSchemaProperty,
  RuleOp,
  SlotStatus,
} from './form.types';

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

// 編譯快取：避免每次 validate 重新 compile
const fieldValidatorCache = new Map<string, ValidateFunction>();

function fieldValidator(formId: string, name: string, prop: JsonSchemaProperty): ValidateFunction {
  const key = `${formId}:${name}`;
  let fn = fieldValidatorCache.get(key);
  if (!fn) {
    fn = ajv.compile({ type: 'object', properties: { [name]: prop }, additionalProperties: true });
    fieldValidatorCache.set(key, fn);
  }
  return fn;
}

/** 是否為「未填」（null / undefined / 空字串 / 空陣列） */
function isEmpty(v: unknown): boolean {
  // 空陣列（多選未選、附件未上傳）等同未填，否則陣列型必填欄位形同虛設
  if (Array.isArray(v)) return v.length === 0;
  return v === null || v === undefined || v === '';
}

function isFieldEmpty(def: Definition, name: string, value: unknown): boolean {
  if (requiresExplicitConsent(def.field[name])) return value !== true;
  return isEmpty(value);
}

/** 依 data.schema 的型別做輕量 coerce（Agent 多半給字串） */
export function coerceValue(prop: JsonSchemaProperty | undefined, raw: unknown): unknown {
  if (!prop || raw === null || raw === undefined) return raw;
  if (prop.type === 'number' || prop.type === 'integer') {
    if (typeof raw === 'string' && raw.trim() !== '' && !Number.isNaN(Number(raw))) {
      return Number(raw);
    }
  }
  if (prop.type === 'boolean' && typeof raw === 'string') {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
  }
  return raw;
}

function compare(a: unknown, b: unknown, op: RuleOp): boolean {
  // YYYY-MM-DD 與數字皆可用 < / > 直接比較（字串字典序對齊日期序）
  const x = a as never;
  const y = b as never;
  switch (op) {
    case '>=':
      return x >= y;
    case '>':
      return x > y;
    case '<=':
      return x <= y;
    case '<':
      return x < y;
    case '==':
      return x === y;
    case '!=':
      return x !== y;
    default:
      return true;
  }
}

function evaluateRules(rules: BusinessRule[] | undefined, values: FormValues): FieldIssue[] {
  const issues: FieldIssue[] = [];
  for (const rule of rules ?? []) {
    if (rule.type === 'compareField') {
      const a = values[rule.field];
      const b = values[rule.other];
      if (isEmpty(a) || isEmpty(b)) continue; // 任一缺值先不評（屬 missing 範疇）
      if (!compare(a, b, rule.op)) issues.push({ field: rule.field, message: rule.message });
    }
  }
  return issues;
}

/** 驗證單一欄位值；通過回 null，否則回 issue */
export function validateField(def: Definition, name: string, value: unknown): FieldIssue | null {
  const prop = def.data.properties[name];
  if (!prop) return { field: name, message: `未知欄位：${name}` };
  const fn = fieldValidator(def.formId, name, prop);
  const ok = fn({ [name]: value }) as boolean;
  if (ok) return null;
  const msg = fn.errors?.[0]?.message ?? '格式不正確';
  return { field: name, message: `${name} ${msg}` };
}

/**
 * 設定單一欄位：coerce → 欄位級驗證 → 存值或回 issue。
 * 永不信任外部（LLM）輸入，一律驗證後才進 state。
 */
export function setField(
  def: Definition,
  values: FormValues,
  name: string,
  raw: unknown,
): { values: FormValues; issue?: FieldIssue } {
  const prop = def.data.properties[name];
  if (!prop) return { values, issue: { field: name, message: `未知欄位：${name}` } };
  const coerced = coerceValue(prop, raw);
  const issue = validateField(def, name, coerced);
  if (issue) return { values, issue };
  return { values: { ...values, [name]: coerced } };
}

/** 計算 slot 狀態：filled / missing / invalid / isComplete */
export function computeStatus(def: Definition, values: FormValues): SlotStatus {
  const filled: string[] = [];
  const invalid: FieldIssue[] = [];

  for (const [name, value] of Object.entries(values)) {
    if (isFieldEmpty(def, name, value)) continue;
    filled.push(name);
    const issue = validateField(def, name, value);
    if (issue) invalid.push(issue);
  }

  invalid.push(...evaluateRules(def.validation.rules, values));

  const required = def.validation.required ?? [];
  const missing = required.filter((name) => isFieldEmpty(def, name, values[name]));

  return {
    filled,
    missing,
    invalid,
    isComplete: missing.length === 0 && invalid.length === 0,
  };
}

/** 送出前整表驗證（data + required + 商規） */
export function validateAll(def: Definition, values: FormValues): FieldIssue[] {
  const status = computeStatus(def, values);
  const issues = [...status.invalid];
  for (const name of status.missing) {
    const label = def.field[name]?.label ?? name;
    issues.push({ field: name, message: `缺少必填欄位：${label}` });
  }
  return issues;
}
