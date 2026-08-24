import { useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, FileUploader } from '@hyagent/ui';
import { requiresExplicitConsent, resolveFieldLinks } from '@hyagent/shared';
import type { Attachment, Definition, FieldSpec, LeaveBalance, SubmissionInfo } from './api';
import { resolveArrayFieldRenderer, resolveFieldRenderer } from './form/registry';

/** 附件可接受的副檔名（與後端 MIME 白名單對應） */
const ATTACHMENT_ACCEPT = '.pdf,.jpg,.jpeg,.png,.gif,.webp,.doc,.docx,.xls,.xlsx';

interface Props {
  def: Definition;
  values: Record<string, unknown>;
  balances?: LeaveBalance[];
  submission?: SubmissionInfo | null;
  busy?: boolean;
  /** confirming：送出前確認（draft 為編輯後的值）；submitted 時不提供 */
  onConfirm?: (draft: Record<string, unknown>) => Promise<void>;
  onCancel?: () => void;
  onClose: () => void;
  /** 上傳附件到後端（Upload 欄位用）；回傳 metadata */
  onUploadAttachment?: (file: File) => Promise<Attachment>;
  /** 刪除後端附件 */
  onDeleteAttachment?: (attachmentId: string) => Promise<void>;
}

/** 以 field options 把值換成顯示 label（找不到對應時退回原值） */
function optionLabel(spec: FieldSpec | undefined, raw: unknown): string {
  const opt = spec?.options?.find((o) => o.value === String(raw));
  return opt ? opt.label : String(raw);
}

/**
 * 唯讀顯示字串：enum 用 field options 的中文 label，多選以「、」串接，
 * 布林顯示是/否，密碼一律遮蔽，空值顯示破折號。
 */
function displayValue(spec: FieldSpec | undefined, raw: unknown): string {
  if (raw === null || raw === undefined || raw === '') return '—';
  if (Array.isArray(raw)) {
    return raw.length === 0 ? '—' : raw.map((v) => optionLabel(spec, v)).join('、');
  }
  if (typeof raw === 'boolean') return raw ? '是' : '否';
  if (spec?.component === 'Password') return '••••••';
  if (spec?.options?.length) return optionLabel(spec, raw);
  return String(raw);
}

/** 由起訖日期時間粗估請假時數（MVP：純時間差，不扣非工時/假日） */
function computeHours(values: Record<string, unknown>): number | null {
  const sd = values.startDate;
  const ed = values.endDate;
  if (!sd || !ed) return null;
  const start = new Date(`${String(sd)}T${String(values.startTime || '00:00')}:00`);
  const end = new Date(`${String(ed)}T${String(values.endTime || '00:00')}:00`);
  const ms = end.getTime() - start.getTime();
  if (Number.isNaN(ms) || ms <= 0) return null;
  return Math.round((ms / 3_600_000) * 10) / 10;
}

