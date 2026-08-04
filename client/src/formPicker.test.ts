import { describe, expect, it } from 'vitest';
import { pickInitialFormId, shouldShowFormPicker } from './formPicker';

const one = [{ formId: 'task-assignment' }];
const many = [{ formId: 'task-assignment' }, { formId: 'leave-request' }];

describe('shouldShowFormPicker', () => {
  it('單一表單也要顯示（先前 >1 的門檻讓單表單租戶完全看不到 chip）', () => {
    expect(shouldShowFormPicker({ formCount: 1, knowledgePromptCount: 0 })).toBe(true);
  });

  it('多表單顯示', () => {
    expect(shouldShowFormPicker({ formCount: 2, knowledgePromptCount: 0 })).toBe(true);
  });

  it('無表單但有知識庫推薦句時顯示', () => {
    expect(shouldShowFormPicker({ formCount: 0, knowledgePromptCount: 1 })).toBe(true);
  });

  it('兩者皆無時不顯示', () => {
    expect(shouldShowFormPicker({ formCount: 0, knowledgePromptCount: 0 })).toBe(false);
  });
});

describe('pickInitialFormId', () => {
  it('只有一張表單時也不預選（chip 一進畫面就 active 會像使用者已挑過）', () => {
    expect(pickInitialFormId(one, null)).toBeNull();
  });

  it('多張表單時不預選，等使用者挑', () => {
    expect(pickInitialFormId(many, null)).toBeNull();
  });

  it('無表單時回 null', () => {
    expect(pickInitialFormId([], null)).toBeNull();
  });

  it('embed 預選（?form=）仍然生效', () => {
    expect(pickInitialFormId(many, 'leave-request')).toBe('leave-request');
  });

  it('embed 預選不在清單內時忽略，回落不預選', () => {
    expect(pickInitialFormId(one, 'unknown-form')).toBeNull();
  });
});
