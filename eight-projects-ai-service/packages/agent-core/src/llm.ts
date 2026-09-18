import type { ZodType } from 'zod';
import type { LlmUsage } from '@eight/shared';

/**
 * 兼容 OpenAI Chat Completions 协议的最小客户端（DeepSeek 等）+ 多 provider 路由器。
 * 不引入 SDK：直接 fetch，便于透传 thinking / reasoning_effort 等厂商扩展参数。
 *
 * 高可用设计（借鉴 Provider 抽象层 + 熔断器）：
 * - 每个 provider 独立熔断：连续失败 ≥ failureThreshold 打开，cooldownMs 后半开试探一次。
 * - 可重试错误（超时 / 网络 / 429 / 5xx）在同一 provider 上指数退避重试，用尽后切换下一个 provider。
 * - 不可重试错误（401 / 400 / schema 校验失败）：401 直接切换，400 抛出。
 * - 全部不可用时抛 LLM_ALL_PROVIDERS_DOWN，由执行链进入规则降级模式。
 */
export interface LlmConfig {
  id?: string;
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
  /** 是否值得在同一 provider 上重试 */
  get retryable() {
    return ['LLM_TIMEOUT', 'LLM_UNREACHABLE', 'LLM_RATE_LIMIT', 'LLM_SERVER_ERROR'].includes(this.code);
  }
  /** 是否应切换到其他 provider（含可重试错误用尽的情况） */
  get failover() {
    return this.retryable || ['LLM_UNAUTHORIZED', 'LLM_NOT_CONFIGURED', 'LLM_BAD_RESPONSE'].includes(this.code);
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

/** 执行链依赖的最小接口：单 provider 客户端、路由器、Mock 都满足 */
export interface LlmLike {
  readonly configured: boolean;
  chatJson<T>(schema: ZodType<T>, messages: ChatMessage[], opts?: ChatOptions): Promise<{ value: T; usage: LlmUsage[]; reasoning: string | null }>;
}

/** 结构化输出公共实现：json_object 模式 + zod 校验，失败把校验错误回灌重试一次 */
export abstract class LlmBase implements LlmLike {
  abstract get configured(): boolean;
  abstract chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult>;

  async chatJson<T>(schema: ZodType<T>, messages: ChatMessage[], opts: ChatOptions = {}): Promise<{ value: T; usage: LlmUsage[]; reasoning: string | null }> {
    const usages: LlmUsage[] = [];
    // OpenAI 兼容端（含 DeepSeek）要求 json_object 模式下提示词中必须出现 "json" 字样
    if (!messages.some((m) => /json/i.test(m.content))) {
      messages = messages[0]?.role === 'system' ? [{ ...messages[0], content: `${messages[0].content}\n输出必须是合法的 JSON 对象。` }, ...messages.slice(1)] : [{ role: 'system', content: '输出必须是合法的 JSON 对象。' }, ...messages];
    }
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
      attemptMessages = [...messages, { role: 'assistant', content: res.content || '{}' }, { role: 'user', content: `上面的输出不符合要求：${lastError}。请只输出修正后的 JSON 对象，不要解释。` }];
    }
    throw new LlmError(`模型结构化输出校验失败：${lastError}`, 'LLM_SCHEMA_INVALID');
  }
}

/* ───────────────────────── 单 provider 客户端 ───────────────────────── */
export class LlmClient extends LlmBase {
  readonly id: string;
  constructor(private readonly cfg: LlmConfig) {
    super();
    this.id = cfg.id ?? 'primary';
  }
  get configured() {
    return Boolean(this.cfg.apiKey && this.cfg.baseUrl);
  }
  get models() {
    return { fast: this.cfg.modelFast, reasoning: this.cfg.modelReasoning, baseUrl: this.cfg.baseUrl };
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
      max_tokens: opts.maxTokens ?? (thinking ? 2000 : 900),
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
      const code = res.status === 401 || res.status === 403 ? 'LLM_UNAUTHORIZED' : res.status === 429 ? 'LLM_RATE_LIMIT' : res.status >= 500 ? 'LLM_SERVER_ERROR' : 'LLM_HTTP_ERROR';
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
      provider: this.id,
      promptTokens: u.prompt_tokens ?? 0,
      completionTokens: u.completion_tokens ?? 0,
      reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? undefined,
      cachedTokens: u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? undefined,
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
}

/* ───────────────────────── Mock provider（离线/测试） ───────────────────────── */
/** 确定性假模型：按 system 提示词识别阶段，返回结构合法的 JSON。用于 e2e 与无网络环境。 */
export class MockLlmClient extends LlmBase {
  readonly id = 'mock';
  get configured() {
    return true;
  }
  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const sys = messages[0]?.content ?? '';
    const user = messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
    let body: unknown = { ok: true };
    if (sys.includes('意图与场景识别')) {
      const s = /投诉|12315|律师|曝光/.test(user) ? 'complaint' : /发票|抬头|税号|开票/.test(user) ? 'invoice' : /退款|差价|保价|退货/.test(user) ? 'refund_price_diff' : /快递|物流|发货|到哪|签收/.test(user) ? 'logistics' : /防水|洗澡|佩戴|激活|NFC|手机|价格|多少钱|优惠/i.test(user) ? 'presale' : 'general';
      const orderId = user.match(/\b(20\d{8,14})\b/)?.[1];
      body = { scenario: s, intent: `mock-${s}`, confidence: 0.9, entities: orderId ? { orderId } : {}, flags: s === 'complaint' ? ['complaint'] : [], needHuman: /人工/.test(user), reason: 'mock' };
    } else if (sys.includes('检索查询改写')) body = { queries: ['mock 改写查询'] };
    else if (sys.includes('工作规则')) body = { rootCause: 'mock 根因', analysis: 'mock 分析', draft: '这是离线模拟模型生成的候选话术，仅用于验证链路。', citations: [], proposedAction: { type: 'none', params: {}, reason: 'mock' }, needsHuman: false, selfConfidence: 0.8 };
    else if (sys.includes('小记')) body = { problem: 'mock 问题', handling: 'mock 处理', outcome: 'mock 结果', followUp: '', tags: ['mock'] };
    else if (sys.includes('分类器')) body = { level1: '售后', level2: '物流', level3: '', emotion: 'neutral', urgency: 'low', confidence: 0.9 };
    else if (sys.includes('工单')) body = { title: 'mock 工单', type: '其他', priority: 'P2', description: 'mock', fields: {} };
    else if (sys.includes('润色')) body = { variants: [{ style: 'mock', text: 'mock 润色' }] };
    else if (sys.includes('问答对')) body = { faqs: [{ question: 'mock 问', answer: 'mock 答', tags: ['mock'] }] };
    else if (sys.includes('相似问')) body = { questions: ['mock 1', 'mock 2', 'mock 3'] };
    else if (sys.includes('质检员')) body = { summary: 'mock', scores: { empathy: 8, completeness: 8, accuracy: 8, compliance: 9 }, issues: [], tone: '平稳', highlights: [] };
    else if (sys.includes('客户之声分析器')) body = { items: [...user.matchAll(/^(\S+)\t/gm)].map((m) => ({ messageId: m[1], topic: '其他', sentiment: 'neutral', keywords: ['mock'] })) };
    else if (sys.includes('客户之声分析助手')) body = { answer: 'mock 回答', evidence: [], caveats: 'mock' };
    else if (sys.includes('外呼模拟器')) body = { results: [] };
    else if (sys.includes('应答建议')) body = { suggestions: [{ text: 'mock 建议', basis: 'mock' }] };
    return { content: JSON.stringify(body), reasoning: null, toolCalls: [], usage: { model: 'mock', provider: this.id, promptTokens: 0, completionTokens: 0, durationMs: 1, thinking: opts.mode === 'reasoning' }, raw: body };
  }
}

/* ───────────────────────── 多 provider 路由器 ───────────────────────── */
export interface ProviderStatus {
  id: string;
  configured: boolean;
  models: { fast: string; reasoning: string; baseUrl: string } | null;
  circuit: 'closed' | 'open' | 'half_open';
  consecutiveFailures: number;
  openedAt: string | null;
  stats: { calls: number; failures: number; avgMs: number; lastError: string | null; lastSuccessAt: string | null };
  simulatedDown: boolean;
}

export interface RouterOptions {
  failureThreshold?: number;
  cooldownMs?: number;
  maxRetries?: number;
  backoffMs?: number;
}

interface ProviderState {
  client: LlmBase & { id: string; models?: LlmClient['models'] };
  consecutiveFailures: number;
  openedAt: number | null;
  halfOpen: boolean;
  simulatedDown: boolean;
  calls: number;
  failures: number;
  totalMs: number;
  lastError: string | null;
  lastSuccessAt: string | null;
}

export class LlmRouter extends LlmBase {
  private readonly providers: ProviderState[];
  private readonly opts: Required<RouterOptions>;
  /** 最近一次成功调用使用的 provider 与切换次数，供 trace 记录 */
  readonly events: { at: string; type: 'failover' | 'circuit_open' | 'circuit_close' | 'all_down' | 'simulate'; provider: string; detail: string }[] = [];

