import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useParams } from 'react-router-dom';
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import type { FieldComponent } from '@hyagent/shared';
import { Checkbox, SchemaFormPreview } from '@hyagent/ui';
import { api, UnauthorizedError } from '../api';
import { useAuth } from '../auth';
import AppLayout from '../components/AppLayout';
import { IconClose, IconCog } from '../components/icons';
import {
  OPTION_COMPONENTS,
  emptyDraft,
  fieldsOfStep,
  fromDefinition,
  fromSchemaFiles,
  newField,
  toDefinition,
  type DraftField,
  type DraftForm,
} from './designer/model';
import AdvancedPanel from './designer/AdvancedPanel';
import './designer/designer.css';

const PALETTE: { component: FieldComponent; label: string; icon: string }[] = [
  { component: 'Input', label: '單行文字', icon: '🔤' },
  { component: 'Textarea', label: '多行文字', icon: '📝' },
  { component: 'Number', label: '數字', icon: '🔢' },
  { component: 'Select', label: '下拉選單', icon: '▾' },
  { component: 'Radio', label: '單選', icon: '🔘' },
  { component: 'MultiSelect', label: '多選', icon: '🏷️' },
  { component: 'Password', label: '密碼', icon: '🔒' },
  { component: 'DatePicker', label: '日期', icon: '📅' },
  { component: 'TimePicker', label: '時間', icon: '⏰' },
  { component: 'Checkbox', label: '勾選', icon: '☑️' },
  { component: 'Upload', label: '附件上傳', icon: '📎' },
];


function PaletteItem({ component, label, icon }: { component: FieldComponent; label: string; icon: string }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `new-${component}` });
  return (
    <div
      ref={setNodeRef}
      className={`palette-item${isDragging ? ' dragging' : ''}`}
      {...listeners}
      {...attributes}
    >
      <span className="palette-icon">{icon}</span>
      <span>{label}</span>
    </div>
  );
}

/** 把步驟內欄位依 sameRowAsPrev 切成列（每列最多兩欄） */
function computeRows(fields: DraftField[]): DraftField[][] {
  const rows: DraftField[][] = [];
  for (const f of fields) {
    const last = rows[rows.length - 1];
    if (f.sameRowAsPrev && last && last.length < 2) last.push(f);
    else rows.push([f]);
  }
  return rows;
}

/** 列結構攤平回欄位陣列：每列第一欄 sameRowAsPrev=false、第二欄=true */
function flattenRows(rows: DraftField[][], step: number): DraftField[] {
  const out: DraftField[] = [];
  for (const row of rows) row.forEach((f, i) => out.push({ ...f, stepIndex: step, sameRowAsPrev: i > 0 }));
  return out;
}

