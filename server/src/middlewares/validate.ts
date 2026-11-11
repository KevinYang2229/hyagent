import type { RequestHandler } from 'express';
import { ZodError, type ZodSchema } from 'zod';

export interface ValidateSchemas {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
}

export const validationSchemas = new WeakMap<RequestHandler, ValidateSchemas>();

/**
 * 用 Zod schema 驗證 req.body / req.query / req.params。
 *
 * 驗證後將 parsed 結果寫回 req（已強制型別、套用 default、coerce），
 * 後續 controller 只要用 (req.body as z.infer<typeof schema>) 即可。
 */
export const validate = (schemas: ValidateSchemas): RequestHandler => {
  const handler: RequestHandler = (req, _res, next) => {
    try {
      if (schemas.body) req.body = schemas.body.parse(req.body);
      if (schemas.query) req.query = schemas.query.parse(req.query);
      if (schemas.params) req.params = schemas.params.parse(req.params);
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        next(err);
        return;
      }
      next(err);
    }
  };

  validationSchemas.set(handler, schemas);
  return handler;
};
