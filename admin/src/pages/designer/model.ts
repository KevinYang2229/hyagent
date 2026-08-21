/**
 * Designer 編輯模型（DraftForm）與 Definition 的雙向轉換。
 *
 * 步驟（step/section）為第一級概念：畫布以步驟分頁編輯，一次顯示一步。欄位以 stepIndex 歸屬步驟，
 * 步驟內再以 sameRowAsPrev 分列並排。存檔時組成 8 層 Definition（layout.sections = 各步驟），
 * 載入既有表單時反向拆解。進階層（workflow/policy/oa/agent 細節）原樣 passthrough，由進階編輯器填寫。
 */
import type {
  AgentSchema,
  Definition,
  FieldComponent,
  JsonSchemaProperty,
  OASchema,
  PolicySchema,
  WorkflowSchema,
} from '@hyagent/shared';

export type DraftDataType = 'string' | 'number' | 'integer' | 'boolean' | 'array';

export interface DraftField {
  key: string;
  component: FieldComponent;
  label: string;
  placeholder?: string;
  help?: string;
  required: boolean;
  dataType: DraftDataType;
  description?: string;
  format?: string;
  pattern?: string;
  /** Select 選項（value/label） */
  options?: { value: string; label: string }[];
  /** layout：是否與前一欄並排於同一列 */
  sameRowAsPrev?: boolean;
  /** 所屬步驟（layout section）索引 */
  stepIndex: number;
}

export interface DraftStep {
  title: string;
}

export interface DraftForm {
  formId: string;
  title: string;
  /** agent */
  intent: string;
  description: string;
  keywords: string[];
  examples: string[];
  confirmationTemplate?: string;
  fieldGuidance: Record<string, string>;
  /** 步驟（頁籤）；至少一個。第一步標題留空時用表單名稱 */
  steps: DraftStep[];
  fields: DraftField[];
  /** 進階層（原樣保存） */
  workflow?: WorkflowSchema;
  policy?: PolicySchema;
  oa?: OASchema;
}

/** 需要 options 的元件（下拉、單選群組、多選）；與後端 form.validator 同一判準 */
export const OPTION_COMPONENTS: FieldComponent[] = ['Select', 'Radio', 'MultiSelect'];

/** 各元件的預設資料型別 */
export function defaultDataType(component: FieldComponent): DraftDataType {
  if (component === 'Number') return 'number';
  if (component === 'Checkbox') return 'boolean';
  if (component === 'Upload' || component === 'MultiSelect') return 'array';
  return 'string';
}

export function newField(component: FieldComponent, index: number, stepIndex: number): DraftField {
  const key = `${component.toLowerCase()}Field${index}`;
  return {
    key,
    component,
    label: `${component} 欄位`,
    required: false,
    dataType: defaultDataType(component),
    stepIndex,
    ...(OPTION_COMPONENTS.includes(component)
      ? { options: [{ value: 'opt1', label: '選項一' }] }
      : {}),
    ...(component === 'DatePicker' ? { format: 'date' } : {}),
  };
}

export function emptyDraft(formId = ''): DraftForm {
  return {
    formId,
    title: '',
    intent: formId,
    description: '',
    keywords: [],
    examples: [],
    fieldGuidance: {},
    steps: [{ title: '' }],
    fields: [],
  };
}

/** 依步驟分組的欄位（保留陣列順序） */
export function fieldsOfStep(d: DraftForm, stepIndex: number): DraftField[] {
  return d.fields.filter((f) => f.stepIndex === stepIndex);
}

