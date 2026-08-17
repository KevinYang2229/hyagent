import { describe, it, expect } from 'vitest';
import {
  defaultDataType,
  newField,
  emptyDraft,
  fieldsOfStep,
  toDefinition,
  fromDefinition,
  type DraftForm,
  type DraftField,
} from './model';

/** 造一個最小可用欄位，測試時只覆寫關心的屬性 */
function field(overrides: Partial<DraftField> & Pick<DraftField, 'key'>): DraftField {
  return {
    component: 'Input',
    label: overrides.key,
    required: false,
    dataType: 'string',
    stepIndex: 0,
    ...overrides,
  };
}

function draft(overrides: Partial<DraftForm> = {}): DraftForm {
  return { ...emptyDraft('leaveRequest'), title: '請假單', ...overrides };
}

describe('defaultDataType', () => {
  it('依元件給預設資料型別', () => {
    expect(defaultDataType('Number')).toBe('number');
    expect(defaultDataType('Checkbox')).toBe('boolean');
    expect(defaultDataType('Upload')).toBe('array');
    expect(defaultDataType('Input')).toBe('string');
    expect(defaultDataType('Select')).toBe('string');
    expect(defaultDataType('Radio')).toBe('string');
    expect(defaultDataType('Password')).toBe('string');
    expect(defaultDataType('MultiSelect')).toBe('array');
  });
});

describe('newField', () => {
  it('Select 帶預設選項、DatePicker 帶 date format', () => {
    const sel = newField('Select', 0, 0);
    expect(sel.options).toEqual([{ value: 'opt1', label: '選項一' }]);
    expect(sel.dataType).toBe('string');

    const date = newField('DatePicker', 1, 0);
    expect(date.format).toBe('date');
  });

  it('Radio / MultiSelect 同樣帶預設選項（缺 options 會被後端 validator 擋下）', () => {
    expect(newField('Radio', 0, 0).options).toEqual([{ value: 'opt1', label: '選項一' }]);
    const multi = newField('MultiSelect', 1, 0);
    expect(multi.options).toEqual([{ value: 'opt1', label: '選項一' }]);
    expect(multi.dataType).toBe('array');
  });

  it('key 依元件與索引生成、歸屬指定步驟', () => {
    const f = newField('Number', 2, 3);
    expect(f.key).toBe('numberField2');
    expect(f.dataType).toBe('number');
    expect(f.stepIndex).toBe(3);
  });
});

describe('fieldsOfStep', () => {
  it('只回該步驟欄位並保留順序', () => {
    const d = draft({
      fields: [
        field({ key: 'a', stepIndex: 0 }),
        field({ key: 'b', stepIndex: 1 }),
        field({ key: 'c', stepIndex: 0 }),
      ],
    });
    expect(fieldsOfStep(d, 0).map((f) => f.key)).toEqual(['a', 'c']);
    expect(fieldsOfStep(d, 1).map((f) => f.key)).toEqual(['b']);
  });
});

