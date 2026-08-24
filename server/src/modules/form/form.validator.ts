/**
 * Form Definition 自洽性驗證（存檔前把關）。
 *
 * Designer 產出的 8 層 schema 必須彼此一致才可保存：欄位 key 對齊、必填/版面/agent 參照的欄位存在、
 * Select 有 options、data schema 可被 Ajv 編譯等。回傳 FieldIssue[]；空陣列代表通過。
 *
 * 與 form.engine 同樣用 Ajv，但此處驗的是「schema 本身」而非「填寫值」。
 */
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { isSafeFieldLinkUrl } from '@hyagent/shared';
import type { Definition, FieldIssue } from './form.types';

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const RULE_OPS = new Set(['>=', '>', '<=', '<', '==', '!=']);
/** 需要 options 才有意義的元件（下拉、單選群組、多選） */
const OPTION_COMPONENTS = new Set(['Select', 'Radio', 'MultiSelect']);
/** fieldMap 來源允許的「非 data 欄位」衍生值（由 domain service 在送出時注入） */
const DERIVED_SOURCES = new Set(['userId', 'hours', 'region']);
const FORM_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/** 驗證一份 Definition 是否自洽；回傳問題清單（空＝通過）。 */
export function validateDefinition(def: Definition): FieldIssue[] {
  const issues: FieldIssue[] = [];
  const add = (field: string, message: string) => issues.push({ field, message });

  // formId
  if (!def.formId || !FORM_ID_RE.test(def.formId)) {
    add('formId', 'formId 必須是小寫英數與連字號（如 leave-request）');
  }

  // data
  const props = def.data?.properties;
  if (def.data?.type !== 'object' || !props || typeof props !== 'object') {
    add('data', 'data.type 必須為 "object" 且需有 properties');
    return issues; // 後續檢查倚賴 properties，提早返回
  }
  const keys = new Set(Object.keys(props));
  if (keys.size === 0) add('data', '至少需定義一個欄位');

  // data schema 可被 Ajv 編譯（攔截不合法 JSON Schema）
  try {
    ajv.compile({ type: 'object', properties: props, additionalProperties: true });
  } catch (err) {
    add('data', `data schema 無法編譯：${(err as Error).message}`);
  }

  // field：每個 data 欄位需有 field spec；每個 field key 需存在於 data
  for (const k of keys) {
    if (!def.field?.[k]) add(`field.${k}`, `欄位 ${k} 缺少 field 設定（component/label）`);
  }
  for (const [k, spec] of Object.entries(def.field ?? {})) {
    if (!keys.has(k)) {
      add(`field.${k}`, `field 定義了未知欄位 ${k}（不在 data.properties）`);
      continue;
    }
    if (!spec.component) add(`field.${k}`, `欄位 ${k} 缺少 component`);
    if (!spec.label) add(`field.${k}`, `欄位 ${k} 缺少 label`);
    for (const link of spec.links ?? []) {
      if (!link.label?.trim()) add(`field.${k}.links`, `欄位 ${k} 的連結缺少顯示文字`);
      if (!isSafeFieldLinkUrl(link.url ?? '')) {
        add(`field.${k}.links`, `欄位 ${k} 的連結必須是 http(s) 或站內絕對路徑`);
      }
    }
    if (OPTION_COMPONENTS.has(spec.component) && !(spec.options && spec.options.length > 0)) {
      add(`field.${k}`, `${spec.component} 欄位 ${k} 需提供 options`);
    }
  }

  // validation.required / rules
  for (const r of def.validation?.required ?? []) {
    if (!keys.has(r)) add('validation.required', `必填欄位 ${r} 不在 data.properties`);
  }
  for (const rule of def.validation?.rules ?? []) {
    if (rule.type !== 'compareField') {
      add(`validation.rules.${rule.id}`, `不支援的規則類型：${rule.type}`);
      continue;
    }
    if (!RULE_OPS.has(rule.op)) add(`validation.rules.${rule.id}`, `不支援的比較運算子：${rule.op}`);
    if (!keys.has(rule.field)) add(`validation.rules.${rule.id}`, `規則欄位 ${rule.field} 不存在`);
    if (!keys.has(rule.other)) add(`validation.rules.${rule.id}`, `比較欄位 ${rule.other} 不存在`);
  }

  // layout：所有排版欄位需存在
  for (const section of def.layout?.sections ?? []) {
    for (const row of section.fields ?? []) {
      for (const f of row) {
        if (!keys.has(f)) add('layout', `版面參照了未知欄位 ${f}`);
      }
    }
  }

  // agent
  if (!def.agent?.intent) add('agent.intent', 'agent.intent 必填');
  if (!def.agent?.description) add('agent.description', 'agent.description 必填');
  for (const f of def.agent?.askOrder ?? []) {
    if (!keys.has(f)) add('agent.askOrder', `詢問順序參照了未知欄位 ${f}`);
  }
  for (const f of Object.keys(def.agent?.fieldGuidance ?? {})) {
    if (!keys.has(f)) add('agent.fieldGuidance', `欄位提示參照了未知欄位 ${f}`);
  }

  // oa（選用）：fieldMap 來源需為 data 欄位或已知衍生值；端點/回應基本檢查
  if (def.oa) {
    if (!def.oa.endpoint) add('oa.endpoint', 'oa.endpoint 必填');
    for (const src of Object.keys(def.oa.request?.fieldMap ?? {})) {
      if (!keys.has(src) && !DERIVED_SOURCES.has(src)) {
        add('oa.request.fieldMap', `映射來源 ${src} 不是 data 欄位也非衍生值（userId/hours/region）`);
      }
    }
    if (!def.oa.response?.idField) add('oa.response.idField', 'oa.response.idField 必填');
  }

  // policy（選用）：需有 default 工時
  if (def.policy && !def.policy.default?.workDay) {
    add('policy.default', 'policy.default.workDay 必填（上下班時間）');
  }

  return issues;
}
