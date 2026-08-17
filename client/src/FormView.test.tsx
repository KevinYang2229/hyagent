/**
 * FormView 確認流程：schema-driven 渲染 + 送出前可編輯 + 所見即所送。
 * 用真實 leave-request schema（不含 layout → 扁平單頁）驗證：
 * 渲染、必填缺漏擋送出、編輯欄位後按「確認送出」時 onConfirm 收到編輯後的值。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen, waitFor } from '@testing-library/react';
import type { Definition } from '@oa-agent/shared';
import FormView from './FormView';

const DIR = join(__dirname, '../../schemas/leave-request');
const load = <T,>(name: string): T => JSON.parse(readFileSync(join(DIR, name), 'utf-8')) as T;

// 不帶 layout：走扁平單頁（有 layout 會分步驟，確認鈕在最後一步，這裡聚焦確認流程本身）
const def = {
  formId: 'leave-request',
  data: load('data.schema.json'),
  field: load('field.schema.json'),
  validation: load('validation.schema.json'),
  agent: load('agent.schema.json'),
} as unknown as Definition;

/** 必填齊全的一組值（依 leave-request validation.required） */
const completeValues: Record<string, unknown> = {
  applicant: 'kevin',
  deputy: 'HYW103',
  leaveType: 'annual',
  startDate: '2026-07-20',
  startTime: '09:00',
  endDate: '2026-07-20',
  endTime: '18:00',
  reason: '家中有事',
};

describe('FormView 確認流程', () => {
  it('依 schema 渲染欄位標籤與現值', () => {
    render(
      <FormView def={def} values={completeValues} onConfirm={vi.fn()} onClose={() => {}} />,
    );
    for (const key of Object.keys(def.field)) {
      const label = def.field[key]?.label;
      if (label && def.field[key]?.component !== 'Upload') {
        expect(screen.getAllByText(label, { exact: false }).length, key).toBeGreaterThan(0);
      }
    }
  });

  it('必填缺漏：「確認送出」按鈕 disabled，onConfirm 不可能被呼叫（伺服器端另有硬守）', () => {
    const onConfirm = vi.fn();
    render(
      <FormView
        def={def}
        values={{ ...completeValues, reason: '' }}
        onConfirm={onConfirm}
        onClose={() => {}}
      />,
    );
    const btn = screen.getByRole('button', { name: '確認送出' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('編輯欄位後送出：onConfirm 收到編輯後的 draft（所見即所送）', async () => {
    const onConfirm = vi.fn(async (_draft: Record<string, unknown>) => {});
    const { container } = render(
      <FormView def={def} values={completeValues} onConfirm={onConfirm} onClose={() => {}} />,
    );
    // 修改事由（Textarea）
    const textarea = container.querySelector('textarea')!;
    fireEvent.change(textarea, { target: { value: '改成陪病假事由' } });
    fireEvent.click(screen.getByRole('button', { name: '確認送出' }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    const draft = onConfirm.mock.calls[0]![0];
    expect(draft.reason).toBe('改成陪病假事由');
    expect(draft.leaveType).toBe('annual');
    expect(draft.startDate).toBe('2026-07-20');
  });
});

/** Radio / MultiSelect / Password：值的往返與唯讀呈現（陣列與密碼有別於一般字串欄位） */
describe('FormView：Radio / MultiSelect / Password 欄位', () => {
  const surveyDef = {
    formId: 'survey',
    data: {
      type: 'object',
      properties: {
        q1: { type: 'string', enum: ['option1', 'option2'] },
        products: { type: 'array', items: { type: 'string' } },
        password: { type: 'string' },
      },
    },
    field: {
      q1: {
        component: 'Radio',
        label: '問卷標題內容-中',
        options: [
          { value: 'option1', label: '單選1' },
          { value: 'option2', label: '單選2' },
        ],
      },
      products: {
        component: 'MultiSelect',
        label: '有興趣項目',
        options: [
          { value: 'P001', label: '產品一' },
          { value: 'P002', label: '產品二' },
        ],
      },
      password: { component: 'Password', label: '密碼' },
    },
    validation: { required: ['q1', 'products'] },
    agent: { intent: 'survey', description: '問卷' },
  } as unknown as Definition;

  it('多選為空陣列時視為必填未填，確認鈕 disabled', () => {
    render(
      <FormView
        def={surveyDef}
        values={{ q1: 'option1', products: [] }}
        onConfirm={vi.fn()}
        onClose={() => {}}
      />,
    );
    expect((screen.getByRole('button', { name: '確認送出' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('改選 Radio 與加選多選項目後送出，draft 帶回字串與陣列', async () => {
    const onConfirm = vi.fn(async (_draft: Record<string, unknown>) => {});
    const { container } = render(
      <FormView
        def={surveyDef}
        values={{ q1: 'option1', products: ['P001'], password: 'Abcd1234!' }}
        onConfirm={onConfirm}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByLabelText('單選2'));
    fireEvent.focus(container.querySelector('.multi-select-input')!);
    fireEvent.click(screen.getByText('產品二'));
    fireEvent.click(screen.getByRole('button', { name: '確認送出' }));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    const draft = onConfirm.mock.calls[0]![0];
    expect(draft.q1).toBe('option2');
    expect(draft.products).toEqual(['P001', 'P002']);
  });

  it('送出後唯讀呈現：多選顯示 label 串接、密碼遮蔽', () => {
    render(
      <FormView
        def={surveyDef}
        values={{ q1: 'option2', products: ['P001', 'P002'], password: 'Abcd1234!' }}
        submission={{ oaRequestId: 'OA-1', status: 'accepted' } as never}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText('產品一、產品二')).toBeTruthy();
    expect(screen.getByText('••••••')).toBeTruthy();
    expect(screen.queryByText('Abcd1234!')).toBeNull();
  });
});
