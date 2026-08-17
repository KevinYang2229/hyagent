import React, { useState, type CSSProperties } from "react";
import Input from "../Input/Input";
import Textarea from "../Textarea/Textarea";
import Select from "../Select/Select";
import Checkbox from "../Checkbox/Checkbox";
import Radio from "../Radio/Radio";
import MultiSelect from "../MultiSelect/MultiSelect";
import DatePicker from "../DatePicker/DatePicker";
import TimePicker from "../TimePicker/TimePicker";
import "./SchemaFormPreview.css";

/**
 * SchemaFormPreview — 由 Definition（schema）即時渲染表單預覽，外觀比照使用者實際開表單的畫面。
 *
 * DOM 結構與 class 命名鏡像 client 的 FormView（form-sheet / form-section / form-grid / form-row /
 * form-field / form-label / form-value），並以可攜的純 CSS 重現其樣式，因此「看起來就像真實畫面」。
 * 欄位控制項沿用與 client 相同的 @oa-agent/ui 元件。為唯讀預覽：不送出、不上傳、不分步驟。
 *
 * 型別在此以最小結構自宣告，避免 ui 套件強依賴 @oa-agent/shared；傳入完整 Definition（結構相容）即可。
 */
export type PreviewFieldComponent =
  | "Input"
  | "Password"
  | "Number"
  | "Textarea"
  | "Select"
  | "Radio"
  | "MultiSelect"
  | "DatePicker"
  | "TimePicker"
  | "Checkbox"
  | "Upload";

export interface PreviewFieldSpec {
  component: PreviewFieldComponent;
  label: string;
  placeholder?: string;
  options?: { value: string; label: string }[];
  help?: string;
}

export interface PreviewDefinition {
  data: { title?: string; properties: Record<string, unknown> };
  field: Record<string, PreviewFieldSpec>;
  layout?: { sections: { title?: string; fields: string[][] }[] };
  validation?: { required?: string[] };
}

export interface SchemaFormPreviewProps {
  def: PreviewDefinition;
  /** 受控值（選填）；不給則元件自管狀態，可直接點選互動 */
  values?: Record<string, string>;
  onChange?: (next: Record<string, string>) => void;
  /** 全表唯讀（純展示）；預設可互動 */
  disabled?: boolean;
  /** 標題列文字；預設用 def.data.title。傳 null 不顯示標題列 */
  title?: string | null;
  /** 主題主色（hex），反映租戶 widget 外觀；預設靛藍 */
  primaryColor?: string;
  /** 受控目前步驟索引（選填）；給定則由外部控制，可與設計器畫布 tab 連動。不給則內部自管 */
  step?: number;
  /** 步驟切換回呼（點預覽 tab 時觸發）；搭配 step 達成雙向連動 */
  onStepChange?: (step: number) => void;
}

interface RenderSection {
  title?: string;
  rows: string[][];
}

/** 比照 FormView：以 layout 決定分區/列；未列入 layout 的欄位補成額外區塊；無 layout 則每欄一列 */
function sectionsOf(def: PreviewDefinition): RenderSection[] {
  const keys = Object.keys(def.data.properties);
  const inLayout = new Set<string>();
  const sections: RenderSection[] = [];

  if (def.layout?.sections?.length) {
    for (const section of def.layout.sections) {
      const rows = section.fields
        .map((row) => row.filter((k) => keys.includes(k)))
        .filter((row) => row.length > 0);
      rows.flat().forEach((k) => inLayout.add(k));
      if (rows.length) sections.push({ title: section.title, rows });
    }
  }
  const extras = keys.filter((k) => !inLayout.has(k));
  if (extras.length) sections.push({ title: sections.length ? undefined : def.data.title, rows: extras.map((k) => [k]) });
  if (!sections.length) return [{ title: def.data.title, rows: keys.map((k) => [k]) }];
  return sections;
}

/**
 * 預覽的欄位值一律為字串（狀態是 Record<string, string>）。
 * 多選在此以逗號分隔字串暫存，只在元件邊界拆/併；真實表單（FormView）走的是原生 string[]。
 */
