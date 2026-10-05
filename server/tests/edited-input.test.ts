import { describeEdits, validateEditedInput } from '@/modules/conversation/edited-input';

const schema = {
  type: 'object',
  properties: {
    items: {
      type: 'array', title: '補貨品項',
      items: {
        type: 'object',
        properties: {
          productId: { type: 'string', readOnly: true, 'x-hidden': true },
          name: { type: 'string', title: '商品名稱', readOnly: true },
          stock: { type: 'integer', title: '目前庫存', readOnly: true },
          quantity: { type: 'integer', title: '補貨數量' },
        },
      },
    },
    arrivalDate: { type: 'string', format: 'date', title: '預計到貨日期' },
    storeId: { type: 'string', readOnly: true },
  },
};
const original = {
  items: [
    { productId: 'P1', name: '鮭魚御飯糰', stock: 6, quantity: 24 },
    { productId: 'P2', name: '三明治', stock: 4, quantity: 20 },
    { productId: 'P3', name: '沙拉', stock: 5, quantity: 18 },
  ],
  arrivalDate: '2026-10-05',
  storeId: 'S01',
};
const clone = () => JSON.parse(JSON.stringify(original)) as typeof original;

describe('validateEditedInput', () => {
  it('原封不動 → ok', () => {
    expect(validateEditedInput(schema, original, clone())).toEqual({ ok: true });
  });

  it('改可編輯欄位、刪列、調換順序 → ok', () => {
    const e = clone();
    e.items = [{ ...e.items[2], quantity: 30 }, e.items[0]];
    e.arrivalDate = '2026-10-06';
    expect(validateEditedInput(schema, original, e)).toEqual({ ok: true });
  });

  it.each([
    ['改純量唯讀欄位', (e: ReturnType<typeof clone>) => { e.storeId = 'S99'; }],
    ['改列的唯讀欄位', (e: ReturnType<typeof clone>) => { e.items[0].stock = 99; }],
    ['新增一列', (e: ReturnType<typeof clone>) => { e.items.push({ productId: 'P9', name: '新', stock: 0, quantity: 1 }); }],
    ['同一列送兩次', (e: ReturnType<typeof clone>) => { e.items = [e.items[0], { ...e.items[0], quantity: 1 }]; }],
    ['多出 schema 沒有的鍵', (e: ReturnType<typeof clone>) => { (e as Record<string, unknown>).extra = 1; }],
    ['列多出鍵', (e: ReturnType<typeof clone>) => { (e.items[0] as Record<string, unknown>).hack = 1; }],
    ['刪掉原本有的唯讀欄位', (e: ReturnType<typeof clone>) => { delete (e as Partial<typeof original>).storeId; }],
  ])('%s → 不通過', (_name, mutate) => {
    const e = clone();
    mutate(e);
    const r = validateEditedInput(schema, original, e);
    expect(r.ok).toBe(false);
  });

  it('不是物件 → 不通過', () => {
    expect(validateEditedInput(schema, original, [1]).ok).toBe(false);
  });

  it('項目沒有唯讀欄位的陣列：列數與順序須相同，只能改值', () => {
    const s = { type: 'object', properties: { rows: { type: 'array', items: { type: 'object', properties: { q: { type: 'integer' } } } } } };
    const o = { rows: [{ q: 1 }, { q: 2 }] };
    expect(validateEditedInput(s, o, { rows: [{ q: 5 }, { q: 6 }] })).toEqual({ ok: true });
    expect(validateEditedInput(s, o, { rows: [{ q: 1 }] }).ok).toBe(false);
  });
});

describe('describeEdits', () => {
  it('描述欄位修改與刪列', () => {
    const e = clone();
    e.items = [{ ...e.items[0], quantity: 30 }, e.items[1]];
    e.arrivalDate = '2026-10-06';
    expect(describeEdits(schema, original, e)).toEqual([
      '鮭魚御飯糰 補貨數量 24→30',
      '移除 沙拉',
      '預計到貨日期 2026-10-05→2026-10-06',
    ]);
  });

  it('沒有修改 → 空陣列', () => {
    expect(describeEdits(schema, original, clone())).toEqual([]);
  });
});

