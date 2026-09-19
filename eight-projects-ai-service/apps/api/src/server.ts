import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { ZodError } from 'zod';
import { LlmError } from '@eight/agent-core';
import { env } from './env.ts';
import { initDb, openDb } from './db.ts';
import { seed } from './seed.ts';
import { knowledgeIndex, llm, refreshIndex } from './services/chain.ts';
import { installAuth, seedUsers } from './services/auth.ts';
import { jobsStatus, startJobs, stopJobs } from './services/jobs.ts';
import { channelStatus } from './services/channels.ts';
import { conversationRoutes } from './routes/conversations.ts';
import { caseRoutes } from './routes/cases.ts';
import { knowledgeRoutes } from './routes/knowledge.ts';
import { agentRoutes } from './routes/agents.ts';
import { aigcRoutes } from './routes/aigc.ts';
import { botRoutes } from './routes/bots.ts';
import { managementRoutes } from './routes/management.ts';

export const VERSION = '0.3.0';

export async function buildServer() {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
  await app.register(cors, { origin: true, credentials: true });
  await app.register(cookie, { secret: env.sessionSecret });

  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: '参数校验失败', issues: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    if (err instanceof LlmError) return reply.code(err.code === 'LLM_NOT_CONFIGURED' ? 503 : 502).send({ error: err.message, code: err.code });
    const e = err as { status?: number; statusCode?: number; message?: string };
    const status = e.status ?? e.statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    return reply.code(status).send({ error: e.message ?? '服务器错误' });
  });

  await seedUsers();
  installAuth(app);

  app.get('/api/health', async () => ({
    status: 'ok',
    product: 'eight-projects-ai-service',
    version: VERSION,
    mode: env.serveWeb ? 'production' : 'development',
    llm: {
      configured: llm.configured,
      mock: env.llmMock,
      baseUrl: env.llm.baseUrl,
      modelFast: env.llm.modelFast,
      modelReasoning: env.llm.modelReasoning,
      providers: llm.status().map((p) => ({ id: p.id, circuit: p.circuit, configured: p.configured, simulatedDown: p.simulatedDown, calls: p.stats.calls, failures: p.stats.failures, avgMs: p.stats.avgMs })),
    },
    knowledgeIndexed: knowledgeIndex().size,
    db: openDb().kind,
    jobs: jobsStatus(),
    channels: await channelStatus(),
    time: new Date().toISOString(),
  }));

  app.get('/api/overview', async () => {
    const db = openDb();
    const n = async (sql: string) => (await db.get<{ n: number }>(sql))?.n ?? 0;
    return {
      conversations: await n('SELECT COUNT(*) n FROM conversations'),
      waitingHuman: await n("SELECT COUNT(*) n FROM conversations WHERE status='waiting_human'"),
      cases: await n("SELECT COUNT(*) n FROM cases WHERE status <> 'archived'"),
      handoffsPending: await n("SELECT COUNT(*) n FROM handoff_tasks WHERE status='pending'"),
      traces: await n('SELECT COUNT(*) n FROM traces'),
      knowledge: await n("SELECT COUNT(*) n FROM knowledge_docs WHERE status='published'"),
      quality: await n('SELECT COUNT(*) n FROM quality_results'),
      voc: await n('SELECT COUNT(*) n FROM voc_items'),
      degraded: await n('SELECT COUNT(*) n FROM traces WHERE degraded=1'),
      llmConfigured: llm.configured,
    };
  });

  await app.register(conversationRoutes);
  await app.register(caseRoutes);
  await app.register(knowledgeRoutes);
  await app.register(agentRoutes);
  await app.register(aigcRoutes);
  await app.register(botRoutes);
  await app.register(managementRoutes);

  // 生产模式：托管前端构建产物，非 /api 路由回退到 index.html（SPA）
  if (env.serveWeb) {
    if (!existsSync(env.webDist)) app.log.warn(`SERVE_WEB 已开启但未找到 ${env.webDist}，请先执行 pnpm build`);
    else {
      await app.register(fastifyStatic, { root: env.webDist, prefix: '/', wildcard: false, index: ['index.html'], cacheControl: true, maxAge: '1h', immutable: false });
      app.setNotFoundHandler((req, reply) => {
        if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.header('cache-control', 'no-cache').sendFile('index.html');
        return reply.code(404).send({ error: 'Not Found' });
      });
    }
  }
  return app;
}

if (process.argv[1]?.endsWith('server.ts')) {
  await initDb();
  const s = await seed(false);
  const app = await buildServer();
  await refreshIndex();
  await startJobs();
  app.addHook('onClose', async () => stopJobs());
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => void app.close().then(() => process.exit(0)));
  await app.listen({ port: env.apiPort, host: '0.0.0.0' });
  app.log.info(`version=${VERSION} db=${openDb().kind} jobs=${jobsStatus().backend} mode=${env.serveWeb ? 'production(serve web)' : 'development'} seeded=${s.seeded} llmConfigured=${llm.configured} providers=${llm.status().map((p) => p.id).join(',')} knowledgeIndexed=${knowledgeIndex().size}`);
}
