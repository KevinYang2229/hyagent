import { z } from 'zod';

export const loginSchema = z.object({
  username: z.string().trim().min(1).describe('使用者帳號'),
  password: z.string().min(1).describe('使用者密碼'),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1).describe('登入時取得的 refreshToken；換發後舊的即失效，請改存新的'),
});

/**
 * 換發端點的 body。欄位名用規格 §5.3 的 `assertion`，不再是 `userToken`。
 *
 * 長度上限不在這裡擋：規格 §8.0 要求大小檢查是**步驟 0**、且回 ASSERTION_TOO_LARGE(413)，
 * 由驗證器負責，zod 先擋會變成 400 而錯開規格的錯誤碼。
 */
export const ssoExchangeSchema = z.object({
  assertion: z.string().min(1).describe('宿主網站簽發的 Identity Assertion（JWT）；租戶由其 iss 決定'),
  /**
   * 嵌入本面板的頁面 origin，由面板自 `document.referrer` 取得（規格 §8.6）。
   *
   * 只有「請求來自 HyAgent 自己的面板」時才會被採信——見 assertion-exchange 的
   * resolveEmbedOrigin()。第三方直接呼叫時這個欄位會被忽略，改用瀏覽器設的 Origin header。
   */
  embedOrigin: z.string().trim().min(1).nullish().describe('嵌入面板的頁面 origin；僅 HyAgent 自家面板送來時採信，第三方直接呼叫會被忽略'),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;
export type SsoExchangeInput = z.infer<typeof ssoExchangeSchema>;
