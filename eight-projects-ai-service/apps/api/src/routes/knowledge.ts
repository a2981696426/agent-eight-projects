import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { chunkText } from '@eight/agent-core';
import type { KnowledgeDoc } from '@eight/shared';
import { J, nowIso, openDb, uid } from '../db.ts';
import { knowledgeIndex, refreshIndex } from '../services/chain.ts';
import { extractFaq, similarQuestions } from '../services/aigc.ts';

const db = () => openDb();
const toDoc = (r: Record<string, unknown>): KnowledgeDoc => ({
  id: String(r.id),
  title: String(r.title),
  category: String(r.category ?? ''),
  tags: J.parse(r.tags, []),
  content: String(r.content ?? ''),
  status: r.status as KnowledgeDoc['status'],
  version: Number(r.version ?? 1),
  chunkCount: db().get<{ n: number }>('SELECT COUNT(*) n FROM knowledge_chunks WHERE doc_id=?', String(r.id))?.n ?? 0,
  updatedAt: String(r.updated_at),
  source: (r.source as KnowledgeDoc['source']) ?? 'manual',
});

function rechunk(docId: string, content: string, tags: string[]) {
  db().run('DELETE FROM knowledge_chunks WHERE doc_id=?', docId);
  chunkText(content).forEach((text, i) => db().run('INSERT INTO knowledge_chunks VALUES (?,?,?,?,?)', `${docId}-c${i + 1}`, docId, i + 1, text, J.str(tags)));
}

