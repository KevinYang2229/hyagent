import { chatRoute } from './chatRoute';

it('帶問題與唯一 nonce 到 AI 對話', () => {
  const a = chatRoute({ q: '查庫存' });
  const b = chatRoute({ voice: '1' });
  expect(a.pathname).toBe('/chat');
  expect(a.params.q).toBe('查庫存');
  expect(b.params.voice).toBe('1');
  expect(a.params.nonce).not.toBe(b.params.nonce);
});
