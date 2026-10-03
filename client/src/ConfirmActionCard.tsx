/**
 * 寫入動作確認卡片：AI 或按鈕提議的寫入在這裡由使用者確認後才執行。
 * 有 form 時依 schema 推導的欄位可編輯（表格可勾選列、改數字、選日期）；沒有 form 時顯示唯讀摘要。
 * 一次性：按下後立刻鎖住；修改不合法（422）時顯示原因並允許修正後再送。
 */
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConfirmField, ConfirmTableField, PendingActionView } from '@hyagent/shared';
import { ApiError } from './api';

type Phase = 'ready' | 'busy' | 'done' | 'failed' | 'cancelled' | 'expired';
type Values = Record<string, unknown>;

export interface ConfirmActionCardProps {
  action: PendingActionView;
  onConfirm(input?: Record<string, unknown>): Promise<{ ok: boolean; reply: string }>;
  onCancel(): Promise<{ reply: string }>;
}

function initialValues(fields: ConfirmField[]): Values {
  const v: Values = {};
  for (const f of fields) v[f.key] = f.kind === 'table' ? f.rows.map((r) => ({ ...r })) : f.value;
  return v;
}

function rowLabel(field: ConfirmTableField, row: Record<string, unknown>, i: number): string {
  const col = field.columns.find((c) => !c.editable && typeof row[c.key] === 'string');
  return col ? String(row[col.key]) : `#${i + 1}`;
}

function coerce(kind: string, raw: string): unknown {
  if (kind !== 'number') return raw;
  const n = Number(raw);
  return raw.trim() === '' || Number.isNaN(n) ? raw : n;
}

