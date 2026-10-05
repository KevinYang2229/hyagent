/** 待確認動作：卡片摘要、效期、對外視圖、確認詞判斷。 */
import type { ToolDef } from '@/modules/tools';
import {
  CARD_VALUE_MAX_CHARS,
  PENDING_ACTION_TTL_MS,
  buildConfirmCard,
  createPendingAction,
  isConfirmationText,
  isPendingActionExpired,
  toPendingActionView,
} from '@/modules/conversation/pending-action';

const tool: ToolDef = {
  id: 'mcp.rooms.rooms_book',
  description: '預約會議室',
  inputSchema: {
    type: 'object',
    properties: {
      room: { type: 'string', title: '會議室' },
      date: { type: 'string', description: '日期 YYYY-MM-DD' },
      note: { type: 'string' },
      body: { type: 'string', title: '內文', 'x-display': 'html' },
      attendees: { type: 'array', title: '與會者' },
      meta: { type: 'object', title: '其他' },
    },
  },
  scopes: [],
  effect: 'write',
  handler: async () => undefined,
};

describe('buildConfirmCard', () => {
  it('標籤依 title → description → key 取用，順序依 schema，未知欄位接在後面', () => {
    const card = buildConfirmCard(tool, { extra: 'x', note: 'n', date: '2026-10-03', room: 'A' });
    expect(card.fields).toEqual([
      { label: '會議室', value: 'A' },
      { label: '日期 YYYY-MM-DD', value: '2026-10-03' },
      { label: 'note', value: 'n' },
      { label: 'extra', value: 'x' },
    ]);
  });

  it('原型鏈鍵名（constructor 等）不當成 schema 欄位，也不崩潰', () => {
    // schema 沒有 constructor 屬性，input 有 → 視為未知欄位
    expect(buildConfirmCard(tool, { constructor: 'x' }).fields).toEqual([{ label: 'constructor', value: 'x' }]);
    // schema 有 constructor 屬性、input 沒有 → 不顯示；有則用 schema 標籤
    const withCtor: ToolDef = { ...tool, inputSchema: { type: 'object', properties: { constructor: { type: 'string', title: '建構' } } } };
    expect(buildConfirmCard(withCtor, {}).fields).toEqual([]);
    expect(buildConfirmCard(withCtor, { constructor: 'y' }).fields).toEqual([{ label: '建構', value: 'y' }]);
    expect(buildConfirmCard(tool, { toString: 'z' }).fields).toEqual([{ label: 'toString', value: 'z' }]);
  });

  it('JSON.stringify 得 undefined 的值（函式）省略', () => {
    expect(buildConfirmCard(tool, { note: (() => 1) as never }).fields).toEqual([]);
  });

  it('標題取 confirmTitle，否則取 description', () => {
    expect(buildConfirmCard(tool, {}).title).toBe('預約會議室');
    expect(buildConfirmCard({ ...tool, confirmTitle: '確認預約' }, {}).title).toBe('確認預約');
  });

  it('x-display=html 會去除標籤；陣列以頓號串接；物件轉 JSON；null 省略', () => {
    const card = buildConfirmCard(tool, {
      body: '<p>您好，<b>明天</b>開會</p>',
      attendees: ['王', '李'],
      meta: { a: 1 },
      note: null,
    });
    expect(card.fields).toEqual([
      { label: '內文', value: '您好， 明天 開會' },
      { label: '與會者', value: '王、李' },
      { label: '其他', value: '{"a":1}' },
    ]);
  });

  it('超長值截斷並加刪節號', () => {
    const card = buildConfirmCard(tool, { room: 'x'.repeat(CARD_VALUE_MAX_CHARS + 50) });
    expect(card.fields[0].value).toHaveLength(CARD_VALUE_MAX_CHARS + 1);
    expect(card.fields[0].value.endsWith('…')).toBe(true);
  });

  it('數字與布林轉字串', () => {
    const card = buildConfirmCard(tool, { room: 3, note: false });
    expect(card.fields).toEqual([
      { label: '會議室', value: '3' },
      { label: 'note', value: 'false' },
    ]);
  });
});

describe('createPendingAction / 效期 / 視圖', () => {
  it('效期 10 分鐘、帶 uuid 與工具 id', () => {
    const now = Date.parse('2026-10-03T00:00:00Z');
    const a = createPendingAction(tool, { room: 'A' }, now);
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.toolId).toBe('mcp.rooms.rooms_book');
    expect(Date.parse(a.expiresAt) - now).toBe(PENDING_ACTION_TTL_MS);
    expect(isPendingActionExpired(a, now + PENDING_ACTION_TTL_MS - 1)).toBe(false);
    expect(isPendingActionExpired(a, now + PENDING_ACTION_TTL_MS)).toBe(true);
  });

  it('對外視圖不含工具 id 與原始參數', () => {
    const view = toPendingActionView(createPendingAction(tool, { room: 'A' }));
    expect(Object.keys(view).sort()).toEqual(['expiresAt', 'form', 'id', 'summary']);
  });
});

describe('isConfirmationText', () => {
  it.each(['確認', 'OK', 'ok', '好，寄出', '好的，寄出', '幫我寄', '確認執行', '好', '同意', '確認。'])('「%s」是確認', (s) => {
    expect(isConfirmationText(s)).toBe(true);
  });
  it.each(['OK 謝謝先這樣', '確認一下我的假還有幾天', '不要，取消', '先不要確認', '', '改成下午'])('「%s」不是確認', (s) => {
    expect(isConfirmationText(s)).toBe(false);
  });
});