describe('toDefinition（存檔核心）', () => {
  it('欄位 → data.properties + field，additionalProperties=false', () => {
    const d = draft({
      fields: [field({ key: 'reason', label: '事由', component: 'Input' })],
    });
    const def = toDefinition(d);
    expect(def.data.additionalProperties).toBe(false);
    expect(def.data.properties.reason).toEqual({ type: 'string' });
    expect(def.field.reason).toEqual({ component: 'Input', label: '事由' });
    expect(def.data.title).toBe('請假單');
  });

  it('required 只收 required=true 的欄位', () => {
    const d = draft({
      fields: [
        field({ key: 'a', required: true }),
        field({ key: 'b', required: false }),
        field({ key: 'c', required: true }),
      ],
    });
    expect(toDefinition(d).validation.required).toEqual(['a', 'c']);
  });

  it('Select → enum + options，Upload → array + items', () => {
    const d = draft({
      fields: [
        field({
          key: 'type',
          component: 'Select',
          options: [
            { value: 'annual', label: '特休' },
            { value: 'sick', label: '病假' },
          ],
        }),
        field({ key: 'attachments', component: 'Upload', dataType: 'array' }),
      ],
    });
    const def = toDefinition(d);
    expect(def.data.properties.type.enum).toEqual(['annual', 'sick']);
    expect(def.field.type.options).toHaveLength(2);
    expect(def.data.properties.attachments.type).toBe('array');
    expect(def.data.properties.attachments.items).toEqual({ type: 'object' });
  });

  it('Radio → enum + options（與 Select 同）；Password 就是一般 string 欄位', () => {
    const d = draft({
      fields: [
        field({
          key: 'q1',
          component: 'Radio',
          options: [
            { value: 'option1', label: '單選1' },
            { value: 'option2', label: '單選2' },
          ],
        }),
        field({ key: 'password', component: 'Password' }),
      ],
    });
    const def = toDefinition(d);
    expect(def.data.properties.q1.enum).toEqual(['option1', 'option2']);
    expect(def.field.q1.options).toHaveLength(2);
    expect(def.data.properties.password).toEqual({ type: 'string' });
    expect(def.field.password).toEqual({ component: 'Password', label: 'password' });
  });

  it('MultiSelect → array + items.enum（值為選項 value 的清單）', () => {
    const d = draft({
      fields: [
        field({
          key: 'products',
          component: 'MultiSelect',
          dataType: 'array',
          options: [
            { value: 'P001', label: '產品一' },
            { value: 'P002', label: '產品二' },
          ],
        }),
      ],
    });
    const def = toDefinition(d);
    expect(def.data.properties.products.type).toBe('array');
    expect(def.data.properties.products.items).toEqual({
      type: 'string',
      enum: ['P001', 'P002'],
    });
    // 多選的 enum 掛在 items 上，頂層不應有 enum
    expect(def.data.properties.products.enum).toBeUndefined();
    expect(def.field.products.options).toHaveLength(2);
  });

  it('askOrder 依步驟順序展平，跨步驟仍連續', () => {
    const d = draft({
      steps: [{ title: '基本' }, { title: '明細' }],
      // 故意讓陣列順序與步驟順序不同，驗證是以步驟為正規順序
      fields: [
        field({ key: 's2a', stepIndex: 1 }),
        field({ key: 's1a', stepIndex: 0 }),
        field({ key: 's1b', stepIndex: 0 }),
      ],
    });
    expect(toDefinition(d).agent.askOrder).toEqual(['s1a', 's1b', 's2a']);
  });

  it('layout：每步一個 section，sameRowAsPrev 併列但一列最多兩欄', () => {
    const d = draft({
      steps: [{ title: '基本' }],
      fields: [
        field({ key: 'a' }),
        field({ key: 'b', sameRowAsPrev: true }),
        field({ key: 'c', sameRowAsPrev: true }), // 第三欄超過兩欄上限 → 另起一列
      ],
    });
    const sections = toDefinition(d).layout!.sections;
    expect(sections).toHaveLength(1);
    expect(sections[0].fields).toEqual([['a', 'b'], ['c']]);
  });

  it('空步驟不產生 section，但至少保留一個佔位 section', () => {
    const d = draft({ steps: [{ title: '基本' }, { title: '空的' }], fields: [] });
    const sections = toDefinition(d).layout!.sections;
    expect(sections).toHaveLength(1);
    expect(sections[0].fields).toEqual([]);
  });

  it('進階層（workflow/policy/oa）原樣 passthrough，未設則不帶鍵', () => {
    const wf = { steps: [{ id: 'mgr', name: '主管' }] } as unknown as DraftForm['workflow'];
    const withWf = toDefinition(draft({ workflow: wf, fields: [field({ key: 'a' })] }));
    expect(withWf.workflow).toBe(wf);

    const without = toDefinition(draft({ fields: [field({ key: 'a' })] }));
    expect('workflow' in without).toBe(false);
    expect('policy' in without).toBe(false);
    expect('oa' in without).toBe(false);
  });
});

describe('fromDefinition ∘ toDefinition round-trip', () => {
  it('多步驟 + 併列 + Select + required 往返後結構不變', () => {
    const original = draft({
      formId: 'leaveRequest',
      title: '請假單',
      intent: 'leave',
      description: '請假申請',
      keywords: ['請假', '休假'],
      steps: [{ title: '基本' }, { title: '明細' }],
      fields: [
        field({ key: 'name', label: '姓名', required: true, stepIndex: 0 }),
        field({ key: 'dept', label: '部門', required: true, sameRowAsPrev: true, stepIndex: 0 }),
        field({
          key: 'type',
          label: '假別',
          component: 'Select',
          options: [{ value: 'annual', label: '特休' }],
          stepIndex: 1,
        }),
      ],
    });

    const round = fromDefinition(toDefinition(original));

    expect(round.formId).toBe('leaveRequest');
    expect(round.title).toBe('請假單');
    expect(round.intent).toBe('leave');
    expect(round.keywords).toEqual(['請假', '休假']);
    expect(round.steps.map((s) => s.title)).toEqual(['基本', '明細']);
    // 欄位 key / 步驟歸屬 / required / 併列旗標保留
    expect(round.fields.map((f) => f.key)).toEqual(['name', 'dept', 'type']);
    expect(round.fields.map((f) => f.stepIndex)).toEqual([0, 0, 1]);
    expect(round.fields.find((f) => f.key === 'name')?.required).toBe(true);
    expect(round.fields.find((f) => f.key === 'dept')?.sameRowAsPrev).toBe(true);
    expect(round.fields.find((f) => f.key === 'name')?.sameRowAsPrev).toBe(false);
    expect(round.fields.find((f) => f.key === 'type')?.options).toEqual([
      { value: 'annual', label: '特休' },
    ]);
  });
});

describe('fromDefinition fallback', () => {
  it('無 layout 時以 properties 順序各自成列', () => {
    const def = toDefinition(draft({ fields: [field({ key: 'a' }), field({ key: 'b' })] }));
    // 移除 layout 模擬舊表單
    delete def.layout;
    const d = fromDefinition(def);
    expect(d.steps).toHaveLength(1);
    expect(d.fields.map((f) => f.key)).toEqual(['a', 'b']);
    // 各自成列（非併排）
    expect(d.fields.every((f) => f.sameRowAsPrev === false)).toBe(true);
  });
});
