/** Central user-token validation, credential revocation and tenant binding. */
import type { NextFunction, Request, Response } from 'express';
import { validateIdentity } from '@/modules/auth/credential-version';
import { verifyAccessToken } from '@/utils/jwt';
import { AppError } from '@/utils/app-error';

export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const [scheme, token] = (req.header('authorization') ?? '').split(' ');
    if (scheme !== 'Bearer' || !token) throw AppError.unauthorized('Missing Authorization header');
    req.user = verifyAccessToken(token);
    await validateIdentity(req.user);
    if (req.tenant && req.user.tenantId !== req.tenant.id) {
      throw AppError.unauthorized('Token tenant mismatch');
    }
  } catch {
    next(AppError.unauthorized('Invalid or expired access token'));
    return;
  }
  next();
}
