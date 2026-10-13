import type { ReplyRecord } from '@/modules/conversation/conversation.types';
import { feedbackFromRow, feedbackStore, feedbackToRow } from '@/modules/feedback/feedback.store';

const reply = (id: string, serviceId = 'knowledge'): ReplyRecord => ({
  id, question: `q-${id}`, answer: `a-${id}`, serviceId, at: '2026-10-13T00:00:00.000Z',
  trace: { model: 'm', retrieval: { query: 'q', poolSize: 1, usedTables: false, chunks: [] } },
});
const base = { tenantId: 't1', userId: 'u1', sessionId: 's1' };

afterEach(() => feedbackStore.clear());

describe('upsert', () => {
  it('第一次評價建立快照（問答、服務、trace），狀態 open', () => {
    const f = feedbackStore.upsert({ ...base, reply: reply('r1'), rating: 'down', reason: 'wrong', comment: '日期錯了' });
    expect(f).toMatchObject({
      tenantId: 't1', userId: 'u1', sessionId: 's1', replyId: 'r1', serviceId: 'knowledge',
      question: 'q-r1', answer: 'a-r1', rating: 'down', reason: 'wrong', comment: '日期錯了', status: 'open',
    });
    expect(f.trace?.retrieval?.chunks).toEqual([]);
  });

  it('同一人對同一則回覆只有一筆；down 改 up 清掉原因與說明', () => {
    const first = feedbackStore.upsert({ ...base, reply: reply('r1'), rating: 'down', reason: 'wrong', comment: 'x' });
    const second = feedbackStore.upsert({ ...base, reply: reply('r1'), rating: 'up' });
    expect(second.id).toBe(first.id);
    expect(second.reason).toBeUndefined();
    expect(second.comment).toBeUndefined();
    expect(feedbackStore.list('t1', {}, { limit: 50 }).items).toHaveLength(1);
  });

  it('改評把已處理重設為 open，並清掉處理說明', () => {
    const f = feedbackStore.upsert({ ...base, reply: reply('r1'), rating: 'down' });
    feedbackStore.setStatus('t1', f.id, 'resolved', '已修正');
    const again = feedbackStore.upsert({ ...base, reply: reply('r1'), rating: 'down', reason: 'outdated' });
    expect(again.status).toBe('open');
    expect(again.resolutionNote).toBeUndefined();
  });

  it('改評不重抓快照：沿用第一次的問答', () => {
    feedbackStore.upsert({ ...base, reply: reply('r1'), rating: 'up' });
    const again = feedbackStore.upsert({ ...base, reply: { ...reply('r1'), answer: '被改過的回答' }, rating: 'down' });
    expect(again.answer).toBe('a-r1');
  });

  it('不同使用者對同一則回覆各自一筆', () => {
    feedbackStore.upsert({ ...base, reply: reply('r1'), rating: 'up' });
    feedbackStore.upsert({ ...base, userId: 'u2', reply: reply('r1'), rating: 'down' });
    expect(feedbackStore.list('t1', {}, { limit: 50 }).items).toHaveLength(2);
  });
});

describe('remove / setStatus', () => {
  it('撤回刪除該筆；不存在時不丟錯', () => {
    feedbackStore.upsert({ ...base, reply: reply('r1'), rating: 'up' });
    feedbackStore.remove('t1', 's1', 'r1', 'u1');
    feedbackStore.remove('t1', 's1', 'r1', 'u1');
    expect(feedbackStore.list('t1', {}, { limit: 50 }).items).toEqual([]);
  });

  it('setStatus 跨租戶查無回 undefined', () => {
    const f = feedbackStore.upsert({ ...base, reply: reply('r1'), rating: 'down' });
    expect(feedbackStore.setStatus('other', f.id, 'resolved')).toBeUndefined();
    expect(feedbackStore.setStatus('t1', f.id, 'resolved', '已補文件')).toMatchObject({ status: 'resolved', resolutionNote: '已補文件' });
  });
});

describe('list', () => {
  it('依建立時間新→舊，游標翻頁；翻頁途中新增的評價不讓下一頁重複', () => {
    for (let i = 0; i < 12; i++) feedbackStore.upsert({ ...base, reply: reply(`r${i}`), rating: 'down' });
    const p1 = feedbackStore.list('t1', {}, { limit: 10 });
    expect(p1.items[0].replyId).toBe('r11');
    feedbackStore.upsert({ ...base, reply: reply('new'), rating: 'down' });
    const p2 = feedbackStore.list('t1', {}, { before: p1.nextCursor!, limit: 10 });
    expect(p2.items.map((f) => f.replyId)).toEqual(['r1', 'r0']);
    expect(p2.nextCursor).toBeNull();
  });

  it('依評價、服務、原因、狀態篩選', () => {
    feedbackStore.upsert({ ...base, reply: reply('a', 'knowledge'), rating: 'down', reason: 'wrong' });
    feedbackStore.upsert({ ...base, reply: reply('b', 'agent'), rating: 'down', reason: 'outdated' });
    feedbackStore.upsert({ ...base, reply: reply('c', 'knowledge'), rating: 'up' });
    const ids = (f: Parameters<typeof feedbackStore.list>[1]) => feedbackStore.list('t1', f, { limit: 50 }).items.map((x) => x.replyId);
    expect(ids({ rating: 'down' })).toEqual(['b', 'a']);
    expect(ids({ serviceId: 'knowledge' })).toEqual(['c', 'a']);
    expect(ids({ reason: 'outdated' })).toEqual(['b']);
    expect(ids({ status: 'resolved' })).toEqual([]);
  });
});

