import { buildConfirmForm, lockedKeysOf, schemaProps } from '@/modules/conversation/confirm-form';
import { createPendingAction, toPendingActionView } from '@/modules/conversation/pending-action';
import type { ToolDef } from '@/modules/tools';
import { makeToolContext, toolRegistry } from '@/modules/tools';

const replenish: ToolDef = {
  id: 'mcp.store-demo.replenishment_create',
  description: '建立補貨單',
  confirmTitle: '確認建立補貨單',
  scopes: [],
  effect: 'write',
  inputSchema: {
    type: 'object',
    properties: {
      items: {
        type: 'array', title: '補貨品項', minItems: 1,
        items: {
          type: 'object',
          properties: {
            productId: { type: 'string', readOnly: true, 'x-hidden': true },
            image: { type: 'string', readOnly: true },
            name: { type: 'string', title: '商品名稱', readOnly: true, 'x-image': 'image' },
            stock: { type: 'integer', title: '目前庫存', readOnly: true, 'x-unit': '個' },
            quantity: { type: 'integer', title: '建議補貨數量', minimum: 1, maximum: 200, 'x-unit': '個' },
          },
        },
      },
      arrivalDate: { type: 'string', format: 'date', title: '預計到貨日期' },
      priority: { type: 'string', enum: ['normal', 'urgent'], title: '優先度', 'x-enumLabels': { normal: '一般', urgent: '急件' } },
      note: { type: 'string', title: '備註' },
      body: { type: 'string', title: '內文', 'x-display': 'html' },
    },
  },
  handler: async () => undefined,
};

const input = {
  items: [
    { productId: 'P1', image: 'https://x/1.png', name: '鮭魚御飯糰', stock: 6, quantity: 24 },
    { productId: 'P2', name: '三明治', stock: 4, quantity: 20 },
  ],
  arrivalDate: '2026-10-05',
  priority: 'urgent',
  note: '早班',
  body: '<p>hi</p>',
};

describe('buildConfirmForm', () => {
  const form = buildConfirmForm(replenish, input);

  it('標題取 confirmTitle', () => {
    expect(form.title).toBe('確認建立補貨單');
  });

  it('物件陣列 → 可勾選表格；隱藏欄位與圖片欄位不成為欄；唯讀不可編輯', () => {
    const table = form.fields[0];
    expect(table).toMatchObject({ kind: 'table', key: 'items', label: '補貨品項', selectable: true });
    if (table.kind !== 'table') throw new Error('not table');
    expect(table.columns).toEqual([
      { key: 'name', label: '商品名稱', kind: 'text', editable: false, image: 'image' },
      { key: 'stock', label: '目前庫存', kind: 'number', editable: false, unit: '個' },
      { key: 'quantity', label: '建議補貨數量', kind: 'number', editable: true, unit: '個', min: 1, max: 200 },
    ]);
    expect(table.rows).toEqual(input.items);
  });

  it('日期、下拉、文字、html 唯讀', () => {
    const byKey = Object.fromEntries(form.fields.map((f) => [f.key, f]));
    expect(byKey.arrivalDate).toEqual({ kind: 'date', key: 'arrivalDate', label: '預計到貨日期', value: '2026-10-05', editable: true });
    expect(byKey.priority).toEqual({
      kind: 'select', key: 'priority', label: '優先度', value: 'urgent', editable: true,
      options: [{ value: 'normal', label: '一般', raw: 'normal' }, { value: 'urgent', label: '急件', raw: 'urgent' }],
    });
    expect(byKey.note).toMatchObject({ kind: 'text', value: '早班', editable: true });
    expect(byKey.body).toMatchObject({ kind: 'text', value: 'hi', editable: false });
  });

  it('只剩 minItems 列 → 不可勾選；項目沒有唯讀欄位 → 不可勾選', () => {
    const one = buildConfirmForm(replenish, { ...input, items: [input.items[0]] });
    expect(one.fields[0]).toMatchObject({ selectable: false });
    const noId: ToolDef = {
      ...replenish,
      inputSchema: { type: 'object', properties: { rows: { type: 'array', items: { type: 'object', properties: { q: { type: 'integer' } } } } } },
    };
    expect(buildConfirmForm(noId, { rows: [{ q: 1 }, { q: 2 }] }).fields[0]).toMatchObject({ kind: 'table', selectable: false });
  });

  it('input 沒有的欄位不出現；schema 沒有的鍵不出現', () => {
    const f = buildConfirmForm(replenish, { arrivalDate: '2026-10-05', stray: 1 });
    expect(f.fields.map((x) => x.key)).toEqual(['arrivalDate']);
  });

  it('createPendingAction 帶 form，對外視圖也帶 form', () => {
    const a = createPendingAction(replenish, input);
    expect(a.form.title).toBe('確認建立補貨單');
    expect(toPendingActionView(a).form).toEqual(a.form);
  });
});

