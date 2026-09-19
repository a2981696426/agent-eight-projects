import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { BM25Index } from '@eight/agent-core';
import type { KnowledgeChunk } from '@eight/shared';

process.env.DATA_DIR = ':memory:';
process.env.EMBEDDING_DIMS = '256';

const { initDb, closeDb, hasVector } = await import('../src/db.ts');
const { MockEmbedding } = await import('../src/services/embeddings.ts');
const { VectorStore, HybridRetriever } = await import('../src/services/retriever.ts');

const docs: { chunk: KnowledgeChunk; docTitle: string }[] = [
  { docTitle: '防水与佩戴', chunk: { id: 'c-water', docId: 'd1', seq: 1, text: 'M8 防水等级 IPX8，日常淋浴、洗手都没问题；不建议长时间泡澡、温泉或游泳。', tags: ['售前', '防水'] } },
  { docTitle: '发票规则', chunk: { id: 'c-invoice', docId: 'd2', seq: 1, text: '开票 90 天内支持换开抬头，需提供公司全称与统一社会信用代码。', tags: ['发票'] } },
  { docTitle: '物流时效', chunk: { id: 'c-ship', docId: 'd3', seq: 1, text: '付款后 48 小时内发货，默认顺丰；超过 72 小时无更新视为停滞，可申请催件。', tags: ['物流'] } },
];

const provider = new MockEmbedding(256);
let store: InstanceType<typeof VectorStore>;
let bm25: BM25Index;

before(async () => {
  await initDb();
  assert.equal(hasVector(), true, 'PGlite 应加载 pgvector');
  store = new VectorStore(provider);
  bm25 = new BM25Index(docs);
  const n = await store.upsertChunks(docs.map((d) => ({ id: d.chunk.id, docId: d.chunk.docId, text: d.chunk.text, title: d.docTitle })));
  assert.equal(n, 3);
});
after(async () => {
  await closeDb();
});

test('VectorStore：count / query 返回最相似块 / deleteDoc', async () => {
  assert.equal(await store.count(), 3);
  const [q] = await provider.embed(['开票 90 天内支持换开抬头']);
  const hits = await store.query(q, 2);
  assert.equal(hits[0].chunkId, 'c-invoice');
  assert.ok(hits[0].sim > hits[1].sim);
  await store.upsertChunks([{ id: 'c-tmp', docId: 'd-tmp', text: '临时块', title: 't' }]);
  assert.equal(await store.count(), 4);
  await store.deleteDoc('d-tmp');
  assert.equal(await store.count(), 3);
});

test('HybridRetriever：mode=hybrid，融合分含 lexical/semantic 分量，且按 0.4/0.6 加权', async () => {
  const r = new HybridRetriever(bm25, store, provider);
  assert.equal(r.mode, 'hybrid');
  const hits = await r.search('传感器淋浴时能不能戴', { topK: 3 });
  assert.equal(hits[0].chunkId, 'c-water');
  const h = hits[0];
  assert.ok((h.semantic ?? 0) > 0);
  const expected = 0.4 * (h.lexical ?? 0) + 0.6 * (h.semantic ?? 0);
  assert.ok(Math.abs(h.score - expected) < 0.01, `score=${h.score} expected≈${expected}`);
});

test('HybridRetriever：minScore 过滤与 topK 生效；tags 软加权不改变排序方向', async () => {
  const r = new HybridRetriever(bm25, store, provider);
  const all = await r.search('发货 顺丰 催件', { topK: 3, minScore: 0 });
  assert.equal(all[0].chunkId, 'c-ship');
  const strict = await r.search('发货 顺丰 催件', { topK: 3, minScore: 0.95 });
  assert.ok(strict.length <= 1);
  const one = await r.search('发货', { topK: 1 });
  assert.equal(one.length, 1);
});

test('HybridRetriever：供应商失败 → 退回 BM25（mode=bm25，仍有结果），恢复后回到 hybrid', async () => {
  const flaky = new MockEmbedding(256);
  let fail = true;
  const origEmbed = flaky.embed.bind(flaky);
  flaky.embed = async (texts) => {
    if (fail) throw new Error('embedding provider down');
    return origEmbed(texts);
  };
  const r = new HybridRetriever(bm25, store, flaky, { cooldownMs: 50 });
  const hits = await r.search('发票抬头换开', { topK: 2 });
  assert.equal(r.mode, 'bm25');
  assert.equal(hits[0].chunkId, 'c-invoice');
  assert.equal(hits[0].semantic, undefined);
  fail = false;
  await new Promise((res) => setTimeout(res, 80));
  const hits2 = await r.search('发票抬头换开', { topK: 2 });
  assert.equal(r.mode, 'hybrid');
  assert.ok((hits2[0].semantic ?? 0) > 0);
});

test('HybridRetriever：无向量库（store=null）时等价于 BM25', async () => {
  const r = new HybridRetriever(bm25, null, null);
  assert.equal(r.mode, 'bm25');
  const hits = await r.search('顺丰发货', { topK: 1 });
  assert.equal(hits[0].chunkId, 'c-ship');
  assert.equal(r.size, 3);
});
