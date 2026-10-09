import mci from '@expo/vector-icons/build/vendor/react-native-vector-icons/glyphmaps/MaterialCommunityIcons.json';
import { CATEGORIES, PRODUCTS, SPEC_ROWS, getProduct, productsIn } from './catalog';


it('產品 id 不重複，且都屬於既有分類', () => {
  const ids = PRODUCTS.map((p) => p.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const p of PRODUCTS) expect(CATEGORIES.map((c) => c.id)).toContain(p.category);
});

it('每個分類至少有一項產品', () => {
  for (const c of CATEGORIES) expect(productsIn(c.id).length).toBeGreaterThan(0);
  expect(productsIn(undefined)).toHaveLength(PRODUCTS.length);
});

it('用到的圖示都存在於 MaterialCommunityIcons', () => {
  const names = [...CATEGORIES.map((c) => c.icon), ...PRODUCTS.flatMap((p) => [p.icon, ...p.highlights.map((h) => h.icon)])];
  for (const n of names) expect(Object.keys(mci)).toContain(n);
});

it('詳細頁亮點最多四個、規格只用 SPEC_ROWS 的欄位', () => {
  const keys = SPEC_ROWS.map((r) => r.key as string);
  for (const p of PRODUCTS) {
    expect(p.highlights.length).toBeLessThanOrEqual(4);
    for (const k of Object.keys(p.specs)) expect(keys).toContain(k);
  }
});

it('getProduct 找不到時回 undefined', () => {
  expect(getProduct('kiosk')?.name).toBe('直立式自助借還書機');
  expect(getProduct('nope')).toBeUndefined();
  expect(getProduct(undefined)).toBeUndefined();
});

it('每項產品都有產品照，分類的代表產品都存在', () => {
  for (const p of PRODUCTS) expect(p.image).toBeDefined();
  for (const c of CATEGORIES) expect(getProduct(c.cover)).toBeDefined();
});
