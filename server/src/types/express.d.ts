import type { JwtPayload } from '@/utils/jwt';
import type { ApiKeyType, Tenant } from '@/modules/tenant/tenant.types';

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
      /** 由 resolveTenant middleware 注入：本次請求所屬租戶（未帶 key 為預設租戶） */
      tenant?: Tenant;
      /** 帶入的 API Key 種類；未帶 key 時 undefined */
      apiKeyType?: ApiKeyType;
      /** 以 HyAgent Session（不透明 token）通過驗證時的原始 token，供登出使用 */
      authSessionToken?: string;
    }
  }
}

export {};
