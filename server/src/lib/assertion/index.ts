/**
 * HyAgent Identity Assertion 驗證（規格 §8 步驟 0–21）。
 *
 * 換發端點只需要這一個進入點：
 *
 *   const claims = await verifier.verifyAndConsume(assertion, { tenant });
 *
 * 錯誤一律是 HyAgentTokenError，帶規格 §9 的代碼與 HTTP 狀態，
 * 由最外層以 toErrorResponse() 轉成 §7.5 的回應格式。
 */
export {
  ERROR_CODES,
  HTTP_STATUS,
  HyAgentTokenError,
  fail,
  toErrorResponse,
  type AssertionErrorCode,
  type AssertionErrorResponse,
} from './errors';

export {
  ALGORITHMS,
  FORBIDDEN_HEADER_PARAMS,
  isAssertionAlgorithm,
  toPublicKey,
  type AssertionAlgorithm,
} from './jose';

export {
  MIN_RSA_MODULUS_BITS,
  SUPPORTED_ALGORITHMS,
  computeKid,
  detectAlgorithm,
  exportPublicJwk,
  generateHyAgentKeyPair,
  type GeneratedKeyPair,
} from './keygen';

export {
  InMemoryKeyRegistry,
  type AssertionKeyRegistry,
  type PublicKeyStatus,
  type RegisterKeyInput,
  type RegisteredKey,
} from './key-registry';

export { MemoryReplayStore, type ReplayStore } from './replay-store';

export { ClaimReplayStore, claimReplayStore } from './claim-replay-store';

export {
  DEFAULT_AUDIENCE,
  DEFAULT_CLOCK_SKEW_SECONDS,
  HyAgentAssertionVerifier,
  MAX_ASSERTION_BYTES,
  MAX_CLOCK_SKEW_SECONDS,
  MAX_LIFETIME_SECONDS,
  isOriginAllowed,
  peekIssuer,
  type AssertionClaims,
  type VerifierOptions,
  type VerifyOptions,
} from './verifier';
