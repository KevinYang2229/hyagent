/**
 * 附件上傳 middleware（multer，記憶體儲存）。
 *
 * 檔案內容先進記憶體 buffer，由 attachment.store 接手保管；不落地暫存檔。
 * 單檔上限與允許型別在此把關，超限／型別不符轉成 AppError 走統一錯誤回應。
 */
import multer, { MulterError } from 'multer';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError } from '@/utils/app-error';

/** 單檔上限（MB）；與前端提示文字一致 */
export const MAX_FILE_SIZE_MB = 10;

/** 允許的 MIME（pdf / 影像 / Office 文件）；'application/octet-stream' 放行讓副檔名判斷由前端負責 */
const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_MB * 1024 * 1024, files: 1 },
  fileFilter(_req, file, cb) {
    if (ALLOWED_MIME.has(file.mimetype)) cb(null, true);
    else cb(AppError.unprocessable(`不支援的檔案類型：${file.mimetype}`));
  },
});

/** 單檔上傳（欄位名 file），把 MulterError 轉成 422 AppError */
export function singleFileUpload(field = 'file'): RequestHandler {
  const handler = upload.single(field);
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res, (err: unknown) => {
      if (err instanceof MulterError) {
        const message =
          err.code === 'LIMIT_FILE_SIZE'
            ? `檔案超過上限 ${MAX_FILE_SIZE_MB}MB`
            : `上傳失敗：${err.message}`;
        next(AppError.unprocessable(message));
        return;
      }
      next(err);
    });
  };
}

/** 影像辨識專用：只收 jpeg／png／webp，單檔 5MB（app 上傳前已縮圖） */
export const MAX_IMAGE_SIZE_MB = 5;
const IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_SIZE_MB * 1024 * 1024, files: 1 },
  fileFilter(_req, file, cb) {
    if (IMAGE_MIME.has(file.mimetype)) cb(null, true);
    else cb(AppError.unprocessable(`只接受 JPEG、PNG、WebP 圖片：${file.mimetype}`));
  },
});

export function singleImageUpload(field = 'image'): RequestHandler {
  const handler = imageUpload.single(field);
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res, (err: unknown) => {
      if (err instanceof MulterError) {
        next(AppError.unprocessable(err.code === 'LIMIT_FILE_SIZE' ? `圖片超過上限 ${MAX_IMAGE_SIZE_MB}MB` : `上傳失敗：${err.message}`));
        return;
      }
      next(err);
    });
  };
}