/** DraftForm → Definition（存檔用） */
export function toDefinition(d: DraftForm): Definition {
  const properties: Record<string, JsonSchemaProperty> = {};
  const field: Definition['field'] = {};
  // 以「步驟順序 → 步驟內欄位」為正規順序，確保 properties/askOrder 與畫面一致
  const ordered: DraftField[] = d.steps.flatMap((_, i) => fieldsOfStep(d, i));

  for (const f of ordered) {
    const prop: JsonSchemaProperty = { type: f.dataType };
    if (f.description) prop.description = f.description;
    if (f.format) prop.format = f.format;
    if (f.pattern) prop.pattern = f.pattern;
    if ((f.component === 'Select' || f.component === 'Radio') && f.options?.length) {
      prop.enum = f.options.map((o) => o.value);
    }
    // 多選：值是 string[]，可選值掛在 items.enum（頂層 enum 會誤擋整個陣列）
    if (f.component === 'MultiSelect') {
      prop.type = 'array';
      prop.items = {
        type: 'string',
        ...(f.options?.length ? { enum: f.options.map((o) => o.value) } : {}),
      };
    }
    if (f.component === 'Upload') {
      prop.type = 'array';
      prop.items = { type: 'object' };
    }
    properties[f.key] = prop;

    field[f.key] = {
      component: f.component,
      label: f.label,
      ...(f.placeholder ? { placeholder: f.placeholder } : {}),
      ...(f.help ? { help: f.help } : {}),
      ...(OPTION_COMPONENTS.includes(f.component) && f.options ? { options: f.options } : {}),
    };
  }

  // layout：每個步驟 = 一個 section；步驟內依 sameRowAsPrev 分列
  const sections = d.steps
    .map((step, i) => {
      const rows: string[][] = [];
      for (const f of fieldsOfStep(d, i)) {
        const last = rows[rows.length - 1];
        // 一行最多兩欄：只有上一列尚未滿 2 欄才並排，否則另起一列
        if (f.sameRowAsPrev && last && last.length < 2) last.push(f.key);
        else rows.push([f.key]);
      }
      const title = i === 0 ? step.title || d.title || '表單內容' : step.title || `步驟 ${i + 1}`;
      return { title, fields: rows };
    })
    .filter((s) => s.fields.length > 0);

  const agent: AgentSchema = {
    intent: d.intent || d.formId,
    description: d.description,
    ...(d.keywords.length ? { keywords: d.keywords } : {}),
    ...(d.examples.length ? { examples: d.examples } : {}),
    askOrder: ordered.map((f) => f.key),
    ...(Object.keys(d.fieldGuidance).length ? { fieldGuidance: d.fieldGuidance } : {}),
    ...(d.confirmationTemplate ? { confirmationTemplate: d.confirmationTemplate } : {}),
  };

  return {
    formId: d.formId,
    data: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      formId: d.formId,
      title: d.title || d.formId,
      type: 'object',
      properties,
      additionalProperties: false,
    },
    field,
    layout: { sections: sections.length ? sections : [{ title: d.title || '表單內容', fields: [] }] },
    validation: { required: ordered.filter((f) => f.required).map((f) => f.key) },
    agent,
    ...(d.workflow ? { workflow: d.workflow } : {}),
    ...(d.policy ? { policy: d.policy } : {}),
    ...(d.oa ? { oa: d.oa } : {}),
  };
}

/**
 * 匯出檔（schemas/<formId>/ 多檔 map）→ Definition（匯入用）。
 * 與後端 form.admin.controller.toSchemaFiles 對稱；缺必要層則拋錯。
 */
export function fromSchemaFiles(files: Record<string, unknown>, formId: string): Definition {
  const pick = <T>(name: string): T | undefined => files[name] as T | undefined;
  const data = pick<Definition['data']>('data.schema.json');
  const field = pick<Definition['field']>('field.schema.json');
  const validation = pick<Definition['validation']>('validation.schema.json');
  const agent = pick<Definition['agent']>('agent.schema.json');
  if (!data || !field || !validation || !agent) {
    throw new Error('匯入檔缺少必要層（data / field / validation / agent）');
  }
  return {
    formId,
    data,
    field,
    validation,
    agent,
    layout: pick<Definition['layout']>('layout.schema.json'),
    workflow: pick<Definition['workflow']>('workflow.schema.json'),
    policy: pick<Definition['policy']>('policy.schema.json'),
    oa: pick<Definition['oa']>('oa.schema.json'),
  };
}

/** Definition → DraftForm（載入既有表單編輯用，best-effort） */
export function fromDefinition(def: Definition): DraftForm {
  const required = new Set(def.validation?.required ?? []);
  const layoutSections = def.layout?.sections?.length
    ? def.layout.sections
    : [{ title: def.data.title, fields: Object.keys(def.data.properties).map((k) => [k]) }];

  const steps: DraftStep[] = layoutSections.map((s) => ({ title: s.title ?? '' }));
  const fields: DraftField[] = [];
  layoutSections.forEach((section, si) => {
    section.fields.forEach((row) => {
      row.forEach((key, ci) => {
        const prop = def.data.properties[key];
        if (!prop) return;
        const spec = def.field[key];
        fields.push({
          key,
          component: spec?.component ?? 'Input',
          label: spec?.label ?? key,
          placeholder: spec?.placeholder,
          help: spec?.help,
          required: required.has(key),
          dataType: (prop.type as DraftDataType) ?? 'string',
          description: prop.description,
          format: prop.format,
          pattern: prop.pattern,
          options: spec?.options,
          sameRowAsPrev: ci > 0,
          stepIndex: si,
        });
      });
    });
  });

  return {
    formId: def.formId,
    title: def.data.title ?? def.formId,
    intent: def.agent.intent,
    description: def.agent.description,
    keywords: def.agent.keywords ?? [],
    examples: def.agent.examples ?? [],
    confirmationTemplate: def.agent.confirmationTemplate,
    fieldGuidance: def.agent.fieldGuidance ?? {},
    steps: steps.length ? steps : [{ title: '' }],
    fields,
    workflow: def.workflow,
    policy: def.policy,
    oa: def.oa,
  };
}
