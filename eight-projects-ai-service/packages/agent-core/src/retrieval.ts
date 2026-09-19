import type { KnowledgeChunk, KnowledgeHit } from '@eight/shared';

/**
 * 混合词法检索：中文按字二元组（bigram）+ 拉丁/数字按词切分，BM25 打分。
 * 相比整段拼接查询，这里显式接收「当前问题 + 累积实体 + 意图标签」三路信号，
 * 并支持按知识标签做软过滤（场景包的 knowledgeTags）。
 */
export function tokenize(text: string): string[] {
  const s = text.normalize('NFKC').toLowerCase();
  const tokens: string[] = [];
  const latin = s.match(/[a-z0-9][a-z0-9_\-.]{1,}/g) ?? [];
  tokens.push(...latin);
  const han = s.replace(/[^\u4e00-\u9fff]/g, ' ');
  for (const seg of han.split(/\s+/)) {
    if (!seg) continue;
    if (seg.length === 1) tokens.push(seg);
    for (let i = 0; i < seg.length - 1; i++) tokens.push(seg.slice(i, i + 2));
  }
  return tokens;
}

/** 检索器契约：BM25Index 与宿主的混合检索器都实现它；search 可同步或异步 */
export interface Retriever {
  readonly size: number;
  readonly mode?: 'bm25' | 'hybrid';
  search(query: string, opts?: { topK?: number; tags?: string[]; minScore?: number }): KnowledgeHit[] | Promise<KnowledgeHit[]>;
}

interface IndexedChunk {
  chunk: KnowledgeChunk;
  docTitle: string;
  tf: Map<string, number>;
  len: number;
}

export class BM25Index implements Retriever {
  readonly mode = 'bm25' as const;
  private docs: IndexedChunk[] = [];
  private df = new Map<string, number>();
  private avgLen = 1;
  private readonly k1 = 1.4;
  private readonly b = 0.75;

  constructor(chunks: { chunk: KnowledgeChunk; docTitle: string }[] = []) {
    this.rebuild(chunks);
  }

  rebuild(chunks: { chunk: KnowledgeChunk; docTitle: string }[]) {
    this.docs = [];
    this.df = new Map();
    for (const { chunk, docTitle } of chunks) {
      const toks = tokenize(`${docTitle}\n${chunk.text}\n${chunk.tags.join(' ')}`);
      const tf = new Map<string, number>();
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      this.docs.push({ chunk, docTitle, tf, len: toks.length });
    }
    this.avgLen = this.docs.length ? this.docs.reduce((n, d) => n + d.len, 0) / this.docs.length : 1;
  }

  get size() {
    return this.docs.length;
  }

  search(query: string, opts: { topK?: number; tags?: string[]; minScore?: number } = {}): KnowledgeHit[] {
    const topK = opts.topK ?? 6;
    const qTokens = [...new Set(tokenize(query))];
    if (!qTokens.length || !this.docs.length) return [];
    const N = this.docs.length;
    const idfOf = (t: string) => {
      const n = this.df.get(t) ?? 0;
      return Math.log(1 + (N - n + 0.5) / (n + 0.5));
    };
    // 归一化分母：词表中存在的查询词在「出现 1 次、长度均值」条件下的得分之和（tf 因子恰为 1），
    // 未登录词（口语、语气词）不惩罚；全部命中 ≈ 1.0，命中一半 ≈ 0.5
    const denom = qTokens.filter((t) => this.df.has(t)).reduce((s, t) => s + idfOf(t), 0);
    if (!denom) return [];
    const results: KnowledgeHit[] = [];
    for (const d of this.docs) {
      let score = 0;
      let matched = 0;
      for (const t of qTokens) {
        const f = d.tf.get(t);
        if (!f) continue;
        matched++;
        score += idfOf(t) * ((f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * d.len) / this.avgLen)));
      }
      if (!matched) continue;
      // 标签软加权：场景包标签命中 +15%
      if (opts.tags?.length && d.chunk.tags.some((t) => opts.tags!.includes(t))) score *= 1.15;
      const norm = Math.min(1, score / denom);
      results.push({ id: `kb:${d.chunk.id}`, chunkId: d.chunk.id, docId: d.chunk.docId, docTitle: d.docTitle, text: d.chunk.text, score: Number(norm.toFixed(4)), tags: d.chunk.tags, lexical: Number(norm.toFixed(4)) });
    }
    results.sort((a, b) => b.score - a.score);
    const min = opts.minScore ?? 0;
    return results.filter((r) => r.score >= min).slice(0, topK);
  }
}

/** 把长文按段落切成 ≤ maxLen 的块，保留段落边界。 */
export function chunkText(text: string, maxLen = 420): string[] {
  const paras = text.replace(/\r\n/g, '\n').split(/\n{2,}|\n(?=#{1,6}\s)|\n(?=\d+[.、])/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let buf = '';
  for (const p of paras) {
    if ((buf + '\n' + p).length > maxLen && buf) {
      chunks.push(buf.trim());
      buf = p;
    } else {
      buf = buf ? `${buf}\n${p}` : p;
    }
    while (buf.length > maxLen * 1.6) {
      chunks.push(buf.slice(0, maxLen));
      buf = buf.slice(maxLen);
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks;
}