describe('validateEditedInput：鎖定鍵（圖片來源、唯讀陣列）', () => {
  const imgSchema = {
    type: 'object',
    properties: {
      items: {
        type: 'array', title: '品項',
        items: {
          type: 'object',
          properties: {
            productId: { type: 'string', readOnly: true, 'x-hidden': true },
            name: { type: 'string', title: '商品名稱', readOnly: true },
            imageUrl: { type: 'string', title: '圖片網址' },
            photo: { type: 'string', 'x-image': 'imageUrl' },
            quantity: { type: 'integer', title: '數量' },
          },
        },
      },
    },
  };
  const imgOrig = { items: [{ productId: 'P1', name: '飯糰', imageUrl: 'a.png', photo: 'x', quantity: 1 }] };

  it('改圖片來源鍵 → 不通過', () => {
    const r = validateEditedInput(imgSchema, imgOrig, { items: [{ ...imgOrig.items[0], imageUrl: 'evil.png' }] });
    expect(r.ok).toBe(false);
  });

  it('只改可編輯欄位 → ok', () => {
    expect(validateEditedInput(imgSchema, imgOrig, { items: [{ ...imgOrig.items[0], quantity: 9 }] })).toEqual({ ok: true });
  });

  const roSchema = {
    type: 'object',
    properties: {
      rows: { type: 'array', readOnly: true, items: { type: 'object', properties: { q: { type: 'integer' } } } },
    },
  };
  const roOrig = { rows: [{ q: 1 }, { q: 2 }] };

  it('唯讀陣列原樣 → ok', () => {
    expect(validateEditedInput(roSchema, roOrig, { rows: [{ q: 1 }, { q: 2 }] })).toEqual({ ok: true });
  });

  it('唯讀陣列改列或刪列 → 不通過', () => {
    expect(validateEditedInput(roSchema, roOrig, { rows: [{ q: 5 }, { q: 2 }] }).ok).toBe(false);
    expect(validateEditedInput(roSchema, roOrig, { rows: [{ q: 1 }] }).ok).toBe(false);
  });
});

describe('validateEditedInput：注入與格式錯誤', () => {
  it('原本沒有表格鍵，修改後新增 → 不通過', () => {
    const o = { arrivalDate: '2026-10-05', storeId: 'S01' };
    const e = { ...o, items: [{ productId: 'P9', name: 'x', stock: 999, quantity: 5 }] };
    expect(validateEditedInput(schema, o, e).ok).toBe(false);
  });

  it('原本沒有選填純量，修改後新增 → 不通過', () => {
    const s = { type: 'object', properties: { a: { type: 'string' }, note: { type: 'string' } } };
    expect(validateEditedInput(s, { a: '1' }, { a: '1', note: 'x' }).ok).toBe(false);
  });

  it('表格值不是陣列 → 不通過', () => {
    const e = { ...clone(), items: {} };
    expect(validateEditedInput(schema, original, e).ok).toBe(false);
  });

  it('列不是物件 → 不通過', () => {
    const e = { ...clone(), items: [null] };
    expect(validateEditedInput(schema, original, e).ok).toBe(false);
  });

  const lockSchema = {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            productId: { type: 'string', readOnly: true },
            imageUrl: { type: 'string' },
            photo: { type: 'string', 'x-image': 'imageUrl' },
            quantity: { type: 'integer' },
          },
        },
      },
    },
  };

  it('刪掉列內鎖定的非識別鍵 → 不通過', () => {
    const o = { items: [{ productId: 'P1', imageUrl: 'a.png', quantity: 1 }] };
    expect(validateEditedInput(lockSchema, o, { items: [{ productId: 'P1', quantity: 1 }] }).ok).toBe(false);
  });

  it('原列沒有的鎖定非識別鍵被注入 → 不通過', () => {
    const o = { items: [{ productId: 'P1', quantity: 1 }] };
    expect(validateEditedInput(lockSchema, o, { items: [{ productId: 'P1', imageUrl: 'evil.png', quantity: 1 }] }).ok).toBe(false);
  });
});
