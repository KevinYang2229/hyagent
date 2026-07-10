/** Email 連接器工廠：依 env.EMAIL_CONNECTOR 選擇實作（預設 stub）。 */
import { env } from '@/config/env';
import { smtpEmailConnector } from './smtp.connector';
import { stubEmailConnector } from './stub.connector';
import type { EmailConnector } from './types';

export function getEmailConnector(): EmailConnector {
  switch (env.EMAIL_CONNECTOR) {
    case 'stub':
      return stubEmailConnector;
    case 'smtp':
      return smtpEmailConnector;
    default:
      throw new Error(`Unsupported email connector: ${env.EMAIL_CONNECTOR as string}`);
  }
}

export * from './types';
