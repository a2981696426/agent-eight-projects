import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { J, openDb } from '../db.ts';
import { loadAgent, loadMessages } from '../services/chain.ts';
import { classify, extractFaq, extractTicket, rewrite, similarQuestions, summarize } from '../services/aigc.ts';
import { llm } from '../services/chain.ts';

const db = () => openDb();

export async function aigcRoutes(app: FastifyInstance) {
  app.get('/api/aigc/capabilities', async () => [
    { id: 'summary', name: '会话小记', desc: '3~5 秒生成问题/处理/结果/跟进', input: 'conversationId' },
    { id: 'classify', name: '智能会话分类', desc: '三级分类 + 情绪 + 紧急度', input: 'conversationId' },
    { id: 'ticket-extract', name: '智能生成工单', desc: '从会话抽取工单字段', input: 'conversationId' },
    { id: 'reply-suggest', name: '应答建议', desc: '基于上下文与知识给出金牌应答', input: 'conversationId' },
    { id: 'rewrite', name: '话术润色', desc: '按角色风格扩写/润色，不新增事实', input: 'text' },
    { id: 'faq-extract', name: '文档抽取问答对', desc: '从资料抽取 FAQ 并可入库', input: 'text' },
    { id: 'similar-questions', name: '相似问生成', desc: '为标准问批量生成相似问', input: 'text' },
  ]);
  app.get('/api/aigc/jobs', async (req) => {
    const q = req.query as Record<string, string>;
    const jobs = await db().all(`SELECT * FROM aigc_jobs ${q.capability ? 'WHERE capability=?' : ''} ORDER BY created_at DESC LIMIT 100`, ...(q.capability ? [q.capability] : []));
    return jobs.map((j) => ({ ...j, input: J.parse(j.input, null), output: J.parse(j.output, null), usage: J.parse(j.usage, null) }));
  });
  app.post('/api/aigc/:capability', async (req, reply) => {
    const { capability } = req.params as { capability: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    switch (capability) {
      case 'summary':
        return await summarize(z.string().parse(body.conversationId));
      case 'classify':
        return await classify(z.string().parse(body.conversationId));
      case 'ticket-extract':
        return await extractTicket(z.string().parse(body.conversationId));
      case 'rewrite':
        return await rewrite(z.string().min(1).parse(body.text), String(body.style ?? '更亲切、更简洁'), (await loadAgent()).persona);
      case 'faq-extract':
        return await extractFaq(z.string().min(20).parse(body.text), Number(body.max ?? 8));
      case 'similar-questions':
        return await similarQuestions(z.string().min(2).parse(body.question ?? body.text), Number(body.n ?? 6));
      case 'reply-suggest': {
        const conversationId = z.string().parse(body.conversationId);
        const msgs = await loadMessages(conversationId);
        const { knowledgeIndex } = await import('../services/chain.ts');
        const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
        const hits = lastUser ? await knowledgeIndex().search(lastUser.text, { topK: 4 }) : [];
        const Schema = z.object({ suggestions: z.array(z.object({ text: z.string(), basis: z.string() })).min(1).max(3) });
        const r = await llm.chatJson(Schema, [
          { role: 'system', content: `${(await loadAgent()).persona}\n根据对话与知识给出 1~3 条可直接发送的应答建议，每条附依据(basis)。不得承诺退款/赔付结果，没有知识支撑的事实不要写。只输出 JSON。` },
          { role: 'user', content: `知识：\n${hits.map((h) => `- 《${h.docTitle}》${h.text}`).join('\n') || '无'}\n\n对话：\n${msgs.filter((m) => m.role !== 'system').map((m) => `[${m.role}] ${m.text}`).join('\n')}` },
        ]);
        return { ...r.value, knowledge: hits, usage: r.usage };
      }
      default:
        return reply.code(404).send({ error: `未知能力 ${capability}` });
    }
  });
}
