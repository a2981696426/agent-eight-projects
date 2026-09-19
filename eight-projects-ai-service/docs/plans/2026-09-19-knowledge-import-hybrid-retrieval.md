# 知识导入 + 混合检索（BM25 + 向量，pgvector）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 CS-017 把知识检索从纯词法升级为 **BM25 + 向量混合**（向量存 pgvector，embedding 首选腾讯混元 OpenAI 兼容端点，百炼备用，供应商不可用时退回纯 BM25），并提供云商知识库导入（FAQ CSV/JSON + 文本），向量化前对访客原文脱敏。

**Architecture:** `agent-core` 把 `ChainContext.index` 放宽为 `Retriever` 接口（`search` 可异步），BM25Index 仍实现它；API 侧 `services/embeddings.ts` 定义 `EmbeddingProvider`（OpenAI 兼容实现 + 确定性 Mock），`services/retriever.ts` 的 `HybridRetriever` 并行执行 BM25 与向量查询后按 0.4/0.6 加权融合；向量落 `knowledge_vectors`（`vector(N)`），发布/重切块时经 pg-boss `knowledge.embed` 队列异步向量化；`/api/knowledge/import` 支持 `faq-csv` / `faq-json`。

**Tech Stack:** pgvector（PGlite 内置扩展 / `pgvector/pgvector:pg16`）、pg-boss、node:crypto（Mock 向量哈希）。

## Global Constraints

- 检索模式必须可观测：trace 的 knowledge 阶段 detail 记录 `mode: 'hybrid' | 'bm25'` 与供应商；供应商失败不影响主链（退回 BM25）。
- 只向量化知识条目与**脱敏后的查询**：手机号、订单号、序列号、邮箱在向量化前替换为占位符；不把佩戴数据或健康描述原文送出。
- 每个向量记录 provider + model + dims；更换供应商通过全量重建作业完成，不在线静默替换。
- 混合权重初始 BM25 0.4 / 向量 0.6；`minScore` 语义保持（0～1）。
- 不引入新的外部服务；测试全部离线（Mock 供应商）。

---

### Task 1: agent-core `Retriever` 接口 + KnowledgeHit 组件分数

**Files:** Modify `packages/agent-core/src/pipeline.ts`（`ChainContext.index: Retriever`，knowledge 阶段 `await`，detail 增 `mode`）、`packages/agent-core/src/retrieval.ts`（导出 `Retriever` 接口）、`packages/shared/src/index.ts`（`KnowledgeHit` 增 `lexical?: number; semantic?: number`）、`packages/agent-core/src/index.ts`（导出）。

```ts
export interface Retriever {
  readonly size: number;
  readonly mode?: 'bm25' | 'hybrid';
  search(query: string, opts?: { topK?: number; tags?: string[]; minScore?: number }): KnowledgeHit[] | Promise<KnowledgeHit[]>;
}
```
- [ ] 改接口 → `pnpm test`（agent-core 12 条仍绿）→ 提交 `refactor(core): Retriever interface with async search; hit component scores`。

---

### Task 2: `services/embeddings.ts`（供应商抽象 + Mock + 脱敏）（TDD）

**Files:** Create `apps/api/src/services/embeddings.ts`、`apps/api/test/embeddings.test.ts`；Modify `apps/api/src/env.ts`、`.env.example`。

```ts
export interface EmbeddingProvider { readonly id: string; readonly model: string; readonly dims: number; embed(texts: string[]): Promise<number[][]>; health(): Promise<{ ok: boolean }> }
export class OpenAiCompatEmbedding implements EmbeddingProvider  // POST {baseUrl}/embeddings {model,input[,dimensions]}；8s 超时；一次重试；L2 归一化
export class MockEmbedding implements EmbeddingProvider            // 字二元组/词哈希到 dims 桶（sha1 前 4 字节 % dims），L2 归一化；确定性
export function scrubForEmbedding(text: string): string             // 手机号→<phone>，14~20 位数字→<order>，10 位以上大写字母数字混合→<serial>，邮箱→<email>
export const cosine = (a: number[], b: number[]) => number
export function embeddingFromEnv(): EmbeddingProvider | null        // EMBEDDING_PROVIDER=hunyuan|bailian|openai-compat|mock|off
```
Env：`EMBEDDING_PROVIDER=mock`（本机默认）、`EMBEDDING_BASE_URL`（hunyuan 默认 `https://api.hunyuan.cloud.tencent.com/v1`，bailian 默认 `https://dashscope.aliyuncs.com/compatible-mode/v1`）、`EMBEDDING_API_KEY`、`EMBEDDING_MODEL`（hunyuan 默认 `hunyuan-embedding`，bailian 默认 `text-embedding-v4`）、`EMBEDDING_DIMS=1024`。

单测：Mock 同文本向量相同、相近文本 cosine 高于无关文本、向量模长≈1；`scrubForEmbedding` 覆盖四类；`embeddingFromEnv('off')` 为 null。

- [ ] 测试 → 实现 → 提交 `feat(embeddings): provider abstraction (OpenAI-compatible: hunyuan/bailian) with deterministic mock and PII scrubbing`。

---

### Task 3: 向量存储 + `HybridRetriever` + 向量化作业（TDD）

**Files:** Create `apps/api/src/services/retriever.ts`、`apps/api/test/retriever.test.ts`；Modify `apps/api/src/db.ts`（表；dims 来自 env）、`apps/api/src/services/jobs.ts`（`knowledge.embed` 队列）、`apps/api/src/services/chain.ts`（`knowledgeIndex()` 返回 HybridRetriever；`refreshIndex` 同时入队向量化缺失块）、`apps/api/src/routes/knowledge.ts`（stats 增 vectors；`POST /api/knowledge/reindex-vectors` admin；`POST /api/knowledge/search` 返回 mode）。

