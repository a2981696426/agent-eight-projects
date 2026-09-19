import type { BM25Index, Retriever } from '@eight/agent-core';
import type { KnowledgeHit } from '@eight/shared';
import { nowIso, openDb } from '../db.ts';
import { scrubForEmbedding, type EmbeddingProvider } from './embeddings.ts';

/**
 * 混合检索（CS-017）：BM25（词法）+ pgvector（语义）并行，融合分 = min(1, 词法 + 0.6 × 语义)；
 * 供应商失败进入短暂熔断，期间退回纯 BM25——检索模式在 trace 中可见（mode）。
 */
const db = () => openDb();
const toVectorLiteral = (v: number[]) => `[${v.map((x) => (Number.isFinite(x) ? Number(x.toFixed(6)) : 0)).join(',')}]`;

export class VectorStore {
  constructor(readonly provider: EmbeddingProvider) {}

  /** 向量化并 upsert；返回写入条数（会先脱敏；已存在同 provider/model 的块直接覆盖） */
  async upsertChunks(chunks: { id: string; docId: string; text: string; title: string }[], batch = 16): Promise<number> {
    let n = 0;
    for (let i = 0; i < chunks.length; i += batch) {
      const slice = chunks.slice(i, i + batch);
      const vectors = await this.provider.embed(slice.map((c) => scrubForEmbedding(`${c.title}\n${c.text}`)));
      const now = nowIso();
      for (let j = 0; j < slice.length; j++) {
        await db().run(
          'INSERT INTO knowledge_vectors VALUES (?,?,?,?,?,?::vector,?) ON CONFLICT (chunk_id) DO UPDATE SET doc_id=EXCLUDED.doc_id, provider=EXCLUDED.provider, model=EXCLUDED.model, dims=EXCLUDED.dims, embedding=EXCLUDED.embedding, updated_at=EXCLUDED.updated_at',
          slice[j].id, slice[j].docId, this.provider.id, this.provider.model, this.provider.dims, toVectorLiteral(vectors[j]), now,
        );
        n++;
      }
    }
    return n;
  }
  async deleteDoc(docId: string) {
    await db().run('DELETE FROM knowledge_vectors WHERE doc_id=?', docId);
  }
  async deleteChunks(chunkIds: string[]) {
    for (const id of chunkIds) await db().run('DELETE FROM knowledge_vectors WHERE chunk_id=?', id);
  }
  async count(): Promise<number> {
    return (await db().get<{ n: number }>('SELECT COUNT(*)::int n FROM knowledge_vectors WHERE provider=? AND model=?', this.provider.id, this.provider.model))?.n ?? 0;
  }
  /** 缺少当前供应商向量的已发布块 */
  async missingPublishedChunkIds(): Promise<string[]> {
    const rows = await db().all<{ id: string }>(
      "SELECT c.id FROM knowledge_chunks c JOIN knowledge_docs d ON d.id=c.doc_id LEFT JOIN knowledge_vectors v ON v.chunk_id=c.id AND v.provider=? AND v.model=? WHERE d.status='published' AND v.chunk_id IS NULL",
      this.provider.id, this.provider.model,
    );
    return rows.map((r) => r.id);
  }
  async query(vec: number[], k: number): Promise<{ chunkId: string; sim: number }[]> {
    const rows = await db().all<{ chunk_id: string; sim: number }>(
      'SELECT chunk_id, (1 - (embedding <=> ?::vector))::float8 AS sim FROM knowledge_vectors WHERE provider=? AND model=? ORDER BY embedding <=> ?::vector LIMIT ?',
      toVectorLiteral(vec), this.provider.id, this.provider.model, toVectorLiteral(vec), k,
    );
    return rows.map((r) => ({ chunkId: r.chunk_id, sim: Math.max(0, Math.min(1, Number(r.sim))) }));
  }
}

export interface HybridOptions {
  lexicalWeight?: number;
  semanticWeight?: number;
  /** 供应商失败后的熔断时长 */
  cooldownMs?: number;
  /** 查询向量化超时 */
  embedTimeoutMs?: number;
}

