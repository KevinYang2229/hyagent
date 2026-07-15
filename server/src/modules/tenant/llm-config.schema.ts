import { z } from 'zod';

/** PUT llm-config：省略欄位＝不變、null＝清除該欄（三態 patch 語意） */
export const putLlmConfigSchema = z
  .object({
    provider: z.enum(['anthropic', 'openai']).nullable().optional(),
    model: z.string().trim().min(1).max(100).nullable().optional(),
    anthropicApiKey: z.string().trim().min(20).max(300).nullable().optional(),
    openaiApiKey: z.string().trim().min(20).max(300).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '至少需提供一個欄位' });

export type PutLLMConfigInput = z.infer<typeof putLlmConfigSchema>;
