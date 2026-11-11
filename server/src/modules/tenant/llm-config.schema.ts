import { z } from 'zod';

/** PUT llm-config：省略欄位＝不變、null＝清除該欄（三態 patch 語意） */
export const putLlmConfigSchema = z
  .object({
    provider: z.enum(['anthropic', 'openai', 'local']).nullable().optional().describe('LLM 供應商；省略＝不變、null＝改回平台預設'),
    model: z.string().trim().min(1).max(100).nullable().optional().describe('模型名稱；省略＝不變、null＝改回平台預設'),
    anthropicApiKey: z.string().trim().min(20).max(300).nullable().optional().describe('租戶自有的 Anthropic API Key；省略＝不變、null＝清除'),
    openaiApiKey: z.string().trim().min(20).max(300).nullable().optional().describe('租戶自有的 OpenAI API Key；省略＝不變、null＝清除'),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '至少需提供一個欄位' });

export type PutLLMConfigInput = z.infer<typeof putLlmConfigSchema>;
