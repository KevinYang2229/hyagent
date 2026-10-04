/**
 * 補貨確認彈窗（稿 1）：依 ConfirmForm 產生——表格可勾選列、改數字，日期用下拉，其餘欄位依型別。
 * 一次性：送出中鎖住；422／服務不可用顯示原因並允許再送；逾時不能確認。
 */
import { Ionicons } from '@expo/vector-icons';
import { useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { ConfirmField, ConfirmScalarField, ConfirmTableField, PendingActionView } from '@hyagent/shared';
import { errorMessage } from '@/api/errors';
import { Mascot } from '@/brand/Mascot';
import type { ConfirmOutcome } from '@/chat/ChatProvider';
import { colors, font, radius, shadow, space } from '@/theme/tokens';
import {
  buildInput, coerce, dateOptions, hasEmptyTable, initialValues, isChanged, isExpired, localToday, rawOf, rowLabel, validateLocal,
  type Removed, type Values,
} from './confirmForm';

type Row = Record<string, unknown>;

export function ConfirmModal({
  action,
  onConfirm,
  onCancel,
  now,
}: {
  action: PendingActionView | null;
  onConfirm(input?: Record<string, unknown>): Promise<ConfirmOutcome>;
  onCancel(): Promise<void>;
  /** 測試用：固定「現在」 */
  now?: number;
}) {
  if (!action) return null;
  return (
    <Modal transparent animationType="fade" visible onRequestClose={() => void onCancel()}>
      <ConfirmCard action={action} onConfirm={onConfirm} onCancel={onCancel} now={now} />
    </Modal>
  );
}

function ConfirmCard({
  action,
  onConfirm,
  onCancel,
  now,
}: {
  action: PendingActionView;
  onConfirm(input?: Record<string, unknown>): Promise<ConfirmOutcome>;
  onCancel(): Promise<void>;
  now?: number;
}) {
  const fields = useMemo(() => action.form?.fields ?? [], [action.form]);
  const title = action.form?.title ?? action.summary.title;
  const [values, setValues] = useState<Values>(() => initialValues(fields));
  const [removed, setRemoved] = useState<Removed>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const [expiredNow, setExpiredNow] = useState(false);
  const expired = expiredNow || isExpired(action, now ?? Date.now());
  const empty = hasEmptyTable(fields, values, removed);
  const canConfirm = !busy && !expired && !empty;

  async function confirm() {
    if (!canConfirm || inFlight.current) return;
    // 彈窗開著時才逾時：送出前再檢查一次
    if (isExpired(action, now ?? Date.now())) {
      setExpiredNow(true);
      return;
    }
    const local = validateLocal(fields, values, removed);
    if (local) {
      setError(local);
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const outcome = await onConfirm(isChanged(fields, values, removed) ? buildInput(fields, values, removed) : undefined);
      if (outcome.kind === 'invalid' || outcome.kind === 'unavailable') {
        setError(outcome.message);
        inFlight.current = false;
        setBusy(false);
      }
      // done／gone：待確認動作已清除，彈窗會隨之關閉
    } catch (e) {
      setError(errorMessage(e));
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function cancel() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await onCancel();
    } catch (e) {
      setError(errorMessage(e));
      inFlight.current = false;
      setBusy(false);
    }
  }

  function setCell(key: string, index: number, col: string, value: unknown) {
    setValues((v) => ({ ...v, [key]: (v[key] as Row[]).map((r, i) => (i === index ? { ...r, [col]: value } : r)) }));
  }

  function toggleRow(key: string, index: number) {
    setRemoved((r) => {
      const cur = new Set(r[key] ?? []);
      if (cur.has(index)) cur.delete(index);
      else cur.add(index);
      return { ...r, [key]: [...cur] };
    });
  }

  function toggleAll(field: ConfirmTableField) {
    setRemoved((r) => ({ ...r, [field.key]: (r[field.key]?.length ?? 0) > 0 ? [] : field.rows.map((_, i) => i) }));
  }

  return (
    <View style={styles.overlay}>
      <View style={styles.card}>
        <View style={styles.header}>
          <Mascot pose="wave" size={72} />
          <View style={{ flex: 1 }}>
            <Text style={styles.brand}>Open醬</Text>
            <Text style={styles.title}>{`我已準備好${title}！`}</Text>
            <Text style={styles.subtitle}>請確認以下內容：</Text>
          </View>
        </View>
        <ScrollView style={{ maxHeight: 460 }} contentContainerStyle={{ gap: space.md }}>
          {fields.length === 0
            ? action.summary.fields.map((f) => (
                <View key={f.label} style={styles.scalarRow}>
                  <Text style={styles.scalarLabel}>{f.label}</Text>
                  <Text style={styles.scalarValue}>{f.value}</Text>
                </View>
              ))
            : fields.map((f) =>
                f.kind === 'table' ? (
                  <TableField key={f.key} field={f} rows={values[f.key] as Row[]} removed={removed[f.key] ?? []} disabled={busy || expired}
                    onToggle={(i) => toggleRow(f.key, i)} onToggleAll={() => toggleAll(f)} onCell={(i, c, v) => setCell(f.key, i, c, v)} />
                ) : (
                  <ScalarField key={f.key} field={f} value={values[f.key]} disabled={busy || expired}
                    onChange={(v) => setValues((cur) => ({ ...cur, [f.key]: v }))} />
                ),
              )}
        </ScrollView>
        {expired ? <Text style={styles.error}>這個動作已逾時，請重新提出。</Text> : null}
        {empty && !expired ? <Text style={styles.error}>請至少勾選一項。</Text> : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <View style={styles.footer}>
          <Pressable style={[styles.btn, styles.cancel]} onPress={cancel} accessibilityLabel="取消" accessibilityRole="button">
            <Text style={styles.cancelText}>{expired ? '關閉' : '取消'}</Text>
          </Pressable>
          <Pressable
            style={[styles.btn, styles.ok, !canConfirm && { opacity: 0.5 }]}
            onPress={confirm}
            disabled={!canConfirm}
            accessibilityLabel={`確認${title}`}
            accessibilityRole="button"
            accessibilityState={{ disabled: !canConfirm }}
          >
            {busy ? <ActivityIndicator color="#fff" /> : <Ionicons name="checkmark-circle" size={22} color="#fff" />}
            <Text style={styles.okText}>{`確認${title}`}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function Check({ on, label, onPress, disabled }: { on: boolean; label: string; onPress(): void; disabled: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityLabel={label} accessibilityRole="checkbox" accessibilityState={{ checked: on }} hitSlop={8}>
      <Ionicons name={on ? 'checkbox' : 'square-outline'} size={24} color={on ? colors.info : colors.textMuted} />
    </Pressable>
  );
}

function TableField({
  field, rows, removed, disabled, onToggle, onToggleAll, onCell,
}: {
  field: ConfirmTableField;
  rows: Row[];
  removed: number[];
  disabled: boolean;
  onToggle(i: number): void;
  onToggleAll(): void;
  onCell(i: number, col: string, v: unknown): void;
}) {
  const gone = new Set(removed);
  return (
    <View style={styles.table}>
      <View style={[styles.tr, styles.thead]}>
        {field.selectable ? <Check on={gone.size === 0} label="全選" onPress={onToggleAll} disabled={disabled} /> : null}
        {field.columns.map((c, i) => (
          <Text key={c.key} style={[styles.th, i === 0 && styles.firstCol]}>{c.label}</Text>
        ))}
      </View>
      {rows.map((row, i) => {
        const off = gone.has(i);
        const name = rowLabel(field, row, i);
        return (
          <View key={i} style={[styles.tr, i > 0 && styles.divider, off && { opacity: 0.4 }]}>
            {field.selectable ? <Check on={!off} label={`選取 ${name}`} onPress={() => onToggle(i)} disabled={disabled} /> : null}
            {field.columns.map((c, ci) => {
              const v = row[c.key];
              const img = c.image && typeof row[c.image] === 'string' && /^https?:\/\//i.test(row[c.image] as string) ? (row[c.image] as string) : null;
              if (c.editable && (c.kind === 'number' || c.kind === 'text')) {
                return (
                  <View key={c.key} style={[styles.td, styles.editCell]}>
                    <TextInput
                      style={styles.qty}
                      value={v === undefined || v === null ? '' : String(v)}
                      keyboardType={c.kind === 'number' ? 'number-pad' : 'default'}
                      editable={!disabled && !off}
                      onChangeText={(t) => onCell(i, c.key, coerce(c.kind, t))}
                      accessibilityLabel={`${name} ${c.label}`}
                    />
                    {c.unit ? <Text style={styles.unit}>{c.unit}</Text> : null}
                  </View>
                );
              }
              return (
                <View key={c.key} style={[styles.td, ci === 0 && styles.firstCol, styles.cellRow]}>
                  {img ? <Image source={{ uri: img }} style={styles.thumb} /> : null}
                  <Text style={styles.cellText}>{v === undefined || v === null || v === '' ? '–' : `${v}${c.unit ? ` ${c.unit}` : ''}`}</Text>
                </View>
              );
            })}
          </View>
        );
      })}
    </View>
  );
}

function ScalarField({ field, value, disabled, onChange }: { field: ConfirmScalarField; value: unknown; disabled: boolean; onChange(v: unknown): void }) {
  const [open, setOpen] = useState(false);
  if (!field.editable) {
    return (
      <View style={styles.scalarRow}>
        <Text style={styles.scalarLabel}>{field.label}</Text>
        <Text style={styles.scalarValue}>{value === undefined || value === null ? '–' : String(value)}</Text>
      </View>
    );
  }
  if (field.kind === 'date' || field.kind === 'select') {
    const options =
      field.kind === 'date'
        ? dateOptions(localToday(), 7, typeof value === 'string' ? value : undefined)
        : (field.options ?? []).map((o) => ({ value: o.value, label: o.label }));
    const current = options.find((o) => o.value === String(value ?? ''));
    return (
      <View style={styles.scalarRow}>
        <Ionicons name={field.kind === 'date' ? 'calendar-outline' : 'list-outline'} size={20} color={colors.textMuted} />
        <Text style={styles.scalarLabel}>{field.label}</Text>
        <View style={{ flex: 1 }}>
          <Pressable style={styles.select} onPress={() => setOpen(!open)} disabled={disabled} accessibilityLabel={field.label} accessibilityRole="button">
            <Text style={styles.selectText}>{current?.label ?? String(value ?? '請選擇')}</Text>
            <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={18} color={colors.text} />
          </Pressable>
          {open ? (
            <View style={styles.options}>
              {options.map((o) => (
                <Pressable key={o.value} style={styles.option} onPress={() => { onChange(field.kind === 'select' ? rawOf(field.options, o.value) : o.value); setOpen(false); }}>
                  <Text style={[styles.selectText, o.value === current?.value && { color: colors.primaryDark, fontWeight: '700' }]}>{o.label}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
        </View>
      </View>
    );
  }
  return (
    <View style={styles.scalarRow}>
      <Text style={styles.scalarLabel}>{field.label}</Text>
      <TextInput
        style={[styles.select, { flex: 1 }]}
        value={value === undefined || value === null ? '' : String(value)}
        keyboardType={field.kind === 'number' ? 'number-pad' : 'default'}
        editable={!disabled}
        onChangeText={(t) => onChange(coerce(field.kind, t))}
        accessibilityLabel={field.label}
      />
      {field.unit ? <Text style={styles.unit}>{field.unit}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: colors.overlay, alignItems: 'center', justifyContent: 'center', padding: space.lg },
  card: { width: '100%', maxWidth: 720, backgroundColor: colors.surface, borderRadius: radius.xl, padding: space.xl, gap: space.md, ...shadow.card },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  brand: { color: colors.primary, fontWeight: '700', fontSize: font.sm },
  title: { fontSize: font.xl, fontWeight: '800', color: colors.text },
  subtitle: { fontSize: font.md, color: colors.textMuted },
  table: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, overflow: 'hidden' },
  tr: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.md, paddingVertical: 10 },
  thead: { backgroundColor: colors.bg },
  divider: { borderTopWidth: 1, borderTopColor: colors.border },
  th: { flex: 1, fontSize: font.sm, color: colors.textMuted, textAlign: 'center' },
  td: { flex: 1, alignItems: 'center' },
  firstCol: { flex: 1.6, alignItems: 'flex-start', textAlign: 'left' },
  cellRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  cellText: { fontSize: font.md, color: colors.text },
  thumb: { width: 40, height: 40, borderRadius: 8, backgroundColor: colors.bg },
  editCell: { flexDirection: 'row', justifyContent: 'center', gap: 4 },
  qty: { minWidth: 72, textAlign: 'center', backgroundColor: colors.dangerSoft, color: colors.danger, fontWeight: '800', fontSize: font.lg, borderRadius: radius.md, paddingVertical: 8 },
  unit: { color: colors.danger, fontWeight: '700' },
  scalarRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  scalarLabel: { fontSize: font.md, color: colors.text },
  scalarValue: { flex: 1, fontSize: font.md, color: colors.text },
  select: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: 12 },
  selectText: { fontSize: font.md, color: colors.text },
  options: { marginTop: 4, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.surface },
  option: { paddingHorizontal: space.md, paddingVertical: 10 },
  error: { color: colors.danger, fontSize: font.sm },
  footer: { flexDirection: 'row', gap: space.md, marginTop: space.sm },
  btn: { flex: 1, flexDirection: 'row', gap: space.sm, alignItems: 'center', justifyContent: 'center', borderRadius: radius.lg, paddingVertical: 16 },
  cancel: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  cancelText: { fontSize: font.lg, color: colors.text, fontWeight: '600' },
  ok: { flex: 1.6, backgroundColor: colors.primary },
  okText: { fontSize: font.lg, color: '#fff', fontWeight: '700' },
});
