import { Router } from 'express';
import { singleAudioUpload } from '@/middlewares/upload';
import { asyncHandler } from '@/utils/async-handler';
import { requireSpeechScope, speechController } from './speech.controller';

export const speechRouter = Router();

speechRouter.post('/transcribe', requireSpeechScope, singleAudioUpload('audio'), asyncHandler(speechController.transcribe));