export class HybridRetriever implements Retriever {
  private downUntil = 0;
  private lastMode: 'bm25' | 'hybrid' = 'bm25';
  private readonly w: { lexical: number; semantic: number };
  private readonly cooldownMs: number;
  private readonly embedTimeoutMs: number;
  constructor(
    readonly bm25: BM25Index,
    readonly store: VectorStore | null,
    readonly provider: EmbeddingProvider | null,
    opts: HybridOptions = {},
  ) {
    this.w = { lexical: opts.lexicalWeight ?? 1, semantic: opts.semanticWeight ?? 0.6 };
    this.cooldownMs = opts.cooldownMs ?? 60_000;
    this.embedTimeoutMs = opts.embedTimeoutMs ?? 2500;
    this.lastMode = store && provider ? 'hybrid' : 'bm25';
  }
  get size() {
    return this.bm25.size;
  }
  /** 最近一次检索实际使用的模式 */
  get mode(): 'bm25' | 'hybrid' {
    return this.lastMode;
  }
  private semanticAvailable() {
    return !!this.store && !!this.provider && Date.now() >= this.downUntil;
  }

  async search(query: string, opts: { topK?: number; tags?: string[]; minScore?: number } = {}): Promise<KnowledgeHit[]> {
    const topK = opts.topK ?? 6;
    const minScore = opts.minScore ?? 0;
    const lexical = this.bm25.search(query, { topK: topK * 2, tags: opts.tags });
    if (!this.semanticAvailable()) {
      this.lastMode = 'bm25';
      return lexical.filter((h) => h.score >= minScore).slice(0, topK);
    }
    let semantic: { chunkId: string; sim: number }[] = [];
    try {
      const embedP = this.provider!.embed([scrubForEmbedding(query)]);
      const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('embedding timeout')), this.embedTimeoutMs));
      const [vec] = await Promise.race([embedP, timeout]);
      semantic = await this.store!.query(vec, topK * 2);
      this.lastMode = 'hybrid';
    } catch {
      this.downUntil = Date.now() + this.cooldownMs;
      this.lastMode = 'bm25';
      return lexical.filter((h) => h.score >= minScore).slice(0, topK);
    }
    // 融合：按 chunkId 合并，缺失分量记 0；语义侧命中但词法未命中的块需要补齐元数据
    const merged = new Map<string, KnowledgeHit>();
    for (const h of lexical) merged.set(h.chunkId, { ...h, lexical: h.score, semantic: 0 });
    const needMeta = semantic.filter((s) => !merged.has(s.chunkId)).map((s) => s.chunkId);
    const meta = needMeta.length ? await this.chunkMeta(needMeta) : new Map<string, KnowledgeHit>();
    for (const s of semantic) {
      const cur = merged.get(s.chunkId);
      if (cur) cur.semantic = s.sim;
      else {
        const m = meta.get(s.chunkId);
        if (m) merged.set(s.chunkId, { ...m, lexical: 0, semantic: s.sim });
      }
    }
    const out: KnowledgeHit[] = [];
    for (const h of merged.values()) {
      // 融合 = 词法基线 + 语义增益（上限 1）：词法满分不因语义分量偏低而被稀释（保持 minScore 语义与四维可信度口径），
      // 只在语义侧命中的同义问句以 semanticWeight × 余弦相似度进入候选。
      // 备注：固定加权 0.4/0.6 在离线对比中把词法满分压到 0.45～0.66，会误触检索改写与"售前无知识"风险，故改为增益式。
      let score = this.w.lexical * (h.lexical ?? 0) + this.w.semantic * (h.semantic ?? 0);
      // 场景包标签软加权，与 BM25 一致（BM25 分量已加权，这里只对纯语义命中补偿）
      if ((h.lexical ?? 0) === 0 && opts.tags?.length && h.tags.some((t) => opts.tags!.includes(t))) score *= 1.15;
      h.score = Number(Math.min(1, score).toFixed(4));
      h.semantic = h.semantic ? Number(h.semantic.toFixed(4)) : h.semantic;
      out.push(h);
    }
    out.sort((a, b) => b.score - a.score);
    return out.filter((h) => h.score >= minScore).slice(0, topK);
  }

  private async chunkMeta(chunkIds: string[]): Promise<Map<string, KnowledgeHit>> {
    const rows = await db().all<{ id: string; doc_id: string; text: string; tags: string; title: string }>(
      `SELECT c.id, c.doc_id, c.text, c.tags, d.title FROM knowledge_chunks c JOIN knowledge_docs d ON d.id=c.doc_id WHERE d.status='published' AND c.id IN (${chunkIds.map(() => '?').join(',')})`,
      ...chunkIds,
    );
    const m = new Map<string, KnowledgeHit>();
    for (const r of rows) {
      let tags: string[] = [];
      try {
        tags = JSON.parse(r.tags) as string[];
      } catch {
        tags = [];
      }
      m.set(r.id, { id: `kb:${r.id}`, chunkId: r.id, docId: r.doc_id, docTitle: r.title, text: r.text, score: 0, tags });
    }
    return m;
  }
}
