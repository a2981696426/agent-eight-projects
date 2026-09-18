import type { ZodType } from 'zod';
import type { LlmUsage } from '@eight/shared';

/**
 * 兼容 OpenAI Chat Completions 协议的最小客户端（DeepSeek 等）。
 * 不引入 SDK：直接 fetch，便于透传 thinking / reasoning_effort 等厂商扩展参数。
 */
export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  modelFast: string;
  modelReasoning: string;
  timeoutMs?: number;
}

export type ChatMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_call_id?: string; name?: string };

export interface ChatOptions {
  mode?: 'fast' | 'reasoning';
  reasoningEffort?: 'low' | 'medium' | 'high';
  maxTokens?: number;
  temperature?: number;
  json?: boolean;
  tools?: unknown[];
}

export interface ChatResult {
  content: string;
  reasoning: string | null;
  toolCalls: { id: string; name: string; arguments: string }[];
  usage: LlmUsage;
  raw: unknown;
}

export class LlmError extends Error {
  constructor(message: string, public readonly code: string, public readonly status?: number) {
    super(message);
  }
}

export class LlmClient {
  constructor(private readonly cfg: LlmConfig) {}

  get configured() {
    return Boolean(this.cfg.apiKey && this.cfg.baseUrl);
  }

  modelFor(mode: 'fast' | 'reasoning') {
    return mode === 'reasoning' ? this.cfg.modelReasoning : this.cfg.modelFast;
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    if (!this.configured) throw new LlmError('LLM 未配置：缺少 LLM_API_KEY 或 LLM_BASE_URL', 'LLM_NOT_CONFIGURED');
    const mode = opts.mode ?? 'fast';
    const model = this.modelFor(mode);
    const thinking = mode === 'reasoning';
    const body: Record<string, unknown> = {
      model,
      messages,
      temperature: opts.temperature ?? (thinking ? 0.3 : 0),
      max_tokens: opts.maxTokens ?? (thinking ? 2400 : 900),
      // DeepSeek 扩展：思考模式。分类/抽取关闭以换取 1s 级时延，根因推理开启并限制强度。
      thinking: { type: thinking ? 'enabled' : 'disabled' },
      ...(thinking ? { reasoning_effort: opts.reasoningEffort ?? 'low' } : {}),
      ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
      ...(opts.tools?.length ? { tools: opts.tools } : {}),
    };
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs ?? 60_000);
    let res: Response;
    try {
      res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      const aborted = (e as Error).name === 'AbortError';
      throw new LlmError(aborted ? '模型调用超时' : `模型服务不可达：${(e as Error).message}`, aborted ? 'LLM_TIMEOUT' : 'LLM_UNREACHABLE');
    }
    clearTimeout(timer);
    const text = await res.text();
    if (!res.ok) {
      const code = res.status === 401 ? 'LLM_UNAUTHORIZED' : res.status === 429 ? 'LLM_RATE_LIMIT' : 'LLM_HTTP_ERROR';
      throw new LlmError(`模型调用失败 HTTP ${res.status}: ${text.slice(0, 300)}`, code, res.status);
    }
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      throw new LlmError('模型返回不是有效 JSON 响应体', 'LLM_BAD_RESPONSE');
    }
    const choice = data.choices?.[0];
    const msg = choice?.message ?? {};
    const u = data.usage ?? {};
    const usage: LlmUsage = {
      model: data.model ?? model,
      promptTokens: u.prompt_tokens ?? 0,
      completionTokens: u.completion_tokens ?? 0,
      reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? undefined,
      durationMs: Date.now() - started,
      thinking,
    };
    return {
      content: typeof msg.content === 'string' ? msg.content : '',
      reasoning: typeof msg.reasoning_content === 'string' ? msg.reasoning_content : null,
      toolCalls: (msg.tool_calls ?? []).map((t: any) => ({ id: t.id, name: t.function?.name, arguments: t.function?.arguments ?? '{}' })),
      usage,
      raw: data,
    };
  }

  /** 结构化输出：json_object 模式 + zod 校验，失败时把校验错误回灌重试一次。 */
  async chatJson<T>(schema: ZodType<T>, messages: ChatMessage[], opts: ChatOptions = {}): Promise<{ value: T; usage: LlmUsage[]; reasoning: string | null }> {
    const usages: LlmUsage[] = [];
    let attemptMessages = messages;
    let lastError = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.chat(attemptMessages, { ...opts, json: true });
      usages.push(res.usage);
      const parsed = safeParseJson(res.content);
      if (parsed.ok) {
        const v = schema.safeParse(parsed.value);
        if (v.success) return { value: v.data, usage: usages, reasoning: res.reasoning };
        lastError = v.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      } else {
        lastError = parsed.error;
      }
      attemptMessages = [
        ...messages,
        { role: 'assistant', content: res.content || '{}' },
        { role: 'user', content: `上面的输出不符合要求：${lastError}。请只输出修正后的 JSON 对象，不要解释。` },
      ];
    }
    throw new LlmError(`模型结构化输出校验失败：${lastError}`, 'LLM_SCHEMA_INVALID');
  }
}

export function safeParseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return { ok: true, value: JSON.parse(trimmed.slice(start, end + 1)) };
      } catch (e) {
        return { ok: false, error: `JSON 解析失败：${(e as Error).message}` };
      }
    }
    return { ok: false, error: '输出中没有 JSON 对象' };
  }
}

export function sumUsage(list: LlmUsage[]) {
  return list.reduce(
    (acc, u) => ({ promptTokens: acc.promptTokens + u.promptTokens, completionTokens: acc.completionTokens + u.completionTokens, calls: acc.calls + 1 }),
    { promptTokens: 0, completionTokens: 0, calls: 0 },
  );
}