export function ConfirmActionCard({ action, onConfirm, onCancel }: ConfirmActionCardProps) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>(() => (Date.parse(action.expiresAt) <= Date.now() ? 'expired' : 'ready'));
  const [error, setError] = useState<string | null>(null);
  // 同步旗標：setPhase('busy') 要等重新渲染才生效，兩次點擊落在同一個 tick 時 phase 仍是 ready
  const inFlight = useRef(false);
  const fields = useMemo(() => action.form?.fields ?? [], [action.form]);
  const original = useMemo(() => initialValues(fields), [fields]);
  const [values, setValues] = useState<Values>(() => initialValues(fields));
  const [removed, setRemoved] = useState<Record<string, Set<number>>>({});
  const editable = phase === 'ready';

  function buildInput(): Values {
    const out: Values = {};
    for (const f of fields) {
      if (f.kind === 'table') {
        const gone = removed[f.key] ?? new Set<number>();
        out[f.key] = (values[f.key] as Record<string, unknown>[]).filter((_, i) => !gone.has(i));
      } else {
        out[f.key] = values[f.key];
      }
    }
    return out;
  }

  const input = buildInput();
  const changed = JSON.stringify(input) !== JSON.stringify(original);
  const emptyTable = fields.some((f) => f.kind === 'table' && (input[f.key] as unknown[]).length === 0);

  async function run(kind: 'confirm' | 'cancel') {
    if (phase !== 'ready' || inFlight.current) return;
    inFlight.current = true;
    setPhase('busy');
    setError(null);
    try {
      if (kind === 'confirm') {
        const r = await onConfirm(changed ? input : undefined);
        setPhase(r.ok ? 'done' : 'failed');
      } else {
        await onCancel();
        setPhase('cancelled');
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.code === 'ACTION_EXPIRED') {
        setPhase('expired');
        return;
      }
      if (e instanceof ApiError && e.status === 422 && e.code === 'ACTION_INPUT_INVALID') {
        // 修改不合法：動作仍保留，讓使用者修正後再送
        setError(e.message);
        inFlight.current = false;
        setPhase('ready');
        return;
      }
      setError(e instanceof Error ? e.message : String(e));
      setPhase('failed');
    }
  }

  function setCell(key: string, index: number, col: string, value: unknown) {
    setValues((v) => {
      const rows = (v[key] as Record<string, unknown>[]).map((r, i) => (i === index ? { ...r, [col]: value } : r));
      return { ...v, [key]: rows };
    });
  }

  function toggleRow(key: string, index: number) {
    setRemoved((r) => {
      const next = new Set(r[key] ?? []);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return { ...r, [key]: next };
    });
  }

  const statusText: Partial<Record<Phase, string>> = {
    busy: t('action.running'),
    done: t('action.done'),
    failed: t('action.failed'),
    cancelled: t('action.cancelled'),
    expired: t('action.expired'),
  };

  return (
    <div className="confirm-card" data-testid="confirm-action-card" data-phase={phase}>
      <div className="confirm-card-title">{action.form?.title ?? action.summary.title}</div>
      {fields.length === 0 ? (
        <dl className="confirm-card-fields">
          {action.summary.fields.map((f, i) => (
            <div key={`${f.label}-${i}`} className="confirm-card-field">
              <dt>{f.label}</dt>
              <dd>{f.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <div className="confirm-card-form">
          {fields.map((f) =>
            f.kind === 'table' ? (
              <table key={f.key} className="confirm-table">
                <thead>
                  <tr>
                    {f.selectable && <th />}
                    {f.columns.map((c) => <th key={c.key}>{c.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {(values[f.key] as Record<string, unknown>[]).map((row, i) => {
                    const label = rowLabel(f, row, i);
                    const off = removed[f.key]?.has(i) ?? false;
                    return (
                      <tr key={i} data-removed={off || undefined}>
                        {f.selectable && (
                          <td>
                            <input type="checkbox" aria-label={`選取 ${label}`} checked={!off} disabled={!editable} onChange={() => toggleRow(f.key, i)} />
                          </td>
                        )}
                        {f.columns.map((c) => (
                          <td key={c.key}>
                            {c.image && typeof row[c.image] === 'string' && /^https?:\/\//i.test(row[c.image] as string) && <img src={row[c.image] as string} alt="" className="display-thumb" />}
                            {c.editable ? (
                              <input
                                aria-label={`${label} ${c.label}`}
                                type={c.kind === 'number' ? 'number' : c.kind === 'date' ? 'date' : 'text'}
                                min={c.min}
                                max={c.max}
                                value={String(row[c.key] ?? '')}
                                disabled={!editable || off}
                                onChange={(e) => setCell(f.key, i, c.key, coerce(c.kind, e.target.value))}
                              />
                            ) : (
                              <span>{`${String(row[c.key] ?? '–')}${c.unit ? ` ${c.unit}` : ''}`}</span>
                            )}
                            {c.editable && c.unit && <span className="confirm-unit">{c.unit}</span>}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              // 外層用 div：輸入框已有 aria-label，再包 <label> 會讓同一欄被比對兩次
              <div key={f.key} className="confirm-card-field">
                <span>{f.label}</span>
                {f.editable ? (
                  f.kind === 'select' ? (
                    <select aria-label={f.label} value={String(values[f.key] ?? '')} disabled={!editable} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}>
                      {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  ) : (
                    <input
                      aria-label={f.label}
                      type={f.kind === 'number' ? 'number' : f.kind === 'date' ? 'date' : 'text'}
                      min={f.min}
                      max={f.max}
                      value={String(values[f.key] ?? '')}
                      disabled={!editable}
                      onChange={(e) => setValues((v) => ({ ...v, [f.key]: coerce(f.kind, e.target.value) }))}
                    />
                  )
                ) : (
                  <span>{String(f.value ?? '')}</span>
                )}
              </div>
            ),
          )}
        </div>
      )}
      {error && phase === 'ready' && <div className="confirm-card-error" role="alert">{error}</div>}
      {phase === 'ready' || phase === 'busy' ? (
        <div className="confirm-card-actions">
          <button type="button" className="confirm-card-primary" data-testid="action-confirm" disabled={phase === 'busy' || emptyTable} onClick={() => void run('confirm')}>
            {phase === 'busy' ? t('action.running') : t('action.confirm')}
          </button>
          <button type="button" data-testid="action-cancel" disabled={phase === 'busy'} onClick={() => void run('cancel')}>
            {t('action.cancel')}
          </button>
        </div>
      ) : (
        <div className="confirm-card-status" role="status">
          {statusText[phase]}
          {error && <div className="confirm-card-error">{error}</div>}
        </div>
      )}
    </div>
  );
}
