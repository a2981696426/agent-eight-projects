import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BM25Index, chunkText, tokenize } from '../src/retrieval.js';

test('tokenize 中文二元组 + 拉丁词', () => {
  const t = tokenize('M8 防水吗 IPX8');
  assert.ok(t.includes('m8'));
  assert.ok(t.includes('防水'));
  assert.ok(t.includes('水吗'));
  assert.ok(t.includes('ipx8'));
});

test('BM25 短追问命中带标签知识', () => {
  const idx = new BM25Index([
    { docTitle: '安装佩戴', chunk: { id: 'c1', docId: 'd1', seq: 1, text: '传感器防水等级 IPX8，可日常淋浴，避免长时间泡澡与温泉。', tags: ['产品', '售前'] } },
    { docTitle: '发票说明', chunk: { id: 'c2', docId: 'd2', seq: 1, text: '电子发票在订单完成后 48 小时内开具，可在订单详情下载。', tags: ['发票'] } },
  ]);
  const hits = idx.search('防水吗', { topK: 3, tags: ['产品'] });
  assert.equal(hits[0]?.chunkId, 'c1');
  assert.ok(hits[0].score > 0);
  const none = idx.search('', { topK: 3 });
  assert.equal(none.length, 0);
});

test('chunkText 按段落切块且不超长', () => {
  const text = Array.from({ length: 12 }, (_, i) => `第${i + 1}段。` + '内容'.repeat(60)).join('\n\n');
  const chunks = chunkText(text, 300);
  assert.ok(chunks.length >= 4);
  for (const c of chunks) assert.ok(c.length <= 300 * 1.6 + 5);
});