```sql
CREATE TABLE IF NOT EXISTS knowledge_vectors(chunk_id TEXT PRIMARY KEY, doc_id TEXT, provider TEXT, model TEXT, dims INTEGER, embedding vector(${dims}), updated_at TEXT);
CREATE INDEX IF NOT EXISTS idx_kv_doc ON knowledge_vectors(doc_id);
```
```ts
export class VectorStore { constructor(provider: EmbeddingProvider); upsertChunks(chunks: {id, docId, text, title}[]): Promise<number>; deleteDoc(docId): Promise<void>; query(vec: number[], k: number, tags?: string[]): Promise<{chunkId, sim}[]>; count(): Promise<number> }
export class HybridRetriever implements Retriever {
  constructor(bm25: BM25Index, store: VectorStore | null, weights = { lexical: 0.4, semantic: 0.6 })
  mode: 'bm25' | 'hybrid'   // store 为空或最近一次 embed 失败（60s 熔断）→ 'bm25'
  async search(query, opts): 并行 bm25.search(query, topK*2) 与 store.query(embed(scrub(query)), topK*2)；按 chunkId 合并：score = 0.4*lexical + 0.6*semantic；缺失分量记 0；tags 软加权同 BM25；排序、minScore、topK
}
```
`knowledge.embed` 作业：payload `{ docId }`，worker 取该 doc 的 published chunks → `upsertChunks`（批 16）；发布/重切块/导入后入队；删除文档时 `deleteDoc`。`refreshIndex()` 后检查 `knowledge_vectors` 与 chunks 差集，为缺失块入队。

单测（Mock 供应商、PGlite）：`upsertChunks` 后 `count` 正确且 `query` 返回自身最相似；`HybridRetriever` 对只在语义侧命中的同义问句（如「淋浴时能戴吗」vs 知识「防水等级 IPX8 日常淋浴」）返回该块且 `semantic>0`；供应商抛错时 `mode='bm25'` 且仍返回 BM25 结果；`minScore` 过滤生效。

- [ ] 测试 → 实现 → 提交 `feat(retrieval): pgvector store, hybrid BM25+vector retriever with fallback, async embedding jobs`。

---

### Task 4: 知识导入（FAQ CSV / JSON / 云商导出映射）+ Mind Studio 上传

**Files:** Modify `apps/api/src/routes/knowledge.ts`（`/import` 增 `format`）、Create `apps/api/src/services/knowledge-import.ts`、`apps/api/test/knowledge-import.test.ts`；Modify `apps/web/src/pages/ai/MindStudio.tsx`（导入面板：格式选择 + 文件读取）。

```ts
export type ImportFormat = 'text' | 'faq-csv' | 'faq-json';
export function parseFaqCsv(csv: string): { question: string; answer: string; similar: string[]; category: string; tags: string[] }[]   // 表头映射：标准问|问题|question → question；答案|answer；相似问|similar（以 | 或 ； 分隔）；分类|category；标签|tags；支持引号与换行
export function parseFaqJson(json: string): 同上
export function faqToDoc(item): { title, category, tags, content }   // content = `Q：${q}\n${similar.map(s=>`Q：${s}`).join('\n')}\nA：${a}`（相似问进入正文提升召回）
```
RUNBOOK 增「云商知识库迁移」：后台导出 Excel → 另存 CSV UTF-8 → Mind Studio 导入（format faq-csv，勾选发布）→ 向量化进度在知识统计里看 `vectors.coverage`。

单测：CSV 含引号/换行/相似问分隔；中文表头映射；JSON 数组；inject `POST /api/knowledge/import {format:'faq-csv', publish:true}` → 文档数增加、chunks 生成、等待作业后 `vectors.count>0`；`POST /api/knowledge/search` 命中相似问。

- [ ] 测试 → 实现 → 前端 → 提交 `feat(knowledge): FAQ CSV/JSON import with Yunshang export column mapping; Mind Studio upload`。

---

### Task 5: Benchmark 对比 + 文档 + 回归

- 用 `pnpm --filter @eight/api` 的 Benchmark（Agent Studio 评测用例 10 条 + 新增 5 条同义追问）在 `EMBEDDING_PROVIDER=mock` 下跑 BM25 与 hybrid 各一次，记录 `retrievalConfidence` 与召回命中差异到 `docs/LOOP-LOG.md` L13（注明 Mock 向量只是词法哈希，真实供应商效果需上线后用真实用例复测）。
- 文档：ARCHITECTURE「检索」、EXECUTION-CHAIN 第 4 阶段、RUNBOOK 知识迁移与供应商切换、`.env.example`、README。
- [ ] `pnpm -r typecheck`、单测、`pnpm e2e` 全绿 → 提交 `docs: hybrid retrieval, knowledge import (L13)`。

## Self-Review

- CS-017 覆盖：混合检索 ✔、pgvector ✔、混元首选/百炼备用 ✔（同一 OpenAI 兼容实现，配置切换）、供应商不可用退回 BM25 ✔、脱敏 ✔、provider+model+dims 记录 ✔、重建作业 ✔。
- 类型一致性：`Retriever`（Task 1）被 `HybridRetriever`（Task 3）实现并注入 `ChainContext.index`（chain.ts）；`EmbeddingProvider`（Task 2）被 `VectorStore`（Task 3）与 `knowledge.embed` worker 消费；`KnowledgeHit.lexical/semantic`（Task 1）由 Task 3 填充。