export async function knowledgeRoutes(app: FastifyInstance) {
  app.get('/api/knowledge/docs', async (req) => {
    const q = req.query as Record<string, string>;
    const rows = db().all(`SELECT * FROM knowledge_docs ${q.status ? 'WHERE status=?' : ''} ORDER BY updated_at DESC`, ...(q.status ? [q.status] : []));
    return rows.map((r) => ({ ...toDoc(r), content: undefined }));
  });
  app.get('/api/knowledge/stats', async () => ({
    docs: db().count('knowledge_docs'),
    published: db().get<{ n: number }>("SELECT COUNT(*) n FROM knowledge_docs WHERE status='published'")?.n ?? 0,
    chunks: db().count('knowledge_chunks'),
    indexed: knowledgeIndex().size,
    categories: db().all<{ category: string; n: number }>('SELECT category, COUNT(*) n FROM knowledge_docs GROUP BY category ORDER BY n DESC'),
  }));
  app.get('/api/knowledge/docs/:id', async (req, reply) => {
    const r = db().get('SELECT * FROM knowledge_docs WHERE id=?', (req.params as { id: string }).id);
    if (!r) return reply.code(404).send({ error: '文档不存在' });
    const chunks = db().all('SELECT * FROM knowledge_chunks WHERE doc_id=? ORDER BY seq', String(r.id)).map((c) => ({ ...c, tags: J.parse(c.tags, []) }));
    const usage = db().all<{ id: string; created_at: string; scenario: string; doc: string }>('SELECT id, created_at, scenario, doc FROM traces ORDER BY created_at DESC LIMIT 300').filter((t) => t.doc.includes(`"kb:${r.id}-c`)).map((t) => ({ traceId: t.id, at: t.created_at, scenario: t.scenario }));
    return { doc: toDoc(r), chunks, usage: usage.slice(0, 30), usageCount: usage.length };
  });
  const DocBody = z.object({ title: z.string().min(1).max(120), category: z.string().max(40).default('未分类'), tags: z.array(z.string().max(20)).max(10).default([]), content: z.string().min(1).max(60000), source: z.enum(['manual', 'import', 'faq', 'conversation']).default('manual') });
  app.post('/api/knowledge/docs', async (req, reply) => {
    const b = DocBody.parse(req.body);
    const id = uid('kb-');
    db().run('INSERT INTO knowledge_docs VALUES (?,?,?,?,?,?,?,?,?)', id, b.title, b.category, J.str(b.tags), b.content, 'draft', 1, nowIso(), b.source);
    rechunk(id, b.content, b.tags);
    reply.code(201);
    return toDoc(db().get('SELECT * FROM knowledge_docs WHERE id=?', id)!);
  });
  app.put('/api/knowledge/docs/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = DocBody.partial().parse(req.body);
    const r = db().get('SELECT * FROM knowledge_docs WHERE id=?', id);
    if (!r) return reply.code(404).send({ error: '文档不存在' });
    const doc = toDoc(r);
    const next = { ...doc, ...b, tags: b.tags ?? doc.tags };
    const contentChanged = b.content !== undefined && b.content !== doc.content;
    db().run('UPDATE knowledge_docs SET title=?, category=?, tags=?, content=?, version=?, updated_at=?, status=? WHERE id=?', next.title, next.category, J.str(next.tags), next.content, contentChanged ? doc.version + 1 : doc.version, nowIso(), contentChanged ? 'draft' : doc.status, id);
    if (contentChanged || b.tags) rechunk(id, next.content, next.tags);
    if (doc.status === 'published') refreshIndex();
    return toDoc(db().get('SELECT * FROM knowledge_docs WHERE id=?', id)!);
  });
  app.post('/api/knowledge/docs/:id/publish', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = z.object({ action: z.enum(['publish', 'unpublish']).default('publish') }).parse(req.body ?? {});
    if (!db().get('SELECT id FROM knowledge_docs WHERE id=?', id)) return reply.code(404).send({ error: '文档不存在' });
    db().run('UPDATE knowledge_docs SET status=?, updated_at=? WHERE id=?', b.action === 'publish' ? 'published' : 'draft', nowIso(), id);
    const indexed = refreshIndex();
    return { doc: toDoc(db().get('SELECT * FROM knowledge_docs WHERE id=?', id)!), indexed };
  });
  app.delete('/api/knowledge/docs/:id', async (req) => {
    const { id } = req.params as { id: string };
    db().run('DELETE FROM knowledge_chunks WHERE doc_id=?', id);
    db().run('DELETE FROM knowledge_docs WHERE id=?', id);
    refreshIndex();
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
    db().tx(() => {
      for (const p of parts) {
        const firstLine = p.split('\n')[0].replace(/^#+\s*/, '').slice(0, 80);
        const id = uid('kb-');
        db().run('INSERT INTO knowledge_docs VALUES (?,?,?,?,?,?,?,?,?)', id, firstLine || '未命名资料', b.category, J.str(b.tags), p, b.publish ? 'published' : 'draft', 1, nowIso(), 'import');
        rechunk(id, p, b.tags);
        created.push(id);
      }
    });
    if (b.publish) refreshIndex();
    return { created: created.length, ids: created };
  });
  app.post('/api/knowledge/faq-extract', async (req) => {
    const b = z.object({ text: z.string().min(20).max(20000).optional(), docId: z.string().optional(), max: z.number().int().min(1).max(20).default(8) }).parse(req.body);
    const text = b.text ?? (b.docId ? String(db().get<{ content: string }>('SELECT content FROM knowledge_docs WHERE id=?', b.docId)?.content ?? '') : '');
    if (!text) throw Object.assign(new Error('缺少资料文本'), { status: 400 });
    return extractFaq(text, b.max);
  });
  app.post('/api/knowledge/faq/save', async (req, reply) => {
    const b = z.object({ faqs: z.array(z.object({ question: z.string(), answer: z.string(), tags: z.array(z.string()).default([]) })).min(1), publish: z.boolean().default(false) }).parse(req.body);
    const ids: string[] = [];
    db().tx(() => {
      for (const f of b.faqs) {
        const id = uid('faq-');
        const content = `Q：${f.question}\nA：${f.answer}`;
        db().run('INSERT INTO knowledge_docs VALUES (?,?,?,?,?,?,?,?,?)', id, f.question.slice(0, 80), 'FAQ', J.str(f.tags), content, b.publish ? 'published' : 'draft', 1, nowIso(), 'faq');
        rechunk(id, content, f.tags);
        ids.push(id);
      }
    });
    if (b.publish) refreshIndex();
    reply.code(201);
    return { ids };
  });
  app.post('/api/knowledge/similar-questions', async (req) => {
    const b = z.object({ question: z.string().min(2).max(200), n: z.number().int().min(3).max(10).default(6) }).parse(req.body);
    return similarQuestions(b.question, b.n);
  });
}
