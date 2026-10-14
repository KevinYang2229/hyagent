/** Text egress gate. Never include matched content in errors or logs. */
import { env } from '@/config/env';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { AppError } from '@/utils/app-error';

export interface EgressPolicy {
  /** Exact domains only; no wildcards or implicit subdomains. Empty denies email. */
  allowedEmailDomains?: string[];
  /** Literal confidential text to block at all three egress boundaries. */
  sensitiveTerms?: string[];
}

export function assertSafeEgress(value: unknown, tenantId?: string): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  const tenant = tenantId ? tenantStore.getTenant(tenantId) : undefined;
  const secrets = [
    env.ANTHROPIC_API_KEY, env.OPENAI_API_KEY, env.LLM_API_KEY,
    env.JWT_ACCESS_SECRET, env.JWT_REFRESH_SECRET, env.ADMIN_API_KEY,
    env.SMTP_PASS, env.S3_SECRET_KEY, env.OA_API_KEY, env.DATA_ENCRYPTION_KEY,
    tenant?.llmConfig?.anthropicApiKey, tenant?.llmConfig?.openaiApiKey,
    ...(tenant?.egressPolicy?.sensitiveTerms ?? []),
  ].filter((s): s is string => typeof s === 'string' && s.length >= 4);
  const forbidden = /-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----|\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;
  if (forbidden.test(text) || secrets.some((s) => text.includes(s) || text.includes(JSON.stringify(s).slice(1, -1)))) {
    throw new AppError(403, 'EGRESS_BLOCKED', '內容包含受保護的敏感資訊，已阻止傳送。');
  }
}

export function assertEmailEgress(input: { to: string; subject: string; html: string }, tenantId: string): void {
  assertSafeEgress(input, tenantId);
  // A single plain mailbox prevents nodemailer address lists/display names from bypassing domain checks.
  const match = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)$/.exec(input.to);
  if (!match) throw new AppError(422, 'EMAIL_RECIPIENT_INVALID', '請提供單一有效的收件人 Email。');
  const domains = tenantStore.getTenant(tenantId)?.egressPolicy?.allowedEmailDomains;
  if ((domains !== undefined || env.NODE_ENV === 'production') &&
      !(domains ?? []).some((d) => d.toLowerCase() === match[1].toLowerCase())) {
    throw new AppError(403, 'EMAIL_DOMAIN_BLOCKED', '收件人網域未獲准，已阻止寄送。');
  }
}