function FieldControl({
  spec,
  name,
  value,
  disabled,
  onChange,
}: {
  spec: PreviewFieldSpec;
  /** 欄位 key；同組 Radio 用它當 DOM name */
  name: string;
  value: string;
  disabled?: boolean;
  onChange: (v: string) => void;
}): React.ReactElement {
  switch (spec.component) {
    case "Select":
      return (
        <Select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
          <option value="">請選擇</option>
          {spec.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      );
    case "Radio":
      return (
        <div className="schema-preview-radio-group" role="radiogroup" aria-label={spec.label}>
          {spec.options?.map((o) => (
            <Radio
              key={o.value}
              name={`radio-${name}`}
              label={o.label}
              value={o.value}
              checked={value === o.value}
              disabled={disabled}
              onChange={() => onChange(o.value)}
            />
          ))}
        </div>
      );
    case "MultiSelect":
      return (
        <MultiSelect
          options={spec.options}
          value={value ? value.split(",").filter(Boolean) : []}
          placeholder={spec.placeholder}
          disabled={disabled}
          onChange={(next) => onChange(next.join(","))}
        />
      );
    case "Textarea":
      return (
        <Textarea
          value={value}
          rows={3}
          placeholder={spec.placeholder}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "DatePicker":
      return <DatePicker value={value} placeholder={spec.placeholder} disabled={disabled} onChange={onChange} />;
    case "TimePicker":
      return <TimePicker value={value} placeholder={spec.placeholder} disabled={disabled} onChange={onChange} />;
    case "Checkbox":
      return (
        <Checkbox
          label={spec.label}
          checked={value === "true"}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked ? "true" : "false")}
        />
      );
    case "Upload":
      return <div className="schema-preview-upload">📎 {spec.help || "附件上傳"}</div>;
    default:
      return (
        <Input
          type={
            spec.component === "Number"
              ? "number"
              : spec.component === "Password"
                ? "password"
                : "text"
          }
          value={value}
          placeholder={spec.placeholder}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

export function SchemaFormPreview({
  def,
  values,
  onChange,
  disabled,
  title,
  primaryColor = "#4f46e5",
  step,
  onStepChange,
}: SchemaFormPreviewProps): React.ReactElement {
  const [internal, setInternal] = useState<Record<string, string>>({});
  const [internalStep, setInternalStep] = useState(0);
  // step 受控（外部給）或自管；切換時通知外部 + 在非受控下更新內部
  const activeStep = step ?? internalStep;
  const setStep = (i: number) => {
    onStepChange?.(i);
    if (step === undefined) setInternalStep(i);
  };
  const current = values ?? internal;
  const required = new Set(def.validation?.required ?? []);
  const headTitle = title === null ? null : (title ?? def.data.title ?? "表單預覽");

  const setValue = (key: string, v: string) => {
    const next = { ...current, [key]: v };
    if (onChange) onChange(next);
    else setInternal(next);
  };

  const sheetStyle = { "--prev-primary": primaryColor } as CSSProperties;
  const allSections = sectionsOf(def);
  // 多區塊 → 比照真實畫面以步驟頁籤分段完成
  const hasSteps = allSections.length > 1;
  const currentStep = Math.min(Math.max(activeStep, 0), allSections.length - 1);
  const visibleSections = hasSteps ? [allSections[currentStep]] : allSections;

  return (
    <div className="schema-preview-sheet" style={sheetStyle}>
      {headTitle !== null && (
        <div className="schema-preview-head">
          <h2 className="schema-preview-title">{headTitle}</h2>
        </div>
      )}
      <div className="schema-preview-body">
        {hasSteps && (
          <div className="schema-preview-tabs" role="tablist">
            {allSections.map((s, i) => (
              <button
                key={i}
                type="button"
                role="tab"
                aria-selected={i === currentStep}
                className={`schema-preview-tab${i === currentStep ? " active" : ""}`}
                onClick={() => setStep(i)}
              >
                <span>{i + 1}</span>
                {s.title ?? `步驟 ${i + 1}`}
              </button>
            ))}
          </div>
        )}
        {visibleSections.map((section, si) => (
          <section className="schema-preview-section" key={si}>
            {!hasSteps && section.title && (
              <h3 className="schema-preview-section-title">{section.title}</h3>
            )}
            <div className="schema-preview-grid">
              {section.rows.map((row, ri) => (
                <div
                  className="schema-preview-row"
                  key={ri}
                  style={{ "--prev-cols": row.length } as CSSProperties}
                >
                  {row.map((key) => {
                    const spec = def.field[key];
                    if (!spec) return null;
                    const isUpload = spec.component === "Upload";
                    return (
                      <div
                        className={`schema-preview-field${isUpload ? " full" : ""}`}
                        key={key}
                      >
                        <div className="schema-preview-label">
                          {required.has(key) && <span className="schema-preview-required">*</span>}
                          {spec.label}
                        </div>
                        <div className="schema-preview-value">
                          <FieldControl
                            spec={spec}
                            name={key}
                            value={current[key] ?? ""}
                            disabled={disabled}
                            onChange={(v) => setValue(key, v)}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

export default SchemaFormPreview;