describe('stats', () => {
  it('期間內的總數、讚比例來源、各服務、原因分布與待處理倒讚', () => {
    feedbackStore.upsert({ ...base, reply: reply('a', 'knowledge'), rating: 'down', reason: 'wrong' });
    feedbackStore.upsert({ ...base, reply: reply('b', 'knowledge'), rating: 'up' });
    const c = feedbackStore.upsert({ ...base, reply: reply('c', 'agent'), rating: 'down', reason: 'wrong' });
    feedbackStore.setStatus('t1', c.id, 'resolved');
    const s = feedbackStore.stats('t1', 30);
    expect(s).toMatchObject({
      days: 30, total: 3, up: 1, down: 2, openDown: 1,
      byService: { knowledge: { up: 1, down: 1 }, agent: { up: 0, down: 1 } },
    });
    expect(s.byReason.wrong).toBe(2);
    expect(s.byReason.outdated).toBe(0);
  });

  it('超出期間的不計入', () => {
    feedbackStore.upsert({ ...base, reply: reply('a'), rating: 'up' });
    const in40days = Date.now() + 40 * 86_400_000;
    expect(feedbackStore.stats('t1', 30, in40days).total).toBe(0);
  });
});

describe('管理員處理不改變 updatedAt', () => {
  it('setStatus 保留 updatedAt、resolved 設 resolvedAt、重開移除', () => {
    const f = feedbackStore.upsert({ ...base, reply: reply('a'), rating: 'down', reason: 'wrong' });
    const done = feedbackStore.setStatus('t1', f.id, 'resolved', '已修正')!;
    expect(done.updatedAt).toBe(f.updatedAt);
    expect(done.resolvedAt).toEqual(expect.any(String));
    const reopened = feedbackStore.setStatus('t1', f.id, 'open')!;
    expect(reopened.updatedAt).toBe(f.updatedAt);
    expect(reopened.resolvedAt).toBeUndefined();
  });

  it('處理舊倒讚不會讓它進入近期統計窗口', () => {
    const f = feedbackStore.upsert({ ...base, reply: reply('a'), rating: 'down', reason: 'wrong' });
    const in40days = Date.now() + 40 * 86_400_000;
    expect(feedbackStore.stats('t1', 30, in40days).total).toBe(0);
    feedbackStore.setStatus('t1', f.id, 'resolved');
    expect(feedbackStore.stats('t1', 30, in40days).total).toBe(0);
  });

  it('已處理但過期的項目仍被保存期限清除', () => {
    const f = feedbackStore.upsert({ ...base, reply: reply('a'), rating: 'down', reason: 'wrong' });
    feedbackStore.setStatus('t1', f.id, 'resolved');
    expect(feedbackStore.cleanupExpired(Date.now() + 181 * 86_400_000)).toBe(1);
  });

  it('改評會清掉 resolvedAt', () => {
    const f = feedbackStore.upsert({ ...base, reply: reply('a'), rating: 'down', reason: 'wrong' });
    feedbackStore.setStatus('t1', f.id, 'resolved');
    expect(feedbackStore.upsert({ ...base, reply: reply('a'), rating: 'up' }).resolvedAt).toBeUndefined();
  });
});

describe('保存期限與級聯', () => {
  it('cleanupExpired 刪除 updatedAt 早於保存期限者', () => {
    feedbackStore.upsert({ ...base, reply: reply('a'), rating: 'up' });
    const later = Date.now() + 181 * 86_400_000;
    expect(feedbackStore.cleanupExpired(later)).toBe(1);
    expect(feedbackStore.list('t1', {}, { limit: 50 }).items).toEqual([]);
  });

  it('purgeTenant 只清該租戶', () => {
    feedbackStore.upsert({ ...base, reply: reply('a'), rating: 'up' });
    feedbackStore.upsert({ ...base, tenantId: 't2', reply: reply('a'), rating: 'up' });
    feedbackStore.purgeTenant('t1');
    expect(feedbackStore.list('t1', {}, { limit: 50 }).items).toEqual([]);
    expect(feedbackStore.list('t2', {}, { limit: 50 }).items).toHaveLength(1);
  });

  it('db row round-trip 保留完整快照', () => {
    const f = feedbackStore.upsert({ ...base, reply: reply('a'), rating: 'down', reason: 'wrong' });
    expect(feedbackFromRow(feedbackToRow(f))).toEqual(f);
  });
});
