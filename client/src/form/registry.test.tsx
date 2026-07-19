/**
 * 欄位元件註冊表：schema「唯一來源」的前端半邊。
 * 守兩件事：(1) 三張內建表單用到的每個 field.component 都有對應 renderer（或為 Upload 特例）；
 * (2) adapter 的 value/onChange 契約（字串往返、Checkbox 布林字串化）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import type { FieldComponent } from '@oa-agent/shared';
import { fieldRegistry, resolveFieldRenderer } from './registry';
import type { FieldControlProps } from './types';

const SCHEMAS_DIR = join(__dirname, '../../../schemas');

function renderProps(overrides: Partial<FieldControlProps> = {}): FieldControlProps {
  return {
    spec: { component: 'Input', label: '測試欄位' },
    value: '',
    disabled: false,
    onChange: () => {},
    ...overrides,
  } as FieldControlProps;
}

describe('schema → registry 覆蓋', () => {
  it('所有內建表單的 field.component 都有 renderer（Upload 為 FormView 特例）', () => {
    const forms = readdirSync(SCHEMAS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    expect(forms.length).toBeGreaterThan(0);

    const missing: string[] = [];
    for (const form of forms) {
      const fieldSchema = JSON.parse(
        readFileSync(join(SCHEMAS_DIR, form, 'field.schema.json'), 'utf-8'),
      ) as Record<string, { component: FieldComponent }>;
      for (const [key, spec] of Object.entries(fieldSchema)) {
        if (spec.component === 'Upload') continue; // FormView 特例（Attachment[]，非字串契約）
        if (!fieldRegistry[spec.component]) missing.push(`${form}.${key} → ${spec.component}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('未知 component 走 fallback（純文字輸入），不會 crash', () => {
    const renderer = resolveFieldRenderer('NotARealComponent' as FieldComponent);
    const { container } = render(<>{renderer(renderProps({ value: 'hi' }))}</>);
    const input = container.querySelector('input');
    expect(input).not.toBeNull();
    expect(input!.value).toBe('hi');
  });
});

describe('adapter 契約（value 字串往返）', () => {
  it('Select：渲染 options、選取時以 option value 回呼', () => {
    const onChange = vi.fn();
    const renderer = resolveFieldRenderer('Select');
    const { container } = render(
      <>
        {renderer(
          renderProps({
            spec: {
              component: 'Select',
              label: '假別',
              options: [
                { value: 'annual', label: '特休' },
                { value: 'sick', label: '病假' },
              ],
            },
            value: 'annual',
            onChange,
          }),
        )}
      </>,
    );
    const select = container.querySelector('select')!;
    expect(select.value).toBe('annual');
    fireEvent.change(select, { target: { value: 'sick' } });
    expect(onChange).toHaveBeenCalledWith('sick');
  });

  it("Checkbox：'true'/'false' 字串與勾選狀態互轉", () => {
    const onChange = vi.fn();
    const renderer = resolveFieldRenderer('Checkbox');
    const { container } = render(
      <>
        {renderer(
          renderProps({
            spec: { component: 'Checkbox', label: '出差' },
            value: 'true',
            onChange,
          }),
        )}
      </>,
    );
    const box = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(onChange).toHaveBeenCalledWith('false');
  });

  it('Number / Textarea 皆可渲染且帶入現值', () => {
    for (const [component, value] of [
      ['Number', '3'],
      ['Textarea', '家中有事'],
    ] as const) {
      const renderer = resolveFieldRenderer(component as FieldComponent);
      const { container, unmount } = render(
        <>{renderer(renderProps({ spec: { component: component as FieldComponent, label: 'x' }, value }))}</>,
      );
      const el = container.querySelector('input, textarea') as HTMLInputElement;
      expect(el, component).not.toBeNull();
      expect(el.value, component).toBe(value);
      unmount();
    }
  });

  it('DatePicker / TimePicker 可渲染並顯示現值（自製元件，非原生 input）', () => {
    const date = resolveFieldRenderer('DatePicker');
    const { container: dateEl } = render(
      <>{date(renderProps({ spec: { component: 'DatePicker', label: '日期' }, value: '2026-07-20' }))}</>,
    );
    // 以自訂 DOM 呈現（按鈕＋彈出面板），驗證顯示字串即可
    expect(dateEl.textContent).toContain('2026 / 07 / 20');

    const time = resolveFieldRenderer('TimePicker');
    const { container: timeEl } = render(
      <>{time(renderProps({ spec: { component: 'TimePicker', label: '時間' }, value: '09:00' }))}</>,
    );
    // TimePicker 顯示為「09 : 00」（時/分分開呈現）
    expect(timeEl.textContent?.replace(/\s/g, '')).toContain('09:00');
  });
});