export default function FormView({
  def,
  values,
  balances,
  submission,
  busy,
  onConfirm,
  onCancel,
  onClose,
  onUploadAttachment,
  onDeleteAttachment,
}: Props) {
  const { t } = useTranslation();
  const submitted = !!submission;
  // 欄位來源依 data.properties；若有 layout schema，顯示順序與分組交給 layout 決定。
  const fieldKeys = Object.keys(def.data.properties);
  const required = new Set(def.validation?.required ?? []);
  const layoutRows = def.layout?.sections.flatMap((section) => section.fields) ?? [];
  const layoutFieldKeys = new Set(layoutRows.flat());
  const extraFieldKeys = fieldKeys.filter((key) => !layoutFieldKeys.has(key));
  const sections =
    def.layout?.sections
      .map((section) => ({
        title: section.title,
        rows: section.fields
          .map((row) => row.filter((key) => fieldKeys.includes(key)))
          .filter((row) => row.length > 0),
      }))
      .filter((section) => section.rows.length > 0) ?? [];

  if (extraFieldKeys.length > 0) {
    sections.push({ title: undefined, rows: extraFieldKeys.map((key) => [key]) });
  }

  // 編輯草稿：confirming 模式才用，初值取自已蒐集的 values
  const [draft, setDraft] = useState<Record<string, unknown>>(() => ({ ...values }));
  const [err, setErr] = useState<string | null>(null);
  const [activeSectionIndex, setActiveSectionIndex] = useState(0);
  const lastSectionIndex = Math.max(sections.length - 1, 0);
  const currentSectionIndex = Math.min(activeSectionIndex, lastSectionIndex);
  const currentSection = sections[currentSectionIndex];
  const hasSteps = sections.length > 1 && !submitted;
  const currentSectionKeys = currentSection?.rows.flat() ?? [];
  const allRequiredFilled = (def.validation?.required ?? []).every((key) => !isRequiredMissing(key));
  const currentRequiredFilled = currentSectionKeys
    .filter((key) => required.has(key))
    .every((key) => !isRequiredMissing(key));
  const isLastSection = currentSectionIndex === lastSectionIndex;

  function setField(key: string, val: string) {
    setErr(null);
    setDraft((d) => ({ ...d, [key]: val }));
  }

  // 非字串欄位（如附件 Upload，值為 Attachment[]）用此設定 draft
  function setRawField(key: string, val: unknown) {
    setErr(null);
    setDraft((d) => ({ ...d, [key]: val }));
  }

  function isRequiredMissing(key: string): boolean {
    if (!required.has(key)) return false;
    const raw = draft[key];
    if (requiresExplicitConsent(def.field[key])) return raw !== true && raw !== 'true';
    if (raw === null || raw === undefined) return true;
    return String(raw).trim() === '';
  }

  function requiredMessage(keys: string[]): string {
    const labels = keys
      .filter((key) => isRequiredMissing(key))
      .map((key) => def.field[key]?.label ?? key);
    return labels.length > 0
      ? t('form.requiredMissing', { fields: labels.join('、') })
      : t('form.incomplete');
  }

  function handleNext() {
    const missingKeys = currentSectionKeys.filter((key) => isRequiredMissing(key));
    if (missingKeys.length > 0) {
      setErr(requiredMessage(missingKeys));
      return;
    }
    setErr(null);
    setActiveSectionIndex((idx) => Math.min(idx + 1, lastSectionIndex));
  }

  async function handleConfirm() {
    if (!onConfirm) return;
    setErr(null);
    const missingKeys = (def.validation?.required ?? []).filter((key) => isRequiredMissing(key));
    if (missingKeys.length > 0) {
      setErr(requiredMessage(missingKeys));
      return;
    }
    try {
      await onConfirm(draft);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('form.submit'));
    }
  }

  function renderField(key: string) {
    const spec = def.field[key];
    if (!spec) return null;

    // 附件（Upload）：值為 Attachment[]，非字串，且需真正上傳到後端 → 特例渲染，
    // 改用設計系統的 FileUploader（內含標題列），不走 registry 的字串 renderer。
    // 送出後（submitted）以唯讀清單呈現。
    if (spec.component === 'Upload') {
      const list = ((submitted ? values[key] : draft[key]) as Attachment[] | undefined) ?? [];
      return (
        <div className="form-field form-field--full" key={key}>
          {/* 附件欄位的標籤與其他欄位一致（form-label）；FileUploader 不再顯示自帶標題列 */}
          <dt className="form-label">
            {spec.label}
            {required.has(key) && <span className="form-required">*</span>}
          </dt>
          <dd className="form-value">
            <FileUploader
              showHeader={false}
              supportedFormatsText={spec.help}
              initialFiles={list}
              readOnly={submitted}
              disabled={busy}
              accept={ATTACHMENT_ACCEPT}
              maxFileSizeMB={10}
              maxFiles={10}
              onUpload={(file) =>
                onUploadAttachment
                  ? onUploadAttachment(file)
                  : Promise.reject(new Error(t('form.submit')))
              }
              onDelete={(id) => (onDeleteAttachment ? onDeleteAttachment(id) : Promise.resolve())}
              onChange={(next) => setRawField(key, next)}
            />
          </dd>
        </div>
      );
    }

    // 依 schema 的 component 從 registry 取對應設計系統元件
    const ArrayRenderer = resolveArrayFieldRenderer(spec.component);
    const Renderer = resolveFieldRenderer(spec.component);
    const raw = draft[key];
    const v = raw === null || raw === undefined ? '' : String(raw);
    // 多選欄位的值是 string[]，原樣往返，不經字串化
    const arrayValue = Array.isArray(raw) ? (raw as string[]) : [];
    const links = resolveFieldLinks(spec);

    // 假別欄位：依目前選取的假別顯示「今年度剩餘 N 小時」
    const balance = key === 'leaveType' && v ? balances?.find((b) => b.leaveType === v) : undefined;

    return (
      <div className="form-field" key={key}>
        <dt className="form-label">
          {spec.label}
          {required.has(key) && <span className="form-required">*</span>}
        </dt>
        <dd className="form-value">
          {submitted ? (
            displayValue(spec, values[key])
          ) : ArrayRenderer ? (
            <ArrayRenderer
              spec={spec}
              name={key}
              value={arrayValue}
              disabled={busy}
              onChange={(val) => setRawField(key, val)}
            />
          ) : (
            <Renderer
              spec={spec}
              name={key}
              value={v}
              disabled={busy}
              onChange={(val) => setField(key, val)}
            />
          )}
          {balance && (
            <p className="form-balance">
              {t('form.remainingHours', { hours: balance.remainingHours })}
            </p>
          )}
          {(spec.help || links.length > 0) && (
            <div className="form-field-help">
              {spec.help && <span>{spec.help}</span>}
              {links.map((link) => (
                <a key={`${link.label}-${link.url}`} href={link.url} target="_blank" rel="noreferrer">
                  {link.label}
                </a>
              ))}
            </div>
          )}
        </dd>
      </div>
    );
  }

  return (
    <div className="form-overlay" onClick={submitted ? onClose : undefined}>
      <div className="form-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="form-sheet-head">
          <h2 className="form-sheet-title">
            {submitted
              ? (def.data.title ?? def.formId)
              : t('form.confirmTitle', { title: def.data.title ?? def.formId })}
          </h2>
          {submitted && <span className="form-stamp">{t('form.submitted')}</span>}
          <button className="form-close" onClick={onClose} type="button" aria-label={t('app.cancel')}>
            ✕
          </button>
        </div>

        <div className="form-body">
        {!submitted && <p className="form-hint">{t('form.hint')}</p>}

        {hasSteps && (
          <div className="form-tabs" role="tablist" aria-label={t('form.steps')}>
            {sections.map((section, sectionIndex) => {
              const sectionKeys = section.rows.flat();
              const isComplete = sectionKeys
                .filter((key) => required.has(key))
                .every((key) => !isRequiredMissing(key));
              return (
                <button
                  aria-selected={sectionIndex === currentSectionIndex}
                  className={[
                    'form-tab',
                    sectionIndex === currentSectionIndex ? 'active' : '',
                    isComplete ? 'complete' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  key={`${section.title ?? 'section'}-${sectionIndex}`}
                  onClick={() => {
                    setErr(null);
                    setActiveSectionIndex(sectionIndex);
                  }}
                  role="tab"
                  type="button"
                >
                  <span>{sectionIndex + 1}</span>
                  {section.title ?? t('form.step', { index: sectionIndex + 1 })}
                </button>
              );
            })}
          </div>
        )}

        <div className="form-layout">
          {(hasSteps && currentSection ? [currentSection] : sections).map((section, sectionIndex) => (
            <section
              className="form-section"
              key={`${section.title ?? 'section'}-${hasSteps ? currentSectionIndex : sectionIndex}`}
            >
              {section.title && <h3 className="form-section-title">{section.title}</h3>}
              <dl className="form-grid">
                {section.rows.map((row, rowIndex) => (
                  <div
                    className="form-row"
                    key={`${section.title ?? 'section'}-${rowIndex}-${row.join('-')}`}
                    style={{ '--form-row-columns': row.length } as CSSProperties}
                  >
                    {row.map((key) => renderField(key))}
                  </div>
                ))}
              </dl>
              {/* 含時間欄位的步驟顯示自動計算的共計時數 */}
              {section.rows.flat().includes('endTime') &&
                (() => {
                  const hours = computeHours(submitted ? values : draft);
                  return hours != null ? (
                    <p className="form-summary">{t('form.totalHours', { hours })}</p>
                  ) : null;
                })()}
            </section>
          ))}
        </div>

        {submitted && (
          <div className="form-receipt">
            <div className="kv-row">
              <span className="kv-key">{t('app.oaNo')}</span>
              <span className="kv-val">{submission.oaRequestId}</span>
            </div>
            <div className="kv-row">
              <span className="kv-key">{t('app.statusField')}</span>
              <span className="kv-val">{submission.status}</span>
            </div>
          </div>
        )}
        </div>

        <div className="form-footer">
          {err && <p className="form-error">{err}</p>}

          <div className="form-actions">
          {submitted ? (
            <Button variant="confirm" size="md" onClick={onClose} type="button">
              {t('form.complete')}
            </Button>
          ) : (
            <>
              <Button variant="cancel" size="md" onClick={onCancel} type="button" disabled={busy}>
                {t('app.cancel')}
              </Button>
              {hasSteps && currentSectionIndex > 0 && (
                <Button
                  variant="reset"
                  size="md"
                  onClick={() => {
                    setErr(null);
                    setActiveSectionIndex((idx) => Math.max(idx - 1, 0));
                  }}
                  type="button"
                  disabled={busy}
                >
                  {t('form.previous')}
                </Button>
              )}
              {hasSteps && !isLastSection ? (
                <Button
                  variant="confirm"
                  size="md"
                  onClick={handleNext}
                  type="button"
                  disabled={busy || !currentRequiredFilled}
                >
                  {t('form.next')}
                </Button>
              ) : (
                <Button
                  variant="confirm"
                  size="md"
                  onClick={handleConfirm}
                  type="button"
                  disabled={busy || !allRequiredFilled}
                >
                  {busy ? t('form.submitting') : t('form.submit')}
                </Button>
              )}
            </>
          )}
          </div>
        </div>
      </div>
    </div>
  );
}
