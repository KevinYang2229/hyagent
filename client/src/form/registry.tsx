/**
 * 欄位元件註冊表（schema-driven renderer 的接縫）。
 *
 * schema 的 field.component（'Select' / 'DatePicker'…）在此對應到 @oa-agent/ui 的設計系統元件。
 * 要新增/替換元件：在這裡 import，寫一個把 FieldControlProps 轉成該元件 props 的 adapter，
 * 再加進 fieldRegistry。FormView 只查表，不需改動。
 *
 * 值為 string[] 的元件（目前只有 'MultiSelect'）改註冊到 arrayFieldRegistry，
 * FormView 依 resolveArrayFieldRenderer 決定要傳字串還是原始陣列。
 *
 * 例外：'Upload' 兩張表都不註冊。其值為 Attachment[]（非字串），且需非同步上傳到後端，
 * 故由 FormView 特例渲染 FileUploader 處理。
 */
import {
  Checkbox,
  DatePicker,
  Input,
  MultiSelect,
  Radio,
  Select,
  Textarea,
  TimePicker,
} from '@oa-agent/ui';
import type { FieldComponent } from '@oa-agent/shared';
import i18n from '../i18n';
import type { ArrayFieldRenderer, FieldRenderer } from './types';

// ---- adapters：schema 欄位 → 設計系統元件 ----
const renderSelect: FieldRenderer = ({ spec, value, disabled, onChange }) => (
  <Select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
    <option value="">{i18n.t('form.selectPlaceholder')}</option>
    {spec.options?.map((o) => (
      <option key={o.value} value={o.value}>
        {o.label}
      </option>
    ))}
  </Select>
);

// 單選群組：同組共用 name（用欄位 key，沒有時退回 label），避免同頁多組 radio 互相干擾
const renderRadio: FieldRenderer = ({ spec, name, value, disabled, onChange }) => (
  <div className="field-radio-group" role="radiogroup" aria-label={spec.label}>
    {spec.options?.map((o) => (
      <Radio
        key={o.value}
        name={`radio-${name ?? spec.label}`}
        label={o.label}
        value={o.value}
        checked={value === o.value}
        disabled={disabled}
        onChange={() => onChange(o.value)}
      />
    ))}
  </div>
);

const renderMultiSelect: ArrayFieldRenderer = ({ spec, value, disabled, onChange }) => (
  <MultiSelect
    options={spec.options}
    value={value}
    placeholder={spec.placeholder}
    disabled={disabled}
    onChange={onChange}
  />
);

const renderTextarea: FieldRenderer = ({ spec, value, disabled, onChange }) => (
  <Textarea
    value={value}
    rows={3}
    placeholder={spec.placeholder}
    disabled={disabled}
    onChange={(e) => onChange(e.target.value)}
  />
);

const renderDate: FieldRenderer = ({ spec, value, disabled, onChange }) => (
  <DatePicker value={value} placeholder={spec.placeholder} disabled={disabled} onChange={onChange} />
);

const renderTime: FieldRenderer = ({ spec, value, disabled, onChange }) => (
  <TimePicker value={value} placeholder={spec.placeholder} disabled={disabled} onChange={onChange} />
);

// 布林欄位：value 以 'true' / 'false' 字串往返（送出前由 form.engine coerce 回 boolean）
const renderCheckbox: FieldRenderer = ({ spec, value, disabled, onChange }) => (
  <Checkbox
    label={spec.label}
    checked={value === 'true'}
    disabled={disabled}
    onChange={(e) => onChange(e.target.checked ? 'true' : 'false')}
  />
);

const makeInput =
  (type: 'text' | 'number' | 'time' | 'password'): FieldRenderer =>
  ({ spec, value, disabled, onChange }) => (
    <Input
      type={type}
      value={value}
      placeholder={spec.placeholder}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    />
  );

/** field.component → renderer。未列出的型別走 fallback（純文字輸入）；'Upload' 例外，由 FormView 處理。 */
export const fieldRegistry: Partial<Record<FieldComponent, FieldRenderer>> = {
  Select: renderSelect,
  Radio: renderRadio,
  Textarea: renderTextarea,
  DatePicker: renderDate,
  Input: makeInput('text'),
  Password: makeInput('password'),
  Number: makeInput('number'),
  TimePicker: renderTime,
  Checkbox: renderCheckbox,
};

/**
 * field.component → 陣列值 renderer（value 為 string[]）。
 * 與 fieldRegistry 互斥：同一 component 只會出現在其中一張表。
 */
export const arrayFieldRegistry: Partial<Record<FieldComponent, ArrayFieldRenderer>> = {
  MultiSelect: renderMultiSelect,
};

const fallback = makeInput('text');

export function resolveFieldRenderer(component: FieldComponent): FieldRenderer {
  return fieldRegistry[component] ?? fallback;
}

/** 取陣列值 renderer；回傳 undefined 代表該欄位走一般字串路徑。 */
export function resolveArrayFieldRenderer(
  component: FieldComponent,
): ArrayFieldRenderer | undefined {
  return arrayFieldRegistry[component];
}
