import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockEmbedding, OpenAiCompatEmbedding, cosine, embeddingFromEnv, scrubForEmbedding } from '../src/services/embeddings.ts';

test('MockEmbedding：确定性、单位模长、相近文本相似度高于无关文本', async () => {
  const m = new MockEmbedding(256);
  const [a1, a2, b, c] = await m.embed(['传感器洗澡能戴吗', '传感器洗澡能戴吗', '洗澡淋浴时能不能戴着传感器', '发票抬头写错了怎么换开']);
  assert.deepEqual(a1, a2);
  assert.equal(a1.length, 256);
  assert.ok(Math.abs(Math.hypot(...a1) - 1) < 1e-6);
  assert.ok(cosine(a1, b) > cosine(a1, c), `near=${cosine(a1, b)} far=${cosine(a1, c)}`);
  assert.ok(cosine(a1, a2) > 0.999);
});

test('scrubForEmbedding：手机号 / 订单号 / 序列号 / 邮箱 替换为占位符，普通文本不动', () => {
  const s = scrubForEmbedding('订单 20260918000123 的快递三天没动了，手机 13812340001，序列号 M8AX7Q9K2L3P，邮箱 a.b@example.com');
  assert.ok(!s.includes('20260918000123') && s.includes('<order>'));
  assert.ok(!s.includes('13812340001') && s.includes('<phone>'));
  assert.ok(!s.includes('M8AX7Q9K2L3P') && s.includes('<serial>'));
  assert.ok(!s.includes('example.com') && s.includes('<email>'));
  assert.equal(scrubForEmbedding('传感器防水吗'), '传感器防水吗');
});

test('embeddingFromEnv：off → null；mock → MockEmbedding；hunyuan 默认端点与模型', () => {
  process.env.EMBEDDING_PROVIDER = 'off';
  assert.equal(embeddingFromEnv(), null);
  process.env.EMBEDDING_PROVIDER = 'mock';
  process.env.EMBEDDING_DIMS = '64';
  const m = embeddingFromEnv();
  assert.ok(m instanceof MockEmbedding);
  assert.equal(m!.dims, 64);
  process.env.EMBEDDING_PROVIDER = 'hunyuan';
  process.env.EMBEDDING_API_KEY = 'k';
  delete process.env.EMBEDDING_BASE_URL;
  delete process.env.EMBEDDING_MODEL;
  const h = embeddingFromEnv() as OpenAiCompatEmbedding;
  assert.ok(h instanceof OpenAiCompatEmbedding);
  assert.equal(h.model, 'hunyuan-embedding');
  assert.equal(h.baseUrl, 'https://api.hunyuan.cloud.tencent.com/v1');
  process.env.EMBEDDING_PROVIDER = 'bailian';
  const b = embeddingFromEnv() as OpenAiCompatEmbedding;
  assert.equal(b.model, 'text-embedding-v4');
  assert.equal(b.baseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
  process.env.EMBEDDING_PROVIDER = 'mock';
  process.env.EMBEDDING_DIMS = '1024';
});

test('OpenAiCompatEmbedding：解析 data[].embedding 并归一化；HTTP 错误抛出', async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push(String(url));
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    return new Response(JSON.stringify({ data: body.input.map((_, i) => ({ index: i, embedding: [3, 4, 0] })) }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const p = new OpenAiCompatEmbedding({ id: 'test', baseUrl: 'https://x.example/v1', apiKey: 'k', model: 'm', dims: 3, fetchImpl });
  const [v] = await p.embed(['hello']);
  assert.deepEqual(v.map((x) => Number(x.toFixed(2))), [0.6, 0.8, 0]);
  assert.equal(calls[0], 'https://x.example/v1/embeddings');
  const bad = new OpenAiCompatEmbedding({ id: 'test', baseUrl: 'https://x.example/v1', apiKey: 'k', model: 'm', dims: 3, fetchImpl: async () => new Response('{"error":{"message":"quota"}}', { status: 429 }) });
  await assert.rejects(bad.embed(['x']), /429/);
});
