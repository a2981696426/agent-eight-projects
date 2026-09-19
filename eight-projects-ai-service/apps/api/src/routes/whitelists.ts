import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { J, nowIso, openDb, uid } from '../db.ts';
import { actorOf } from '../services/auth.ts';
import { activeWhitelist, createDraft, disableWhitelist, listWhitelists, loadWhitelist, publishWhitelist, signWhitelist, whitelistFor } from '../services/whitelist.ts';

/** 白名单签发接口（CS-015 / CS-007）：写操作仅 admin（演示中同时代表售后负责人与平台管理员，记名区分） */
const audit = (actor: string, action: string, target: string, detail: unknown = null) => openDb().run('INSERT INTO audit_log VALUES (?,?,?,?,?,?)', uid('al-'), nowIso(), actor, action, target, J.str(detail));

export async function whitelistRoutes(app: FastifyInstance) {
  app.get('/api/whitelists', async (req) => {
    const q = req.query as { scope?: 'owned' | 'platform' };
    return listWhitelists(q.scope);
  });
  app.get('/api/whitelists/active', async () => {
    const [owned, platform] = await Promise.all([activeWhitelist('owned'), activeWhitelist('platform')]);
    const now = new Date();
    return { owned, platform, gates: { web: (await whitelistFor('web', now)).version, taobao: (await whitelistFor('taobao', now)).version } };
  });
  app.get('/api/whitelists/:id', async (req, reply) => {
    const w = await loadWhitelist((req.params as { id: string }).id);
    return w ?? reply.code(404).send({ error: '白名单不存在' });
  });
  app.post('/api/whitelists', async (req, reply) => {
    const b = z.object({ scope: z.enum(['owned', 'platform']), items: z.array(z.object({ scenario: z.string().min(1), maxRisk: z.enum(['L0', 'L1']).default('L1'), note: z.string().max(120).optional() })).min(1), note: z.string().max(300).default('') }).parse(req.body);
    const actor = actorOf(req, '管理员');
    const w = await createDraft(b.scope, b.items, b.note, actor);
    await audit(actor, 'whitelist.draft', w.id, { scope: b.scope, version: w.version, items: b.items });
    reply.code(201);
    return w;
  });
  app.post('/api/whitelists/:id/sign', async (req) => {
    const actor = actorOf(req, '售后负责人');
    const w = await signWhitelist((req.params as { id: string }).id, actor);
    await audit(actor, 'whitelist.sign', w.id, { scope: w.scope, version: w.version });
    return w;
  });
  app.post('/api/whitelists/:id/publish', async (req) => {
    const actor = actorOf(req, '管理员');
    const w = await publishWhitelist((req.params as { id: string }).id, actor);
    await audit(actor, 'whitelist.publish', w.id, { scope: w.scope, version: w.version });
    return w;
  });
  app.post('/api/whitelists/:id/disable', async (req) => {
    const b = z.object({ reason: z.string().max(300).default('') }).parse(req.body ?? {});
    const actor = actorOf(req, '管理员');
    const w = await disableWhitelist((req.params as { id: string }).id, actor, b.reason);
    await audit(actor, 'whitelist.disable', w.id, { scope: w.scope, version: w.version, reason: b.reason });
    return w;
  });
}
