import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { IvrFlow, IvrNode, OutboundCampaign } from '@eight/shared';
import { J, nowIso, openDb, uid } from '../db.ts';
import { runStandalone } from '../services/chain.ts';
import { simulateOutbound } from '../services/aigc.ts';

const db = () => openDb();

export async function botRoutes(app: FastifyInstance) {
  /* ───── 呼入机器人（IVR 流程） ───── */
  app.get('/api/ivr/flows', async () => db().all<{ doc: string }>('SELECT doc FROM ivr_flows ORDER BY updated_at DESC').map((r) => J.parse<IvrFlow>(r.doc, null as unknown as IvrFlow)));
  app.put('/api/ivr/flows/:id', async (req) => {
    const { id } = req.params as { id: string };
    const NodeSchema = z.object({ id: z.string(), type: z.enum(['play', 'menu', 'collect', 'transfer', 'end']), text: z.string(), options: z.array(z.object({ key: z.string(), label: z.string(), next: z.string() })).optional(), next: z.string().optional(), slot: z.string().optional() });
    const b = z.object({ name: z.string().min(1), status: z.enum(['draft', 'published']), entry: z.string(), nodes: z.array(NodeSchema).min(1) }).parse(req.body);
    const flow: IvrFlow = { id, ...b, updatedAt: nowIso() };
    db().run('INSERT OR REPLACE INTO ivr_flows VALUES (?,?,?)', id, J.str(flow), flow.updatedAt);
    return flow;
  });
  /** 文本模式模拟一次来电：按输入序列走流程，collect 到订单号后接入执行链 */
  app.post('/api/ivr/flows/:id/simulate', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = z.object({ inputs: z.array(z.string()).default([]), customerId: z.string().nullable().default(null), useChain: z.boolean().default(true) }).parse(req.body ?? {});
    const row = db().get<{ doc: string }>('SELECT doc FROM ivr_flows WHERE id=?', id);
    if (!row) return reply.code(404).send({ error: '流程不存在' });
    const flow = J.parse<IvrFlow>(row.doc, null as unknown as IvrFlow);
    const nodes = new Map(flow.nodes.map((n) => [n.id, n]));
    const log: { node: string; type: IvrNode['type']; say: string; input?: string; chainTraceId?: string }[] = [];
    const slots: Record<string, string> = {};
    let cur: IvrNode | undefined = nodes.get(flow.entry);
    let menuChoice = '';
    const inputs = [...b.inputs];
    let guard = 0;
    while (cur && guard++ < 30) {
      const entry: (typeof log)[number] = { node: cur.id, type: cur.type, say: cur.text };
      if (cur.type === 'menu') {
        const input = inputs.shift();
        entry.input = input;
        const opt = cur.options?.find((o) => o.key === input);
        if (!opt) {
          entry.say += input === undefined ? '（等待按键，模拟结束）' : `（无效按键 ${input}）`;
          log.push(entry);
          break;
        }
        menuChoice = opt.label;
        log.push(entry);
        cur = nodes.get(opt.next);
        continue;
      }
      if (cur.type === 'collect') {
        const input = inputs.shift();
        entry.input = input;
        if (input === undefined) {
          entry.say += '（等待输入，模拟结束）';
          log.push(entry);
          break;
        }
        if (cur.slot) slots[cur.slot] = input.replace(/#$/, '');
        log.push(entry);
        cur = cur.next ? nodes.get(cur.next) : undefined;
        continue;
      }
      if (cur.type === 'play' && cur.id === 'lookup' && b.useChain && slots.orderId) {
        const text = `${menuChoice}问题，订单号 ${slots.orderId}`;
        const t = await runStandalone(text, { customerId: b.customerId, channel: 'phone' });
        entry.say = t.reply?.text ?? '（执行链无返回）';
        entry.chainTraceId = t.id;
        log.push(entry);
        cur = cur.next ? nodes.get(cur.next) : undefined;
        continue;
      }
      log.push(entry);
      if (cur.type === 'end' || cur.type === 'transfer') break;
      cur = cur.next ? nodes.get(cur.next) : undefined;
    }
    return { flow: flow.name, slots, log, remainingInputs: inputs };
  });

  /* ───── AI 外呼 ───── */
  app.get('/api/outbound/campaigns', async () => db().all<{ doc: string }>('SELECT doc FROM campaigns ORDER BY created_at DESC').map((r) => J.parse<OutboundCampaign>(r.doc, null as unknown as OutboundCampaign)));
  app.post('/api/outbound/campaigns', async (req, reply) => {
    const b = z.object({ name: z.string().min(1).max(80), goal: z.string().min(1).max(300), script: z.string().min(1).max(2000), contacts: z.array(z.object({ name: z.string(), phone: z.string() })).min(1).max(200) }).parse(req.body);
    const c: OutboundCampaign = { id: uid('camp-'), ...b, status: 'draft', stats: { total: b.contacts.length, connected: 0, interested: 0, refused: 0 }, createdAt: nowIso() };
    db().run('INSERT INTO campaigns VALUES (?,?,?)', c.id, J.str(c), c.createdAt);
    reply.code(201);
    return c;
  });
  app.post('/api/outbound/campaigns/:id/run', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db().get<{ doc: string }>('SELECT doc FROM campaigns WHERE id=?', id);
    if (!row) return reply.code(404).send({ error: '任务不存在' });
    const c = J.parse<OutboundCampaign>(row.doc, null as unknown as OutboundCampaign);
    const results = await simulateOutbound(c.script, c.goal, c.contacts);
    const byName = new Map(results.map((r) => [r.name, r]));
    c.contacts = c.contacts.map((ct) => {
      const r = byName.get(ct.name);
      return r ? { ...ct, result: r.result, summary: r.summary } : { ...ct, result: 'no_answer', summary: '未接通' };
    });
    c.stats = {
      total: c.contacts.length,
      connected: c.contacts.filter((x) => x.result?.startsWith('connected')).length,
      interested: c.contacts.filter((x) => x.result === 'connected_interested').length,
      refused: c.contacts.filter((x) => x.result === 'connected_refused').length,
    };
    c.status = 'finished';
    db().run('UPDATE campaigns SET doc=? WHERE id=?', J.str(c), id);
    return { ...c, simulated: true };
  });
}
