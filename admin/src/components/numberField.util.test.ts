import { describe, it, expect } from 'vitest';
import { parseTypedNumber, settleNumber } from './numberField.util';

describe('parseTypedNumber', () => {
  it('空字串回 null（代表「還在打字」，不要回報數值給外部）', () => {
    // 這正是舊寫法 Number('')=0 的坑：0 被寫回受控欄位就再也刪不掉
    expect(parseTypedNumber('')).toBeNull();
    expect(parseTypedNumber('   ')).toBeNull();
  });
  it('非數字回 null', () => {
    expect(parseTypedNumber('abc')).toBeNull();
    expect(parseTypedNumber('5e')).toBeNull();
  });
  it('數字回數值', () => {
    expect(parseTypedNumber('50')).toBe(50);
    expect(parseTypedNumber('0')).toBe(0);
  });
  it('前導 0 照樣解析（失焦時才正規化顯示）', () => {
    expect(parseTypedNumber('050')).toBe(50);
  });
});

describe('settleNumber', () => {
  const pages = { fallback: 100, min: 1, max: 1000 };
  it('空白／非數字回落原值', () => {
    expect(settleNumber('', pages)).toBe(100);
    expect(settleNumber('abc', pages)).toBe(100);
  });
  it('夾到 server schema 的上下限', () => {
    expect(settleNumber('0', pages)).toBe(1);
    expect(settleNumber('5000', pages)).toBe(1000);
    expect(settleNumber('50', pages)).toBe(50);
  });
  it('取整（避免送出小數被 server 的 int() 擋下）', () => {
    expect(settleNumber('12.7', pages)).toBe(13);
  });
  it('chunkChars 的下限 200 同樣適用', () => {
    expect(settleNumber('2', { fallback: 800, min: 200, max: 4000 })).toBe(200);
  });
  it('無上下限時只取整', () => {
    expect(settleNumber('12.4', { fallback: 1 })).toBe(12);
  });
});
