/**
 * 金鑰安全原語：API key 雜湊 + 敏感欄位靜態加密。
 *
 * - hashApiKey：sha256。pk_/sk_ 為高熵隨機字串，不需慢雜湊；store 只存雜湊，
 *   原始金鑰僅在簽發當下回傳一次。
 * - encryptSecret / decryptSecret：AES-256-GCM，金鑰來自 env.DATA_ENCRYPTION_KEY（64 hex）。
 *   未設定時寫入原樣（dev 便利）；解密對非 enc: 前綴的值直接放行（舊明文資料向後相容），
 *   讀到 enc: 資料卻沒金鑰則丟錯（boot fail-fast，避免帶著讀不回的設定上線）。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from '@/config/env';

export function hashApiKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

const ENC_PREFIX = 'enc:v1:';
const IV_LEN = 12;
const TAG_LEN = 16;

function encryptionKey(): Buffer | undefined {
  return env.DATA_ENCRYPTION_KEY ? Buffer.from(env.DATA_ENCRYPTION_KEY, 'hex') : undefined;
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(ENC_PREFIX);
}

export function encryptSecret(plain: string): string {
  const key = encryptionKey();
  if (!key) return plain;
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ENC_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

export function decryptSecret(value: string): string {
  if (!isEncrypted(value)) return value; // 舊資料明文，向後相容
  const key = encryptionKey();
  if (!key) {
    throw new Error('讀到已加密的敏感欄位但未設 DATA_ENCRYPTION_KEY，無法解密（請補上加密當時的金鑰）');
  }
  const buf = Buffer.from(value.slice(ENC_PREFIX.length), 'base64');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
