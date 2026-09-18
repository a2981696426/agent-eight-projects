import Fastify from 'fastify';
import cors from '@fastify/cors';
import { ZodError } from 'zod';
import { LlmError } from '@eight/agent-core';
import { env } from './env.ts';
import { openDb } from './db.ts';
import { seed } from './seed.ts';
import { knowledgeIndex, llm } from './services/chain.ts';
import { conversationRoutes } from './routes/conversations.ts';
import { ticketRoutes } from './routes/tickets.ts';
import { knowledgeRoutes } from './routes/knowledge.ts';
import { agentRoutes } from './routes/agents.ts';
import { aigcRoutes } from './routes/aigc.ts';
import { botRoutes } from './routes/bots.ts';
import { managementRoutes } from './routes/management.ts';

export async function buildServer() {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
  await app.register(cors, { origin: true });

  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: '参数校验失败', issues: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    if (err instanceof LlmError) return reply.code(err.code === 'LLM_NOT_CONFIGURED' ? 503 : 502).send({ error: err.message, code: err.code });
    const e = err as { status?: number; statusCode?: number; message?: string };
    const status = e.status ?? e.statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    return reply.code(status).send({ error: e.message ?? '服务器错误' });
  });

  app.get('/api/health', async () => ({
    status: 'ok',
    product: 'eight-projects-ai-service',
    version: '0.1.0',
    llm: { configured: llm.configured, baseUrl: env.llm.baseUrl, modelFast: env.llm.modelFast, modelReasoning: env.llm.modelReasoning },
    knowledgeIndexed: knowledgeIndex().size,
    time: new Date().toISOString(),
  }));

  app.get('/api/overview', async () => {
    const db = openDb();
    const n = (sql: string) => db.get<{ n: number }>(sql)?.n ?? 0;
    return {
      conversations: n('SELECT COUNT(*) n FROM conversations'),
      waitingHuman: n("SELECT COUNT(*) n FROM conversations WHERE status='waiting_human'"),
      tickets: n("SELECT COUNT(*) n FROM tickets WHERE status NOT IN ('resolved','closed')"),
      traces: n('SELECT COUNT(*) n FROM traces'),
      knowledge: n("SELECT COUNT(*) n FROM knowledge_docs WHERE status='published'"),
      quality: n('SELECT COUNT(*) n FROM quality_results'),
      voc: n('SELECT COUNT(*) n FROM voc_items'),
      llmConfigured: llm.configured,
    };
  });

  await app.register(conversationRoutes);
  await app.register(ticketRoutes);
  await app.register(knowledgeRoutes);
  await app.register(agentRoutes);
  await app.register(aigcRoutes);
  await app.register(botRoutes);
  await app.register(managementRoutes);
  return app;
}

if (process.argv[1]?.endsWith('server.ts')) {
  openDb();
  const s = seed(false);
  const app = await buildServer();
  knowledgeIndex();
  await app.listen({ port: env.apiPort, host: '0.0.0.0' });
  app.log.info(`seeded=${s.seeded} llmConfigured=${llm.configured} knowledgeIndexed=${knowledgeIndex().size}`);
}