  constructor(clients: (LlmBase & { id: string })[], opts: RouterOptions = {}) {
    super();
    this.providers = clients.map((client) => ({ client, consecutiveFailures: 0, openedAt: null, halfOpen: false, simulatedDown: false, calls: 0, failures: 0, totalMs: 0, lastError: null, lastSuccessAt: null }));
    this.opts = { failureThreshold: opts.failureThreshold ?? 3, cooldownMs: opts.cooldownMs ?? 30_000, maxRetries: opts.maxRetries ?? 1, backoffMs: opts.backoffMs ?? 400 };
  }

  get configured() {
    return this.providers.some((p) => p.client.configured && !p.simulatedDown);
  }
  get primary() {
    return this.providers[0]?.client;
  }

  private circuitOf(p: ProviderState): ProviderStatus['circuit'] {
    if (p.openedAt == null) return 'closed';
    if (Date.now() - p.openedAt >= this.opts.cooldownMs) return 'half_open';
    return 'open';
  }
  private available(p: ProviderState) {
    return p.client.configured && !p.simulatedDown && this.circuitOf(p) !== 'open';
  }
  private recordFailure(p: ProviderState, err: LlmError) {
    p.failures++;
    p.consecutiveFailures++;
    p.lastError = `${err.code}: ${err.message.slice(0, 160)}`;
    if (p.consecutiveFailures >= this.opts.failureThreshold && p.openedAt == null) {
      p.openedAt = Date.now();
      this.pushEvent('circuit_open', p.client.id, `连续失败 ${p.consecutiveFailures} 次，熔断 ${this.opts.cooldownMs / 1000}s`);
    } else if (this.circuitOf(p) === 'half_open') {
      p.openedAt = Date.now(); // 半开试探失败，重新计时
    }
  }
  private recordSuccess(p: ProviderState, ms: number) {
    p.calls++;
    p.totalMs += ms;
    p.consecutiveFailures = 0;
    p.lastSuccessAt = new Date().toISOString();
    if (p.openedAt != null) {
      p.openedAt = null;
      this.pushEvent('circuit_close', p.client.id, '半开试探成功，恢复');
    }
  }
  private pushEvent(type: (typeof this.events)[number]['type'], provider: string, detail: string) {
    this.events.push({ at: new Date().toISOString(), type, provider, detail });
    if (this.events.length > 200) this.events.splice(0, this.events.length - 200);
  }

