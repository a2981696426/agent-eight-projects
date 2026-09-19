import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { chunkText } from '@eight/agent-core';
import type { KnowledgeDoc } from '@eight/shared';
import { J, nowIso, openDb, uid, type Db } from '../db.ts';
import { knowledgeIndex, refreshIndex } from '../services/chain.ts';
import { extractFaq, similarQuestions } from '../services/aigc.ts';

const db = () => openDb();
const toDoc = async (r: Record<string, unknown>): Promise<KnowledgeDoc> => ({
  id: String(r.id),
  title: String(r.title),
  category: String(r.category ?? ''),
  tags: J.parse(r.tags, []),
  content: String(r.content ?? ''),
  status: r.status as KnowledgeDoc['status'],
  version: Number(r.version ?? 1),
  chunkCount: (await db().get<{ n: number }>('SELECT COUNT(*)::int n FROM knowledge_chunks WHERE doc_id=?', String(r.id)))?.n ?? 0,
  updatedAt: String(r.updated_at),
  source: (r.source as KnowledgeDoc['source']) ?? 'manual',
});

async function rechunk(d: Db, docId: string, content: string, tags: string[]) {
  await d.run('DELETE FROM knowledge_chunks WHERE doc_id=?', docId);
  for (const [i, text] of chunkText(content).entries()) await d.run('INSERT INTO knowledge_chunks VALUES (?,?,?,?,?)', `${docId}-c${i + 1}`, docId, i + 1, text, J.str(tags));
}

