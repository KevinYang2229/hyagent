/**
 * Claude（Anthropic）provider 實作：tool use + prompt caching。
 *
 * system 與 tools 標 cache_control: ephemeral；同一對話多輪命中快取、降成本/延遲。
 * 以本地 LLM* 型別為主，邊界處對 SDK 型別做必要轉換。
 */
import Anthropic from '@anthropic-ai/sdk';
import { env } from '@/config/env';
import { mapProviderError } from './provider-error';
import { pickModel, type ResolvedLLMSettings } from './resolve-settings';
import type {
  LLMContentBlock,
  LLMCreateParams,
  LLMMessage,
  LLMProvider,
  LLMResult,
  LLMToolCall,
} from './types';

// SDK client 以 apiKey 快取：同 key 重用連線，不每請求重建
const clients = new Map<string, Anthropic>();
function getClient(apiKey: string): Anthropic {
  let c = clients.get(apiKey);
  if (!c) {
    c = new Anthropic({ apiKey });
    clients.set(apiKey, c);
  }
  return c;
}

function toContentParam(block: LLMContentBlock): unknown {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.toolUseId,
        content: block.content,
        is_error: block.isError,
      };
    case 'image':
      return { type: 'image', source: { type: 'base64', media_type: block.mediaType, data: block.data } };
  }
}

function toMessageParams(messages: LLMMessage[]): Anthropic.MessageParam[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content.map(toContentParam),
  })) as Anthropic.MessageParam[];
}

const STOP_MAP: Record<string, LLMResult['stopReason']> = {
  end_turn: 'end_turn',
  tool_use: 'tool_use',
  max_tokens: 'max_tokens',
};

export function createAnthropicProvider(settings: ResolvedLLMSettings): LLMProvider {
  return {
    name: 'anthropic',

    async createMessage(params: LLMCreateParams): Promise<LLMResult> {
      const toolList = params.tools ?? [];
      const tools = toolList.map((t, i) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
        // 在最後一個工具標 cache breakpoint，快取整個 tools 區塊
        ...(params.cache && i === toolList.length - 1
          ? { cache_control: { type: 'ephemeral' } }
          : {}),
      })) as unknown as Anthropic.Tool[];

      const system = (
        params.cache
          ? [{ type: 'text', text: params.system, cache_control: { type: 'ephemeral' } }]
          : params.system
      ) as unknown as Anthropic.MessageCreateParams['system'];

      const model = pickModel(settings, params.model);
      let resp: Anthropic.Message;
      try {
        resp = await getClient(settings.apiKey).messages.create({
          model,
          max_tokens: params.maxTokens ?? env.LLM_MAX_TOKENS,
          system,
          // 未指定就整個欄位不帶，沿用 provider 預設（見 LLMCreateParams.temperature）
          ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
          tools: tools.length > 0 ? tools : undefined,
          ...(params.toolChoice === 'none'
            ? // API 已支援 type:'none'，但 SDK 0.32 型別尚未收錄；SDK 原樣轉送 body，執行期無礙
              { tool_choice: { type: 'none' } as unknown as Anthropic.Messages.ToolChoice }
            : params.toolChoice
              ? { tool_choice: { type: 'tool' as const, name: params.toolChoice.name } }
              : {}),
          messages: toMessageParams(params.messages),
        });
      } catch (err) {
        throw mapProviderError(err, settings);
      }

      let text = '';
      const toolCalls: LLMToolCall[] = [];
      for (const block of resp.content) {
        if (block.type === 'text') {
          text += block.text;
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            name: block.name,
            input: (block.input ?? {}) as Record<string, unknown>,
          });
        }
      }

      const usage = resp.usage as { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null };

      return {
        text,
        toolCalls,
        stopReason: STOP_MAP[resp.stop_reason ?? ''] ?? 'other',
        model,
        keySource: settings.keySource,
        usage: {
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          cacheReadTokens: usage.cache_read_input_tokens ?? undefined,
        },
      };
    },
  };
}
