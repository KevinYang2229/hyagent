/**
 * OpenAI provider 實作：Chat Completions + function calling。
 *
 * 將本地 vendor-neutral 的 LLM* 型別（text / tool_use / tool_result 區塊）
 * 轉成 OpenAI 的 messages（system / user / assistant.tool_calls / tool）格式。
 * OpenAI 會自動做 prompt caching，故 params.cache 不需特別處理。
 */
import OpenAI from 'openai';
import type {
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import { env } from '@/config/env';
import { mapProviderError } from './provider-error';
import { pickModel, type ResolvedLLMSettings } from './resolve-settings';
import type {
  LLMCreateParams,
  LLMMessage,
  LLMProvider,
  LLMResult,
  LLMToolCall,
} from './types';

// SDK client 以 apiKey|baseURL 快取：同 key+端點重用連線，不每請求重建
const clients = new Map<string, OpenAI>();
function getClient(apiKey: string, baseURL?: string): OpenAI {
  const cacheKey = `${apiKey}|${baseURL ?? ''}`;
  let c = clients.get(cacheKey);
  if (!c) {
    c = new OpenAI({ apiKey, baseURL });
    clients.set(cacheKey, c);
  }
  return c;
}

/** 寬鬆解析工具參數（OpenAI 以 JSON 字串回傳 arguments） */
function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 將本地訊息結構攤平成 OpenAI messages（tool_result → role:'tool'） */
function toOpenAIMessages(system: string, messages: LLMMessage[]): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [{ role: 'system', content: system }];

  for (const m of messages) {
    if (m.role === 'assistant') {
      let text = '';
      const toolCalls: NonNullable<
        Extract<ChatCompletionMessageParam, { role: 'assistant' }>['tool_calls']
      > = [];
      for (const b of m.content) {
        if (b.type === 'text') text += b.text;
        else if (b.type === 'tool_use') {
          toolCalls.push({
            id: b.id,
            type: 'function',
            function: { name: b.name, arguments: JSON.stringify(b.input) },
          });
        }
      }
      out.push({
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    } else {
      // user 訊息可能含 text（真使用者輸入）、image 與／或 tool_result（工具輸出）
      const parts: ChatCompletionContentPart[] = [];
      let hasImage = false;
      for (const b of m.content) {
        if (b.type === 'tool_result') {
          out.push({ role: 'tool', tool_call_id: b.toolUseId, content: b.content });
        } else if (b.type === 'text') {
          parts.push({ type: 'text', text: b.text });
        } else if (b.type === 'image') {
          hasImage = true;
          parts.push({ type: 'image_url', image_url: { url: `data:${b.mediaType};base64,${b.data}` } });
        }
      }
      if (parts.length === 0) continue;
      // 沒有圖片時維持字串內容（與既有行為相同，相容只吃字串的本地模型）
      out.push(
        hasImage
          ? { role: 'user', content: parts }
          : { role: 'user', content: parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n') },
      );
    }
  }

  return out;
}

const STOP_MAP: Record<string, LLMResult['stopReason']> = {
  stop: 'end_turn',
  tool_calls: 'tool_use',
  length: 'max_tokens',
};

/**
 * 已知「Chat Completions 上 reasoning 與 function tools 不能並用」的模型（如 gpt-6-luna）。
 * 這類模型預設開 reasoning，帶工具就 400；但非 reasoning 模型（gpt-4o-mini 等）反而拒收
 * reasoning_effort 欄位，故不能一律帶——改成首次撞錯後記住該模型，之後帶工具時直接送 'none'。
 */
const toolsNeedReasoningOff = new Set<string>();

/**
 * 已知「只接受預設 temperature」的模型（reasoning 模型，如 gpt-6-luna）。呼叫端指定
 * temperature（如推薦詞生成的 0.4）會被 400 拒收；一般模型則需要這個值，故同樣撞錯後才記住、改不帶。
 */
const temperatureUnsupported = new Set<string>();

function errMessage(err: unknown): string | undefined {
  const e = err as { status?: number; message?: string } | null;
  return e?.status === 400 ? (e.message ?? '') : undefined;
}

function isToolsWithReasoningError(err: unknown): boolean {
  const msg = errMessage(err);
  return msg !== undefined && /reasoning_effort/i.test(msg) && /tool/i.test(msg);
}

function isTemperatureError(err: unknown): boolean {
  const msg = errMessage(err);
  return msg !== undefined && /temperature/i.test(msg);
}

export function createOpenAIProvider(settings: ResolvedLLMSettings): LLMProvider {
  return {
    name: 'openai',

    async createMessage(params: LLMCreateParams): Promise<LLMResult> {
      const tools: ChatCompletionTool[] = (params.tools ?? []).map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      }));

      const model = pickModel(settings, params.model);
      const maxTokens = params.maxTokens ?? env.LLM_MAX_TOKENS;
      const hasTools = tools.length > 0;
      const hasTemperature = params.temperature !== undefined;
      const send = (reasoningOff: boolean, dropTemperature: boolean) =>
        getClient(settings.apiKey, settings.baseURL).chat.completions.create({
          model,
          ...(reasoningOff ? { reasoning_effort: 'none' as const } : {}),
          // OpenAI 官方已棄用 max_tokens，reasoning／新世代模型直接 400 拒收，須改送
          // max_completion_tokens；地端 OpenAI 相容伺服器（Ollama、舊版 vLLM 等）未必認得新欄位，
          // 仍送 max_tokens 以免上限被靜默忽略。
          ...(settings.provider === 'local'
            ? { max_tokens: maxTokens }
            : { max_completion_tokens: maxTokens }),
          // 未指定就整個欄位不帶，沿用 provider 預設（見 LLMCreateParams.temperature）。
          // 本 provider 也服務 OpenAI 相容的本地模型與 reasoning 模型，後者會拒絕
          // 非預設的 temperature——不帶欄位是唯一對所有後端都安全的預設。
          ...(hasTemperature && !dropTemperature ? { temperature: params.temperature } : {}),
          messages: toOpenAIMessages(params.system, params.messages),
          tools: tools.length > 0 ? tools : undefined,
          ...(params.toolChoice === 'none'
            ? { tool_choice: 'none' as const }
            : params.toolChoice
              ? { tool_choice: { type: 'function' as const, function: { name: params.toolChoice.name } } }
              : {}),
        }, { signal: params.signal });

      let resp: OpenAI.Chat.Completions.ChatCompletion;
      try {
        let reasoningOff = hasTools && toolsNeedReasoningOff.has(model);
        let dropTemperature = hasTemperature && temperatureUnsupported.has(model);
        // 兩種不相容各自最多觸發一次調整，故最多 3 次請求
        for (;;) {
          try {
            resp = await send(reasoningOff, dropTemperature);
            break;
          } catch (err) {
            if (hasTools && !reasoningOff && isToolsWithReasoningError(err)) {
              toolsNeedReasoningOff.add(model);
              reasoningOff = true;
            } else if (hasTemperature && !dropTemperature && isTemperatureError(err)) {
              temperatureUnsupported.add(model);
              dropTemperature = true;
            } else {
              throw err;
            }
          }
        }
      } catch (err) {
        throw mapProviderError(err, settings);
      }

      const choice = resp.choices[0];
      const message = choice?.message;
      const text = message?.content ?? '';

      const toolCalls: LLMToolCall[] = (message?.tool_calls ?? [])
        .filter((tc) => tc.type === 'function')
        .map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          input: parseArgs(tc.function.arguments),
        }));

      // OpenAI 的 prompt_tokens 已含 cached_tokens；拆成「未命中快取的輸入」與「cache 讀取」，
      // 與 Anthropic（input_tokens 不含 cache）同語意，用量加總與成本才不會把 cache 算兩次
      const cached = resp.usage?.prompt_tokens_details?.cached_tokens ?? undefined;
      return {
        text,
        toolCalls,
        stopReason: STOP_MAP[choice?.finish_reason ?? ''] ?? 'other',
        model,
        keySource: settings.keySource,
        usage: {
          inputTokens: Math.max(0, (resp.usage?.prompt_tokens ?? 0) - (cached ?? 0)),
          outputTokens: resp.usage?.completion_tokens ?? 0,
          cacheReadTokens: cached,
        },
      };
    },
  };
}