function DraggableCard({
  field,
  selected,
  onSelect,
  onDelete,
}: {
  field: DraftField;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const drag = useDraggable({ id: field.key });
  return (
    <div
      ref={drag.setNodeRef}
      className={`field-card${selected ? ' selected' : ''}${drag.isDragging ? ' dragging' : ''}`}
    >
      <span className="drag-handle" {...drag.listeners} {...drag.attributes} title="拖曳搬移／並排">
        ⠿
      </span>
      <span className="field-card-main">
        <strong>
          {field.required && <span className="req">*</span>}
          {field.label || field.key}
        </strong>
        <small>
          {field.component} · {field.key}
        </small>
      </span>
      <button
        className="field-cog"
        onClick={(e) => {
          e.stopPropagation();
          onSelect();
        }}
        title="設定屬性"
      >
        <IconCog width={19} height={19} />
      </button>
      <button
        className="field-del"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        title="刪除欄位"
      >
        <IconClose width={19} height={19} />
      </button>
      {/* 左右放置半區：拖到哪半邊就並到哪一欄（顯示該側垂直線） */}
      <DropHalf forKey={field.key} side="left" />
      <DropHalf forKey={field.key} side="right" />
    </div>
  );
}

/** 卡片內的左/右放置半區（並排用）；pointer-events:none，靠 pointerWithin 幾何偵測 */
function DropHalf({ forKey, side }: { forKey: string; side: 'left' | 'right' }) {
  const { setNodeRef, isOver, active } = useDroppable({
    id: `pair${side === 'left' ? 'L' : 'R'}:${forKey}`,
  });
  const show = isOver && active?.id !== forKey;
  return <span ref={setNodeRef} className={`drop-half ${side}${show ? ' over' : ''}`} />;
}

/** 列與列之間的放置線（拖到這裡＝獨立成一行） */
function RowGap({ id, empty }: { id: string; empty?: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      className={`row-gap${empty ? ' empty' : ''}${isOver ? ' over' : ''}`}
    >
      {empty && '把左側元件拖進來，加到這個步驟'}
    </div>
  );
}

export default function FormDesignerPage() {
  const { id = '', formId = '' } = useParams();
  const isNew = formId === '__new__';
  const { logout } = useAuth();
  const navigate = useNavigate();

  const [draft, setDraft] = useState<DraftForm>(() => emptyDraft());
  const [activeStep, setActiveStep] = useState(0);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [issues, setIssues] = useState<{ field: string; message: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 桌機：滑鼠移動 4px 即啟動拖曳。
  // 手機：TouchSensor 用「長按 180ms」啟動，期間位移 < 8px 才算長按；
  // 若一開始就滑動（> 8px）視為捲動 → 不啟動拖曳，頁面照常捲動。
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
  );

  const handleErr = useCallback(
    (e: unknown) => {
      if (e instanceof UnauthorizedError) {
        logout();
        navigate('/login', { replace: true });
        return;
      }
      setErr(e instanceof Error ? e.message : '發生錯誤');
    },
    [logout, navigate],
  );

  useEffect(() => {
    if (isNew) {
      setDraft(emptyDraft());
      setLoaded(true);
      return;
    }
    void (async () => {
      try {
        const def = await api.getForm(id, formId);
        setDraft(fromDefinition(def));
        setLoaded(true);
      } catch (e) {
        handleErr(e);
      }
    })();
  }, [id, formId, isNew, handleErr]);

  const step = Math.min(activeStep, draft.steps.length - 1);
  const stepFields = fieldsOfStep(draft, step);
  const selected = draft.fields.find((f) => f.key === selectedKey) ?? null;
  const preview = useMemo(() => toDefinition(draft), [draft]);

  function patchField(key: string, patch: Partial<DraftField>) {
    setDraft((d) => ({ ...d, fields: d.fields.map((f) => (f.key === key ? { ...f, ...patch } : f)) }));
  }

  function deleteField(key: string) {
    setDraft((d) => ({ ...d, fields: d.fields.filter((f) => f.key !== key) }));
    if (selectedKey === key) setSelectedKey(null);
  }

  function addStep() {
    setDraft((d) => ({ ...d, steps: [...d.steps, { title: '' }] }));
    setActiveStep(draft.steps.length);
  }

  function deleteStep(index: number) {
    const count = fieldsOfStep(draft, index).length;
    if (count > 0 && !confirm(`刪除此步驟會一併刪除其中 ${count} 個欄位，確定？`)) return;
    setDraft((d) => ({
      ...d,
      steps: d.steps.filter((_, n) => n !== index),
      fields: d.fields
        .filter((f) => f.stepIndex !== index)
        .map((f) => (f.stepIndex > index ? { ...f, stepIndex: f.stepIndex - 1 } : f)),
    }));
    setActiveStep((s) => Math.max(0, s >= index ? s - 1 : s));
  }

  function onDragEnd(e: DragEndEvent) {
    const activeId = String(e.active.id);
    const overId = e.over ? String(e.over.id) : null;
    const isNewField = activeId.startsWith('new-');

    setDraft((d) => {
      let rows = computeRows(fieldsOfStep(d, step));

      // 取得被拖的欄位：新建，或既有（先從列結構移除）
      let moving: DraftField;
      if (isNewField) {
        moving = newField(activeId.slice(4) as FieldComponent, d.fields.length + 1, step);
      } else {
        const found = d.fields.find((f) => f.key === activeId);
        if (!found) return d;
        moving = found;
        rows = rows.map((r) => r.filter((f) => f.key !== activeId)).filter((r) => r.length > 0);
      }

      if (overId?.startsWith('pairL:') || overId?.startsWith('pairR:')) {
        // 拖到某欄位的左/右半邊 → 並到該側（該列已滿則接在那列之後另成一行）
        const side = overId.startsWith('pairL:') ? 'left' : 'right';
        const targetKey = overId.slice(6);
        if (targetKey === activeId) return d;
        const target = rows.find((r) => r.some((f) => f.key === targetKey));
        if (!target) rows.push([moving]);
        else if (target.length >= 2) rows.splice(rows.indexOf(target) + 1, 0, [moving]);
        else {
          const tIdx = target.findIndex((f) => f.key === targetKey);
          target.splice(side === 'left' ? tIdx : tIdx + 1, 0, moving);
        }
      } else if (overId?.startsWith('gap:')) {
        // 拖到某列之前 → 獨立成一行
        const idx = rows.findIndex((r) => r[0]?.key === overId.slice(4));
        if (idx >= 0) rows.splice(idx, 0, [moving]);
        else rows.push([moving]);
      } else if (overId === 'gapend' || isNewField) {
        // 拖到最後 / 從面板拖入且無明確目標 → 加到最後一行
        rows.push([moving]);
      } else {
        // 既有欄位拖到空白處 → 不變動
        return d;
      }

      const newStepFields = flattenRows(rows, step);
      const fields = d.steps.flatMap((_, i) => (i === step ? newStepFields : fieldsOfStep(d, i)));
      return { ...d, fields };
    });
  }

  async function save() {
    setErr(null);
    setIssues([]);
    if (!draft.formId.trim()) {
      setErr('請先填寫表單 ID（formId）');
      return;
    }
    setBusy(true);
    try {
      const def = toDefinition(draft);
      if (isNew) await api.createForm(id, def);
      else await api.updateForm(id, formId, def);
      navigate(`/tenants/${id}?tab=forms`);
    } catch (e) {
      setErr((e as { message?: string }).message ?? '儲存失敗');
      const maybe = e as { details?: { field: string; message: string }[] };
      if (Array.isArray(maybe.details)) setIssues(maybe.details);
    } finally {
      setBusy(false);
    }
  }

  async function doExport() {
    try {
      const out = await api.exportForm(id, isNew ? draft.formId : formId);
      // 自描述：含 formId 與 files，讓匯入可無損還原（仍相容舊的純 files 格式）
      const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${out.formId}.schema-files.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      handleErr(e);
    }
  }

  /** 匯入匯出檔 → 還原成 Definition → 灌進設計器（檢視後按「儲存」才落地） */
  async function doImport(file: File) {
    setErr(null);
    setIssues([]);
    try {
      const parsed = JSON.parse(await file.text()) as
        | { formId?: string; files?: Record<string, unknown> }
        | Record<string, unknown>;
      // 相容兩種形狀：自描述 { formId, files } 或舊版純 files map
      const wrapped =
        parsed && typeof parsed === 'object' && 'files' in parsed && !!(parsed as { files?: unknown }).files;
      const files = (wrapped ? (parsed as { files: Record<string, unknown> }).files : parsed) as Record<
        string,
        unknown
      >;
      const stem = file.name.replace(/\.schema-files\.json$/i, '').replace(/\.json$/i, '');
      const fid = (wrapped && (parsed as { formId?: string }).formId) || draft.formId.trim() || stem;
      const def = fromSchemaFiles(files, fid);
      setDraft(fromDefinition(def));
      setActiveStep(0);
      setSelectedKey(null);
    } catch (e) {
      setErr(e instanceof Error ? `匯入失敗：${e.message}` : '匯入失敗：檔案格式不正確');
    }
  }

  if (!loaded) {
    return (
      <AppLayout crumb="表單設計器" title="載入中…">
        <div className="card">
          <div className="empty">載入中…</div>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout
      crumb="表單設計器"
      title={isNew ? '新增表單' : `編輯：${draft.title || formId}`}
      actions={
        <div className="designer-actions">
          <button className="btn btn-ghost btn-sm" onClick={() => navigate(`/tenants/${id}?tab=forms`)}>
            返回
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void doImport(file);
              e.target.value = ''; // 允許再次匯入同一檔
            }}
          />
          <button className="btn btn-ghost btn-sm" onClick={() => fileInputRef.current?.click()}>
            匯入 schema
          </button>
          {!isNew && (
            <button className="btn btn-ghost btn-sm" onClick={doExport}>
              匯出 schema
            </button>
          )}
          <button className="btn btn-primary btn-sm" onClick={save} disabled={busy}>
            {busy ? '儲存中…' : '儲存'}
          </button>
        </div>
      }
    >
      {err && <div className="banner banner-err">{err}</div>}
      {issues.length > 0 && (
        <div className="banner banner-err">
          <ul className="issue-list">
            {issues.map((i, n) => (
              <li key={n}>
                <code>{i.field}</code>：{i.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ① 基本資料（滿版） */}
      <div className="card form-meta">
        <h4>① 基本資料</h4>
        <p className="block-desc">表單的識別與路由：ID、名稱，以及餵給 AI 判斷意圖用的描述與關鍵字。</p>
        <div className="meta-grid">
          <label>
            <span>表單 ID（formId）</span>
            <input
              className="input"
              value={draft.formId}
              disabled={!isNew}
              placeholder="leave-request"
              onChange={(e) => setDraft((d) => ({ ...d, formId: e.target.value, intent: e.target.value }))}
            />
          </label>
          <label>
            <span>表單名稱</span>
            <input
              className="input"
              value={draft.title}
              placeholder="請假單"
              onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
            />
          </label>
          <label>
            <span>意圖關鍵字（逗號分隔，用於路由）</span>
            <input
              className="input"
              value={draft.keywords.join(', ')}
              placeholder="請假, 病假, 特休"
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  keywords: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                }))
              }
            />
          </label>
          <label className="meta-wide">
            <span>用途描述（agent.description，會餵給 LLM）</span>
            <textarea
              className="input"
              rows={3}
              value={draft.description}
              placeholder="員工請假申請，需要申請人、假別、起訖日期、事由"
              onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
            />
          </label>
        </div>
      </div>

      <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragEnd={onDragEnd}>
        {/* ② 元件面板：滿版橫向工具列 */}
        <aside className="card palette">
          <div className="palette-bar-head">
            <h4>② 元件面板</h4>
            <p className="block-desc">可用的欄位類型。拖到下方畫布，或點擊直接新增到目前步驟。</p>
          </div>
          <div className="palette-items">
            {PALETTE.map((p) => (
              <div
                key={p.component}
                className="palette-item-wrap"
                onClick={() => onDragEnd({ active: { id: `new-${p.component}` }, over: null } as DragEndEvent)}
              >
                <PaletteItem {...p} />
              </div>
            ))}
          </div>
        </aside>

        <div className="designer-grid">
          {/* 畫布（依步驟分頁） */}
          <div className="card canvas">
            <h4>③ 表單畫布</h4>
            <p className="block-desc">編排欄位與版面：依步驟分頁，拖放調整位置；點欄位的 ⚙ 設定鈕編輯屬性。</p>
            <div className="canvas-steps">
              {draft.steps.map((s, i) => (
                <button
                  key={i}
                  className={`canvas-step-tab${i === step ? ' active' : ''}`}
                  onClick={() => setActiveStep(i)}
                >
                  <span>{i + 1}</span>
                  {s.title || (i === 0 ? draft.title || '表單內容' : `步驟 ${i + 1}`)}
                </button>
              ))}
              <button className="canvas-step-add" onClick={addStep} title="新增步驟">
                ＋ 新增步驟
              </button>
            </div>

            <div className="canvas-step-head">
              <input
                className="input"
                value={draft.steps[step]?.title ?? ''}
                placeholder={step === 0 ? '步驟標題（留空用表單名稱）' : `步驟 ${step + 1} 標題`}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    steps: d.steps.map((s, i) => (i === step ? { title: e.target.value } : s)),
                  }))
                }
              />
              {draft.steps.length > 1 && (
                <button className="btn btn-danger btn-sm" onClick={() => deleteStep(step)}>
                  刪除步驟
                </button>
              )}
            </div>

            <CanvasStep
              fields={stepFields}
              selectedKey={selectedKey}
              onSelect={setSelectedKey}
              onDelete={deleteField}
              onClearSelect={() => setSelectedKey(null)}
            />
            <p className="canvas-tip">提示：欄位預設佔滿整行；把一個欄位拖到另一個欄位上＝並成兩欄；拖到列與列之間＝獨立成一行。</p>
          </div>

          {/* 右欄：即時預覽（512 寬） */}
          <div className="card designer-preview">
            <h4>④ 即時預覽</h4>
            <p className="block-desc">使用者實際看到的畫面，隨編輯即時更新；步驟頁籤與畫布連動。</p>
            <SchemaFormPreview def={preview} step={step} onStepChange={setActiveStep} />
          </div>
        </div>
      </DndContext>

      {/* 屬性抽屜：由欄位卡片的 ⚙ 設定鈕開啟，平常不佔版面。
          以 portal 掛到 body，避開 .content 的 transform containing block，
          讓 off-canvas layer 的 fixed 真正相對視窗、正確填滿 .main */}
      {createPortal(
        <div className="inspector-layer">
          {selected && (
            <div className="inspector-backdrop" onClick={() => setSelectedKey(null)} aria-hidden />
          )}
          <aside className={`inspector-drawer${selected ? ' open' : ''}`} aria-hidden={!selected}>
            <div className="inspector-head">
              <h4>屬性{selected ? `：${selected.label || selected.key}` : ''}</h4>
              <button
                className="inspector-close"
                onClick={() => setSelectedKey(null)}
                aria-label="關閉屬性面板"
              >
                ✕
              </button>
            </div>
            {selected && (
              <Inspector
                field={selected}
                guidance={draft.fieldGuidance[selected.key] ?? ''}
                onPatch={(p) => patchField(selected.key, p)}
                onGuidance={(g) =>
                  setDraft((d) => {
                    const fieldGuidance = { ...d.fieldGuidance };
                    if (g) fieldGuidance[selected.key] = g;
                    else delete fieldGuidance[selected.key];
                    return { ...d, fieldGuidance };
                  })
                }
              />
            )}
          </aside>
        </div>,
        document.body,
      )}

      {/* 進階層：簽核 / OA / 對話 / 工時 */}
      <AdvancedPanel draft={draft} setDraft={setDraft} />
    </AppLayout>
  );
}

