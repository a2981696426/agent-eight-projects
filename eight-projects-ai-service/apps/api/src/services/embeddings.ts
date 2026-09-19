import { createHash } from 'node:crypto';
import { tokenize } from '@eight/agent-core';

/**
 * Embedding 供应商抽象（CS-017）：
 * - OpenAiCompatEmbedding：任何 OpenAI 兼容 /v1/embeddings（首选腾讯混元，备用阿里百炼）
 * - MockEmbedding：确定性词法哈希向量，供本机/测试离线使用（只反映词面相似，不是语义模型）
 * 向量化前必须先 scrubForEmbedding 脱敏；每个向量在库中记录 provider + model + dims。
 */
export interface EmbeddingProvider {
  readonly id: string;
  readonly model: string;
  readonly dims: number;
  embed(texts: string[]): Promise<number[][]>;
  health(): Promise<{ ok: boolean; id: string; model: string; dims: number }>;
}

const l2 = (v: number[]) => {
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
};
export const cosine = (a: number[], b: number[]) => {
  let s = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) s += a[i] * b[i];
  return s;
};

/** 脱敏：手机号 / 14~20 位订单号 / 10 位以上大写字母数字混合序列号 / 邮箱 → 占位符 */
export function scrubForEmbedding(text: string): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
    .replace(/1[3-9]\d{9}/g, '<phone>')
    .replace(/\d{14,20}/g, '<order>')
    .replace(/\b(?=[A-Z0-9]{10,}\b)(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*\d)[A-Z0-9]+\b/g, '<serial>');
}

export class MockEmbedding implements EmbeddingProvider {
  readonly id = 'mock';
  readonly model = 'mock-bigram-hash';
  constructor(readonly dims = 1024) {}
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = new Array<number>(this.dims).fill(0);
      for (const tok of tokenize(t)) {
        const h = createHash('sha1').update(tok).digest();
        v[h.readUInt32BE(0) % this.dims] += 1;
        v[h.readUInt32BE(4) % this.dims] += 0.5;
      }
      return l2(v);
    });
  }
  async health() {
    return { ok: true, id: this.id, model: this.model, dims: this.dims };
  }
}

export interface OpenAiCompatConfig {
  id: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  dims: number;
  timeoutMs?: number;
  /** 百炼等支持 dimensions 参数的供应商可传；混元固定 1024 */
  sendDimensions?: boolean;
  fetchImpl?: typeof fetch;
}

export class OpenAiCompatEmbedding implements EmbeddingProvider {
  readonly id: string;
  readonly model: string;
  readonly dims: number;
  readonly baseUrl: string;
  private readonly cfg: OpenAiCompatConfig;
  constructor(cfg: OpenAiCompatConfig) {
    this.cfg = cfg;
    this.id = cfg.id;
    this.model = cfg.model;
    this.dims = cfg.dims;
    this.baseUrl = cfg.baseUrl.replace(/\/$/, '');
  }
  private async call(texts: string[]): Promise<number[][]> {
    const f = this.cfg.fetchImpl ?? fetch;
    const res = await f(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.apiKey}` },
      body: JSON.stringify({ model: this.model, input: texts, ...(this.cfg.sendDimensions ? { dimensions: this.dims } : {}), encoding_format: 'float' }),
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 8000),
    });
    if (!res.ok) throw new Error(`embedding HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { data?: { index?: number; embedding: number[] }[] };
    if (!j.data?.length) throw new Error('embedding 响应缺少 data');
    const sorted = [...j.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return sorted.map((d) => l2(d.embedding));
  }
  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    try {
      return await this.call(texts);
    } catch (e) {
      // 一次重试（网络抖动 / 429）
      if (/HTTP 4(?!29)\d\d/.test((e as Error).message)) throw e;
      return this.call(texts);
    }
  }
  async health() {
    return { ok: !!this.cfg.apiKey, id: this.id, model: this.model, dims: this.dims };
  }
}

const PRESETS: Record<string, { baseUrl: string; model: string; dims: number; sendDimensions: boolean }> = {
  hunyuan: { baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1', model: 'hunyuan-embedding', dims: 1024, sendDimensions: false },
  bailian: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'text-embedding-v4', dims: 1024, sendDimensions: true },
  'openai-compat': { baseUrl: '', model: '', dims: 1024, sendDimensions: false },
};

/** EMBEDDING_PROVIDER=hunyuan|bailian|openai-compat|mock|off */
export function embeddingFromEnv(): EmbeddingProvider | null {
  const kind = (process.env.EMBEDDING_PROVIDER ?? 'mock').toLowerCase();
  const dims = Number(process.env.EMBEDDING_DIMS ?? 1024);
  if (kind === 'off') return null;
  if (kind === 'mock') return new MockEmbedding(dims);
  const preset = PRESETS[kind];
  if (!preset) return new MockEmbedding(dims);
  return new OpenAiCompatEmbedding({
    id: kind,
    baseUrl: process.env.EMBEDDING_BASE_URL || preset.baseUrl,
    apiKey: process.env.EMBEDDING_API_KEY ?? '',
    model: process.env.EMBEDDING_MODEL || preset.model,
    dims: Number(process.env.EMBEDDING_DIMS ?? preset.dims),
    sendDimensions: preset.sendDimensions,
  });
}