it('email.send：收件人與主旨可編輯、內文唯讀', () => {
  const tool = toolRegistry.resolve('email.send', makeToolContext({ tenantId: 'default', userId: 'kevin' }));
  const f = buildConfirmForm(tool, { to: 'a@x.com', subject: 's', html: '<p>x</p>' });
  expect(f.fields.map((x) => [x.key, x.kind === 'table' ? null : x.editable])).toEqual([
    ['to', true], ['subject', true], ['html', false],
  ]);
});

describe('鎖定規則', () => {
  it('唯讀陣列 → 不可勾選、欄位全不可編輯', () => {
    const tool: ToolDef = {
      ...replenish,
      inputSchema: {
        type: 'object',
        properties: {
          items: { type: 'array', readOnly: true, items: { type: 'object', properties: { id: { type: 'string', readOnly: true }, q: { type: 'integer' } } } },
        },
      },
    };
    const t = buildConfirmForm(tool, { items: [{ id: 'a', q: 1 }, { id: 'b', q: 2 }] }).fields[0];
    if (t.kind !== 'table') throw new Error('not table');
    expect(t.selectable).toBe(false);
    expect(t.columns.every((c) => !c.editable)).toBe(true);
  });

  it('x-image 來源鍵即使沒 readOnly 也算鎖定，且不成欄', () => {
    const itemProps = schemaProps((replenish.inputSchema.properties as any).items.items);
    const props = { ...itemProps, image: { type: 'string' } };
    expect(lockedKeysOf(props).has('image')).toBe(true);
    const tool: ToolDef = {
      ...replenish,
      inputSchema: { type: 'object', properties: { rows: { type: 'array', items: { type: 'object', properties: { image: { type: 'string' }, name: { type: 'string', 'x-image': 'image' } } } } } },
    };
    const t = buildConfirmForm(tool, { rows: [{ image: 'u', name: 'n' }] }).fields[0];
    if (t.kind !== 'table') throw new Error('not table');
    expect(t.columns.map((c) => c.key)).toEqual(['name']);
  });

  it('lockedKeysOf 單元', () => {
    const keys = lockedKeysOf({
      a: { readOnly: true }, b: { 'x-hidden': true }, c: { 'x-display': 'html' },
      src: { type: 'string' }, pic: { 'x-image': 'src' }, free: { type: 'string' },
    });
    expect([...keys].sort()).toEqual(['a', 'b', 'c', 'src']);
  });
});

describe('buildConfirmForm — 基本型別陣列', () => {
  it('string[] 不產生表格欄位（零欄表格會讓確認鈕停用），其他欄位照常', () => {
    const form = buildConfirmForm(
      {
        description: '標籤',
        inputSchema: {
          type: 'object',
          properties: { tags: { type: 'array', items: { type: 'string' } }, note: { type: 'string', title: '備註' } },
        },
      },
      { tags: ['a', 'b'], note: 'x' },
    );
    expect(form.fields.map((f) => f.key)).toEqual(['note']);
  });
});

describe('buildConfirmForm — 選項保留原始型別', () => {
  it('數字 enum 的選項帶 raw（數字）', () => {
    const form = buildConfirmForm(
      { description: 'x', inputSchema: { type: 'object', properties: { level: { type: 'integer', enum: [1, 2], title: '等級' } } } },
      { level: 1 },
    );
    expect(form.fields[0]).toMatchObject({ options: [{ value: '1', label: '1', raw: 1 }, { value: '2', label: '2', raw: 2 }] });
  });
});