function CanvasStep({
  fields,
  selectedKey,
  onSelect,
  onDelete,
  onClearSelect,
}: {
  fields: DraftField[];
  selectedKey: string | null;
  onSelect: (k: string) => void;
  onDelete: (k: string) => void;
  onClearSelect: () => void;
}) {
  // 點到非欄位卡片的空白處 → 取消選取
  const handleBlank = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!(e.target as HTMLElement).closest('.field-card')) onClearSelect();
  };
  const rows = computeRows(fields);
  if (fields.length === 0) {
    return (
      <div className="canvas-drop" onClick={handleBlank}>
        <RowGap id="gapend" empty />
      </div>
    );
  }
  return (
    <div className="canvas-drop" onClick={handleBlank}>
      {rows.map((row) => (
        <Fragment key={row[0].key}>
          <RowGap id={`gap:${row[0].key}`} />
          <div className={`canvas-grid-row${row.length === 1 ? ' single' : ''}`}>
            {row.map((f) => (
              <DraggableCard
                key={f.key}
                field={f}
                selected={f.key === selectedKey}
                onSelect={() => onSelect(f.key)}
                onDelete={() => onDelete(f.key)}
              />
            ))}
          </div>
        </Fragment>
      ))}
      <RowGap id="gapend" />
    </div>
  );
}

