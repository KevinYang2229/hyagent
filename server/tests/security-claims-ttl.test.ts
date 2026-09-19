/**
 * security_claims 的到期語意與 Assertion jti 防重放（規格 §8.5、評估文件決策 B）。
 *
 * 這裡最要緊的是「不該過期的東西沒被清掉」：refresh 與送出防重的紀錄沒有到期時間，
 * 被 sweep 掃掉就等於讓一張用過的 refresh token 重新可用。TTL 加錯邊的代價不對稱，
 * 所以兩個方向都要釘。
 */
import { ClaimReplayStore } from '@/lib/assertion/claim-replay-store';
import { securityClaims } from '@/lib/security-claims';

const now = () => Math.floor(Date.now() / 1000);
let seq = 0;
const uniqueKey = (prefix: string) => `${prefix}:${process.pid}:${seq++}:${Math.random()}`;

describe('securityClaims：無到期時間（既有用法，語意不變）', () => {
  it('第一次宣告成功，第二次失敗', async () => {
    const key = uniqueKey('refresh-used');
    await expect(securityClaims.claim(key)).resolves.toBe(true);
    await expect(securityClaims.claim(key)).resolves.toBe(false);
    await expect(securityClaims.has(key)).resolves.toBe(true);
  });

  it('sweep 不會碰它——永久紀錄被清掉等於撤銷失效', async () => {
    const key = uniqueKey('refresh-revoked');
    await securityClaims.claim(key);
    await securityClaims.sweepExpired();
    await expect(securityClaims.has(key)).resolves.toBe(true);
    await expect(securityClaims.claim(key)).resolves.toBe(false);
  });
});

describe('securityClaims：帶到期時間', () => {
  it('未到期時重複宣告仍然失敗', async () => {
    const key = uniqueKey('jti');
    await expect(securityClaims.claim(key, now() + 300)).resolves.toBe(true);
    await expect(securityClaims.claim(key, now() + 300)).resolves.toBe(false);
  });

  it('已過期的紀錄不算佔用：可重新宣告，has() 也回 false', async () => {
    const key = uniqueKey('jti');
    await securityClaims.claim(key, now() - 1);
    await expect(securityClaims.has(key)).resolves.toBe(false);
    // 清理排程還沒跑到，行為也必須與已清掉時相同
    await expect(securityClaims.claim(key, now() + 300)).resolves.toBe(true);
  });

  it('sweep 只刪過期的那些', async () => {
    const expired = uniqueKey('jti-expired');
    const live = uniqueKey('jti-live');
    const permanent = uniqueKey('permanent');
    await securityClaims.claim(expired, now() - 1);
    await securityClaims.claim(live, now() + 300);
    await securityClaims.claim(permanent);

    const removed = await securityClaims.sweepExpired();

    expect(removed).toBeGreaterThanOrEqual(1);
    await expect(securityClaims.has(live)).resolves.toBe(true);
    await expect(securityClaims.has(permanent)).resolves.toBe(true);
    // 已被清掉 → 重新宣告會成功
    await expect(securityClaims.claim(expired, now() + 300)).resolves.toBe(true);
  });
});

describe('ClaimReplayStore（規格 §8.5 步驟 19–20）', () => {
  const store = new ClaimReplayStore();

  it('同一把 Assertion 送兩次，第二次被擋', async () => {
    const key = `tenantA:kid1:${uniqueKey('jti')}`;
    await expect(store.consume(key, now() + 60)).resolves.toBe(true);
    await expect(store.consume(key, now() + 60)).resolves.toBe(false);
  });

  it('鍵含 tenant 與 kid：不同租戶用到同一個 jti 不會互相誤擋', async () => {
    const jti = uniqueKey('jti');
    await expect(store.consume(`tenantA:kid1:${jti}`, now() + 60)).resolves.toBe(true);
    await expect(store.consume(`tenantB:kid1:${jti}`, now() + 60)).resolves.toBe(true);
    await expect(store.consume(`tenantA:kid2:${jti}`, now() + 60)).resolves.toBe(true);
  });

  it('與 refresh 類紀錄共用一張表但不衝突——前綴把命名空間分開', async () => {
    const shared = uniqueKey('collide');
    await expect(securityClaims.claim(shared)).resolves.toBe(true);
    await expect(store.consume(shared, now() + 60)).resolves.toBe(true);
  });

  it('並行送出同一張 Assertion，只有一個成功（原子性，規格 §8.5）', async () => {
    const key = `tenantA:kid1:${uniqueKey('jti')}`;
    const results = await Promise.all(
      Array.from({ length: 8 }, () => store.consume(key, now() + 60)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
