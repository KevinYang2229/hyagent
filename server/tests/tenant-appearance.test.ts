/**
 * 租戶外觀 schema 回歸測試：確保 appearanceSchema 不會吃掉 assistantName（AI 名稱）。
 * 先前 bug：zod object 預設 strip 未列出的 key，導致存檔時 assistantName 被丟棄、重整後消失。
 */
import { appearanceSchema } from '@/modules/admin/admin.schema';

describe('appearanceSchema', () => {
  it('保留 assistantName（AI 名稱），不被 strip', () => {
    const out = appearanceSchema.parse({ assistantName: '小華', primaryColor: '#112233' });
    expect(out.assistantName).toBe('小華');
  });

  it('assistantName 為選填，缺省時不報錯', () => {
    const out = appearanceSchema.parse({ primaryColor: '#112233' });
    expect(out.assistantName).toBeUndefined();
  });

  it('assistantName 超過 30 字時拒絕', () => {
    expect(() => appearanceSchema.parse({ assistantName: 'x'.repeat(31) })).toThrow();
  });
});

describe('appearanceSchema.position', () => {
  it('接受四角位置 br / bl / tr / tl', () => {
    for (const position of ['br', 'bl', 'tr', 'tl'] as const) {
      expect(appearanceSchema.parse({ position }).position).toBe(position);
    }
  });

  it('拒絕未定義的位置值', () => {
    expect(() => appearanceSchema.parse({ position: 'center' })).toThrow();
  });
});
