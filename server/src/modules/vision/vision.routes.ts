import { Router } from 'express';
import { singleImageUpload } from '@/middlewares/upload';
import { validate } from '@/middlewares/validate';
import { asyncHandler } from '@/utils/async-handler';
import { analyzeBodySchema, visionController } from './vision.controller';

export const visionRouter = Router();

// 先解析 multipart（multer 才會填 req.body.mode），再驗證 mode
visionRouter.post('/analyze', singleImageUpload('image'), validate({ body: analyzeBodySchema }), asyncHandler(visionController.analyze));
