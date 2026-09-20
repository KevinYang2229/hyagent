/**
 * 本次請求的 SSO 身分（Assertion 帶進來的 `name` 與 `hyagent:profile`）。
 *
 * 為什麼要一個 request-scoped 的容器：`getApplicant(userId, tenantId)` 是整個後端取用
 * 使用者資料的單一入口（對話、假單、技能、知識庫 ACL 都經它），簽章只有 id 與租戶。
 * 租戶若沒在 HyAgent 建人員目錄，那兩個參數湊不出姓名與部門——資料在 Session 裡，
 * 而 Session 是 async 取得的，getApplicant 是同步的。要嘛把身分一路往下傳過六個模組，
 * 要嘛在請求進入點放一份、讓 getApplicant 就地取用。這裡選後者。
 *
 * 只在 requireAuth 通過後、且憑證是 HyAgent Session 時建立；作用域止於該請求的
 * continuation。背景工作（報告產製等）跑在請求之外，讀不到這份身分，會自然落回
 * 人員目錄——那是正確的行為，不是遺漏。
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface SsoIdentity {
  tenantId: string;
  /** Assertion 的 sub */
  sub: string;
  /** Assertion 的 name claim */
  name?: string;
  /** Assertion 的 `hyagent:profile`，原樣帶過（規格 §4.2.3） */
  profile?: Record<string, unknown>;
}

const storage = new AsyncLocalStorage<SsoIdentity>();

/** 在 `identity` 的作用域內執行 `fn`（requireAuth 用它包住 next()）。 */
export function runWithSsoIdentity<T>(identity: SsoIdentity, fn: () => T): T {
  return storage.run(identity, fn);
}

/**
 * 取本次請求的 SSO 身分——**限本人**。
 *
 * 租戶與 sub 都要對得上才回傳：getApplicant 也會被用來查「別人」（代理人候選、
 * 通知收件者），拿登入者的部門去回答那些查詢會是張冠李戴。
 */
export function currentSsoIdentity(userId: string, tenantId: string): SsoIdentity | undefined {
  const identity = storage.getStore();
  return identity && identity.sub === userId && identity.tenantId === tenantId ? identity : undefined;
}
