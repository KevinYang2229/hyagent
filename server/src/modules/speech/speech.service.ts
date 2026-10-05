/**
 * 語音轉文字：呼叫 OpenAI 轉錄，語言固定中文，並以提示詞偏向繁體與門市用語。
 * 錄音只在記憶體中轉送，不落地、不寫日誌。
 */
import OpenAI, { toFile } from 'openai';
import { env } from '@/config/env';
import { logger } from '@/lib/logger';
import { AppError } from '@/utils/app-error';

const EXT: Record<string, string> = {
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/webm': 'webm',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
};

const PROMPT = '以下是台灣便利商店店員的繁體中文語音，內容多為商品、庫存、補貨、活動與優惠券。';

let client: OpenAI | null = null;
let clientKey = '';

function getClient(): OpenAI {
  // key 變更（測試或熱更新）時重建 client
  if (!client || clientKey !== env.OPENAI_API_KEY) {
    client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    clientKey = env.OPENAI_API_KEY;
  }
  return client;
}

export async function transcribe(audio: { data: Buffer; mediaType: string }): Promise<string> {
  if (!env.OPENAI_API_KEY) throw new AppError(503, 'SPEECH_UNAVAILABLE', '語音辨識未啟用，請改用打字');
  const file = await toFile(audio.data, `speech.${EXT[audio.mediaType] ?? 'm4a'}`, { type: audio.mediaType });
  try {
    const res = await getClient().audio.transcriptions.create({ file, model: env.SPEECH_MODEL, language: 'zh', prompt: PROMPT });
    return res.text.trim();
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'speech transcription failed');
    throw new AppError(502, 'SPEECH_FAILED', '語音辨識失敗，請再說一次或改用打字');
  }
}