export async function knowledgeRoutes(app: FastifyInstance) {
  app.get('/api/knowledge/docs', async (req) => {
    const q = req.query as Record<string, string>;
    const rows = await db().all(`SELECT * FROM knowledge_docs ${q.status ? 'WHERE status=?' : ''} ORDER BY updated_at DESC`, ...(q.status ? [q.status] : []));
    return Promise.all(rows.map(async (r) => ({ ...(await toDoc(r)), content: undefined })));
  });
  app.get('/api/knowledge/stats', async () => ({
    docs: await db().count('knowledge_docs'),
    published: (await db().get<{ n: number }>("SELECT COUNT(*) n FROM knowledge_docs WHERE status='published'"))?.n ?? 0,
    chunks: await db().count('knowledge_chunks'),
    indexed: knowledgeIndex().size,
    categories: await db().all<{ category: string; n: number }>('SELECT category, COUNT(*) n FROM knowledge_docs GROUP BY category ORDER BY n DESC'),
  }));
  app.get('/api/knowledge/docs/:id', async (req, reply) => {
    const r = await db().get('SELECT * FROM knowledge_docs WHERE id=?', (req.params as { id: string }).id);
    if (!r) return reply.code(404).send({ error: '文档不存在' });
    const chunks = (await db().all('SELECT * FROM knowledge_chunks WHERE doc_id=? ORDER BY seq', String(r.id))).map((c) => ({ ...c, tags: J.parse(c.tags, []) }));
    const usage = (await db().all<{ id: string; created_at: string; scenario: string; doc: string }>('SELECT id, created_at, scenario, doc FROM traces ORDER BY created_at DESC LIMIT 300')).filter((t) => t.doc.includes(`"kb:${r.id}-c`)).map((t) => ({ traceId: t.id, at: t.created_at, scenario: t.scenario }));
    return { doc: await toDoc(r), chunks, usage: usage.slice(0, 30), usageCount: usage.length };
  });
  const DocBody = z.object({ title: z.string().min(1).max(120), category: z.string().max(40).default('未分类'), tags: z.array(z.string().max(20)).max(10).default([]), content: z.string().min(1).max(60000), source: z.enum(['manual', 'import', 'faq', 'conversation']).default('manual') });
  app.post('/api/knowledge/docs', async (req, reply) => {
    const b = DocBody.parse(req.body);
    const id = uid('kb-');
    await db().run('INSERT INTO knowledge_docs VALUES (?,?,?,?,?,?,?,?,?)', id, b.title, b.category, J.str(b.tags), b.content, 'draft', 1, nowIso(), b.source);
    await rechunk(db(), id, b.content, b.tags);
    reply.code(201);
    return toDoc((await db().get('SELECT * FROM knowledge_docs WHERE id=?', id))!);
  });
  app.put('/api/knowledge/docs/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = DocBody.partial().parse(req.body);
    const r = await db().get('SELECT * FROM knowledge_docs WHERE id=?', id);
    if (!r) return reply.code(404).send({ error: '文档不存在' });
    const doc = await toDoc(r);
    const next = { ...doc, ...b, tags: b.tags ?? doc.tags };
    const contentChanged = b.content !== undefined && b.content !== doc.content;
    await db().run('UPDATE knowledge_docs SET title=?, category=?, tags=?, content=?, version=?, updated_at=?, status=? WHERE id=?', next.title, next.category, J.str(next.tags), next.content, contentChanged ? doc.version + 1 : doc.version, nowIso(), contentChanged ? 'draft' : doc.status, id);
    if (contentChanged || b.tags) await rechunk(db(), id, next.content, next.tags);
    if (doc.status === 'published') await refreshIndex();
    return toDoc((await db().get('SELECT * FROM knowledge_docs WHERE id=?', id))!);
  });
  app.post('/api/knowledge/docs/:id/publish', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = z.object({ action: z.enum(['publish', 'unpublish']).default('publish') }).parse(req.body ?? {});
    if (!(await db().get('SELECT id FROM knowledge_docs WHERE id=?', id))) return reply.code(404).send({ error: '文档不存在' });
    await db().run('UPDATE knowledge_docs SET status=?, updated_at=? WHERE id=?', b.action === 'publish' ? 'published' : 'draft', nowIso(), id);
    const indexed = await refreshIndex();
    return { doc: await toDoc((await db().get('SELECT * FROM knowledge_docs WHERE id=?', id))!), indexed };
  });
  app.delete('/api/knowledge/docs/:id', async (req) => {
    const { id } = req.params as { id: string };
    await db().run('DELETE FROM knowledge_chunks WHERE doc_id=?', id);
    await db().run('DELETE FROM knowledge_docs WHERE id=?', id);
    await refreshIndex();
    return { ok: true };
  });
  /** 检索测试台 */
  app.post('/api/knowledge/search', async (req) => {
    const b = z.object({ q: z.string().min(1).max(500), topK: z.number().int().min(1).max(20).default(6), tags: z.array(z.string()).default([]) }).parse(req.body);
    const hits = knowledgeIndex().search(b.q, { topK: b.topK, tags: b.tags });
    return { q: b.q, hits, indexSize: knowledgeIndex().size };
  });
  /** 批量导入：按 --- 或标题分隔的多篇资料 */
  app.post('/api/knowledge/import', async (req) => {
    const b = z.object({ text: z.string().min(1).max(200000), category: z.string().default('导入'), tags: z.array(z.string()).default([]), publish: z.boolean().default(false) }).parse(req.body);
    const parts = b.text.split(/\n-{3,}\n|\n(?=#\s)/).map((p) => p.trim()).filter((p) => p.length > 10);
    const created: string[] = [];
    await db().tx(async (t) => {
      for (const p of parts) {
        const firstLine = p.split('\n')[0].replace(/^#+\s*/, '').slice(0, 80);
        const id = uid('kb-');
        await t.run('INSERT INTO knowledge_docs VALUES (?,?,?,?,?,?,?,?,?)', id, firstLine || '未命名资料', b.category, J.str(b.tags), p, b.publish ? 'published' : 'draft', 1, nowIso(), 'import');
        await rechunk(t, id, p, b.tags);
        created.push(id);
      }
    });
    if (b.publish) await refreshIndex();
    return { created: created.length, ids: created };
  });
  app.post('/api/knowledge/faq-extract', async (req) => {
    const b = z.object({ text: z.string().min(20).max(20000).optional(), docId: z.string().optional(), max: z.number().int().min(1).max(20).default(8) }).parse(req.body);
    const text = b.text ?? (b.docId ? String((await db().get<{ content: string }>('SELECT content FROM knowledge_docs WHERE id=?', b.docId))?.content ?? '') : '');
    if (!text) throw Object.assign(new Error('缺少资料文本'), { status: 400 });
    return await extractFaq(text, b.max);
  });
  app.post('/api/knowledge/faq/save', async (req, reply) => {
    const b = z.object({ faqs: z.array(z.object({ question: z.string(), answer: z.string(), tags: z.array(z.string()).default([]) })).min(1), publish: z.boolean().default(false) }).parse(req.body);
    const ids: string[] = [];
    await db().tx(async (t) => {
      for (const f of b.faqs) {
        const id = uid('faq-');
        const content = `Q：${f.question}\nA：${f.answer}`;
        await t.run('INSERT INTO knowledge_docs VALUES (?,?,?,?,?,?,?,?,?)', id, f.question.slice(0, 80), 'FAQ', J.str(f.tags), content, b.publish ? 'published' : 'draft', 1, nowIso(), 'faq');
        await rechunk(t, id, content, f.tags);
        ids.push(id);
      }
    });
    if (b.publish) await refreshIndex();
    reply.code(201);
    return { ids };
  });
  app.post('/api/knowledge/similar-questions', async (req) => {
    const b = z.object({ question: z.string().min(2).max(200), n: z.number().int().min(3).max(10).default(6) }).parse(req.body);
    return await similarQuestions(b.question, b.n);
  });
}