  /** 故障演练：normal | primary_down | all_down */
  simulate(mode: 'normal' | 'primary_down' | 'all_down') {
    this.providers.forEach((p, i) => {
      p.simulatedDown = mode === 'all_down' || (mode === 'primary_down' && i === 0);
      if (mode === 'normal') {
        p.openedAt = null;
        p.consecutiveFailures = 0;
      }
    });
    this.pushEvent('simulate', mode === 'primary_down' ? (this.providers[0]?.client.id ?? '*') : '*', { normal: '故障演练结束，恢复正常', primary_down: '演练：主 provider 标记为故障', all_down: '演练：全部 provider 标记为故障，执行链进入规则降级' }[mode]);
    return this.status();
  }

  status(): ProviderStatus[] {
    return this.providers.map((p) => ({
      id: p.client.id,
      configured: p.client.configured,
      models: (p.client as LlmClient).models ?? null,
      circuit: this.circuitOf(p),
      consecutiveFailures: p.consecutiveFailures,
      openedAt: p.openedAt ? new Date(p.openedAt).toISOString() : null,
      stats: { calls: p.calls, failures: p.failures, avgMs: p.calls ? Math.round(p.totalMs / p.calls) : 0, lastError: p.lastError, lastSuccessAt: p.lastSuccessAt },
      simulatedDown: p.simulatedDown,
    }));
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const candidates = this.providers.filter((p) => this.available(p));
    if (!candidates.length) {
      this.pushEvent('all_down', '*', '没有可用 provider');
      throw new LlmError('所有模型 provider 均不可用（未配置、熔断中或故障演练）', 'LLM_ALL_PROVIDERS_DOWN');
    }
    let lastErr: LlmError | null = null;
    for (const [idx, p] of candidates.entries()) {
      for (let attempt = 0; attempt <= this.opts.maxRetries; attempt++) {
        const t0 = Date.now();
        try {
          const r = await p.client.chat(messages, opts);
          this.recordSuccess(p, Date.now() - t0);
          r.usage.provider = p.client.id;
          r.usage.attempts = attempt + 1;
          if (idx > 0) r.usage.failedOver = true;
          return r;
        } catch (e) {
          const err = e instanceof LlmError ? e : new LlmError((e as Error).message, 'LLM_UNREACHABLE');
          lastErr = err;
          this.recordFailure(p, err);
          if (err.retryable && attempt < this.opts.maxRetries) {
            await new Promise((r) => setTimeout(r, this.opts.backoffMs * 2 ** attempt));
            continue;
          }
          if (!err.failover) throw err; // 400 / schema 等不因切换而改善
          break;
        }
      }
      if (idx < candidates.length - 1) this.pushEvent('failover', p.client.id, `切换到 ${candidates[idx + 1].client.id}：${lastErr?.code}`);
    }
    throw lastErr ?? new LlmError('模型调用失败', 'LLM_UNREACHABLE');
  }
}
