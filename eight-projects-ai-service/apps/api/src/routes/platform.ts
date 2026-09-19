import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { J, nowIso, openDb, uid } from '../db.ts';
import { actorOf } from '../services/auth.ts';
import { platformSource } from '../services/chain.ts';
import { PlatformUnavailable, TmallSandboxSource, detectPlatformOrder } from '../services/platform-data.ts';

/** 电商平台只读数据接口（CS-018）：状态 / 沙箱模拟（admin）/ 按订单号汇总查询（坐席） */
export async function platformRoutes(app: FastifyInstance) {
  app.get('/api/platform/status', async () => {
    if (!platformSource) return { platforms: [{ platform: 'tmall', mode: 'off', ok: false, detail: 'TAOBAO_MODE=off 或 live 缺配置' }] };
    const h = await platformSource.health();
    return { platforms: [{ platform: platformSource.platform, mode: platformSource.mode, ok: h.ok, detail: h.detail, sampleOrderIds: platformSource instanceof TmallSandboxSource ? TmallSandboxSource.sampleOrderIds() : [], simulation: platformSource instanceof TmallSandboxSource ? platformSource.simulation : null }] };
  });

  app.post('/api/platform/tmall/simulate', async (req, reply) => {
    const b = z.object({ mode: z.enum(['normal', 'unavailable', 'auth_expired', 'rate_limited']) }).parse(req.body);
    if (!(platformSource instanceof TmallSandboxSource)) return reply.code(400).send({ error: '只有沙箱模式支持故障模拟' });
    platformSource.simulate(b.mode);
    await openDb().run('INSERT INTO audit_log VALUES (?,?,?,?,?,?)', uid('al-'), nowIso(), actorOf(req, '管理员'), 'platform.simulate', 'tmall', J.str(b));
    return { ok: true, mode: b.mode };
  });

  app.get('/api/platform/tmall/orders/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!platformSource) return reply.code(503).send({ error: '平台数据源未启用' });
    if (!detectPlatformOrder(id)) return reply.code(400).send({ error: '不是电商平台订单号（需 16~19 位数字）' });
    try {
      const [order, logistics, refunds] = await Promise.all([platformSource.getOrder(id), platformSource.getLogistics(id), platformSource.getRefunds(id)]);
      if (!order) return reply.code(404).send({ error: '平台未查到该订单' });
      return { order, logistics, refunds, source: `${platformSource.platform}-${platformSource.mode}` };
    } catch (e) {
      if (e instanceof PlatformUnavailable) return reply.code(502).send({ error: `平台数据暂不可用（${e.kind}）`, detail: e.message });
      throw e;
    }
  });
}
