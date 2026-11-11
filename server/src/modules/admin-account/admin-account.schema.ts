import { z } from 'zod';
import type { AdminTabPermissions } from '@hyagent/shared';
import { ADMIN_TAB_KEYS } from './admin-route-policy';

const level = z.enum(['hidden', 'read', 'write']);

/** key 只能是可設定權限的分頁（不含 database），不認得的 key 一律 422 */
export const permissionsSchema = z
  .object(Object.fromEntries(ADMIN_TAB_KEYS.map((k) => [k, level.optional()])))
  .strict()
  .describe('各後台分頁的權限，key 為分頁代碼；hidden 看不到、read 唯讀、write 可編輯。沒帶的分頁維持原設定')
  .transform((p) => p as AdminTabPermissions);

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9._-]{2,31}$/, '帳號名稱須為 3 到 32 個小寫英數字、點、底線或連字號，且以英數字開頭')
  .refine((u) => u !== 'admin', 'admin 為保留帳號')
  .describe('登入帳號，3–32 個小寫英數字、點、底線或連字號；全平台不可重複，admin 為保留字');

export const displayNameSchema = z.string().trim().min(1).max(50).describe('後台顯示的名稱，最多 50 字');
export const passwordSchema = z.string().min(10).max(128).describe('密碼，10–128 字元');

export const createAccountSchema = z
  .object({ username: usernameSchema, displayName: displayNameSchema, password: passwordSchema })
  .strict();

export const patchAccountSchema = z
  .object({
    displayName: displayNameSchema.optional(),
    status: z.enum(['active', 'disabled']).optional().describe('active 啟用、disabled 停用；停用後該帳號已登入的 token 立即失效'),
    permissions: permissionsSchema.optional(),
  })
  .strict();

export const resetPasswordSchema = z.object({ password: passwordSchema }).strict();
