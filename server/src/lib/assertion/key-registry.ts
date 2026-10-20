/**
 * Tenant 公鑰登錄表。
 *
 * 對應規格：§2.5 金鑰輪替（每租戶最多 2 把 active）、§2.6 撤銷、§7.3 公鑰管理。
 * 移植自參考實作 `HyAgentSDK(js)/src/hyagent-verifier.mjs` 的 KeyRegistry。
 *
 * 這裡定義的是**介面**加一個記憶體實作。正式環境的實作要接租戶 store，且依規格
 * §2.6 第 1、2 條：公鑰與撤銷狀態的查詢不得使用 TTL > 30 秒的快取、必須讀 primary。
 * 因此正式實作**不得**沿用 tenantStore 那種「記憶體 Map 為讀取路徑」的 write-through
 * 模式——多副本部署下他副本的撤銷永遠傳不過來（評估文件 §6.4）。
 *
 * 查詢鍵必須是 (tenant, kid) 這個組合，公鑰才不會跨 Tenant 被誤用（規格 §10.6）。
 */
import type { KeyObject } from 'node:crypto';
import { ERROR_CODES, fail } from './errors';
import { ALGORITHMS, isAssertionAlgorithm, toPublicKey, type AssertionAlgorithm } from './jose';
import { computeKid, detectAlgorithm } from './keygen';

/** 規格 §7.3 的公鑰狀態機：只有 active → revoked，撤銷不可逆（輪替汰換也走撤銷）。 */
export type PublicKeyStatus = 'active' | 'revoked';

export interface RegisteredKey {
  tenant: string;
  kid: string;
  alg: AssertionAlgorithm;
  publicKey: KeyObject;
  status: PublicKeyStatus;
}

/**
 * 驗證器唯一需要的能力：以 (tenant, kid) 取得一把可用的公鑰。
 *
 * 查無回 UNKNOWN_KID、非 active 回 KEY_REVOKED——兩者都是 401，
 * 差別只在整合期的診斷價值（規格 §9 定稿保留細分代碼）。
 */
export interface AssertionKeyRegistry {
  lookup(tenant: string, kid: string): RegisteredKey;
}

export interface RegisterKeyInput {
  tenant: string;
  publicKey: KeyObject | string | Buffer;
  /** 省略時由公鑰型別推得（規格 §2.4） */
  alg?: AssertionAlgorithm;
  /** 省略時由公鑰計算 RFC 7638 Thumbprint */
  kid?: string;
  status?: PublicKeyStatus;
}

/**
 * 記憶體版登錄表。
 *
 * 用於測試與單一行程的開發環境。正式環境請改用接租戶 store 的實作，見檔頭說明。
 */
export class InMemoryKeyRegistry implements AssertionKeyRegistry {
  private readonly keys = new Map<string, RegisteredKey>();

  private static entryKey(tenant: string, kid: string): string {
    return `${tenant}:${kid}`;
  }

  /** 註冊一把公鑰。alg 與 kid 省略時由公鑰自動推得。 */
  register({ tenant, publicKey, alg, kid, status = 'active' }: RegisterKeyInput): RegisteredKey {
    const key = toPublicKey(publicKey);
    const algorithm = alg ?? detectAlgorithm(key);

    if (!isAssertionAlgorithm(algorithm)) {
      throw new TypeError(`不支援的 alg：${String(algorithm)}`);
    }
    if (key.asymmetricKeyType !== ALGORITHMS[algorithm].keyType) {
      throw new TypeError(`public key 型別與 ${algorithm} 不符`);
    }

    const entry: RegisteredKey = Object.freeze({
      tenant,
      kid: kid ?? computeKid(key),
      alg: algorithm,
      publicKey: key,
      status,
    });
    this.keys.set(InMemoryKeyRegistry.entryKey(tenant, entry.kid), entry);
    return entry;
  }

  /** 撤銷公鑰（規格 §2.5 輪替流程第 5 步、§2.6）。撤銷後以該 kid 簽發的 Assertion 一律被拒。 */
  revoke(tenant: string, kid: string): void {
    const entryKey = InMemoryKeyRegistry.entryKey(tenant, kid);
    const entry = this.keys.get(entryKey);
    if (!entry) throw new Error(`查無公鑰：${tenant}/${kid}`);
    this.keys.set(entryKey, Object.freeze({ ...entry, status: 'revoked' }));
  }

  /** 列出某 Tenant 的所有公鑰與狀態（規格 §7.3）。 */
  list(tenant: string): RegisteredKey[] {
    return [...this.keys.values()].filter((entry) => entry.tenant === tenant);
  }

  /** 規格 §8.2 步驟 6–7：查表。 */
  lookup(tenant: string, kid: string): RegisteredKey {
    const entry = this.keys.get(InMemoryKeyRegistry.entryKey(tenant, kid));
    if (!entry) {
      fail(ERROR_CODES.UNKNOWN_KID, '查無此 Tenant 對應的 kid');
    }
    if (entry.status !== 'active') {
      fail(ERROR_CODES.KEY_REVOKED, `公鑰狀態為 ${entry.status}，已不可使用`);
    }
    return entry;
  }
}