function Inspector({
  field,
  guidance,
  onPatch,
  onGuidance,
}: {
  field: DraftField;
  guidance: string;
  onPatch: (p: Partial<DraftField>) => void;
  onGuidance: (g: string) => void;
}) {
  return (
    <div className="inspector-body">
      <label>
        <span>機器名稱（key）</span>
        <input
          className="input"
          value={field.key}
          onChange={(e) => onPatch({ key: e.target.value.replace(/\s/g, '') })}
        />
      </label>
      <label>
        <span>標籤（label）</span>
        <input className="input" value={field.label} onChange={(e) => onPatch({ label: e.target.value })} />
      </label>
      <label>
        <span>說明（description，餵給 LLM）</span>
        <input
          className="input"
          value={field.description ?? ''}
          onChange={(e) => onPatch({ description: e.target.value })}
        />
      </label>
      <label>
        <span>提示文字（placeholder）</span>
        <input
          className="input"
          value={field.placeholder ?? ''}
          onChange={(e) => onPatch({ placeholder: e.target.value })}
        />
      </label>
      <label className="checkbox-row">
        <Checkbox
          checked={field.required}
          onChange={(e) => onPatch({ required: e.target.checked })}
        />
        <span>必填</span>
      </label>
      <label>
        <span>LLM 提示（fieldGuidance：如何問、如何換算）</span>
        <textarea
          className="input"
          rows={2}
          value={guidance}
          placeholder="將相對日期（明天、下週一）換算成 YYYY-MM-DD"
          onChange={(e) => onGuidance(e.target.value)}
        />
      </label>

      {OPTION_COMPONENTS.includes(field.component) && (
        <div className="options-editor">
          <span className="options-title">選項（value / label）</span>
          {(field.options ?? []).map((o, i) => (
            <div className="option-row" key={i}>
              <input
                className="input"
                value={o.value}
                placeholder="value"
                onChange={(e) => {
                  const options = [...(field.options ?? [])];
                  options[i] = { ...options[i], value: e.target.value };
                  onPatch({ options });
                }}
              />
              <input
                className="input"
                value={o.label}
                placeholder="顯示文字"
                onChange={(e) => {
                  const options = [...(field.options ?? [])];
                  options[i] = { ...options[i], label: e.target.value };
                  onPatch({ options });
                }}
              />
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => onPatch({ options: (field.options ?? []).filter((_, n) => n !== i) })}
              >
                ✕
              </button>
            </div>
          ))}
          <button
            className="btn btn-ghost btn-sm"
            onClick={() =>
              onPatch({
                options: [...(field.options ?? []), { value: `opt${(field.options?.length ?? 0) + 1}`, label: '新選項' }],
              })
            }
          >
            ＋ 新增選項
          </button>
        </div>
      )}
    </div>
  );
}
