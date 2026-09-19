import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ticket } from '@eight/shared';
import { J, nowIso, openDb, uid } from '../db.ts';

const db = () => openDb();
const toTicket = (r: Record<string, unknown>): Ticket => ({
  id: String(r.id),
  title: String(r.title),
  type: String(r.type),
  status: r.status as Ticket['status'],
  priority: r.priority as Ticket['priority'],
  conversationId: (r.conversation_id as string) ?? null,
  customerId: (r.customer_id as string) ?? null,
  customerName: String(r.customer_name ?? ''),
  assignee: (r.assignee as string) ?? null,
  description: String(r.description ?? ''),
  slaDueAt: String(r.sla_due_at),
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
  source: r.source as Ticket['source'],
  history: J.parse(r.history, []),
});

export async function ticketRoutes(app: FastifyInstance) {
  app.get('/api/tickets', async (req) => {
    const q = req.query as Record<string, string>;
    const where: string[] = [];
    const params: string[] = [];
    for (const k of ['status', 'priority', 'type', 'assignee']) {
      if (q[k]) {
        where.push(`${k}=?`);
        params.push(q[k]);
      }
    }
    const rows = await db().all(`SELECT * FROM tickets ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 ELSE 2 END, created_at DESC`, ...params);
    return rows.map(toTicket);
  });
  app.get('/api/tickets/stats', async () => {
    const byStatus = await db().all<{ status: string; n: number }>('SELECT status, COUNT(*) n FROM tickets GROUP BY status');
    const byPriority = await db().all<{ priority: string; n: number }>('SELECT priority, COUNT(*) n FROM tickets GROUP BY priority');
    const overdue = (await db().get<{ n: number }>("SELECT COUNT(*) n FROM tickets WHERE status NOT IN ('resolved','closed') AND sla_due_at < ?", nowIso()))?.n ?? 0;
    return { byStatus, byPriority, overdue, total: await db().count('tickets') };
  });
  app.get('/api/tickets/:id', async (req, reply) => {
    const r = await db().get('SELECT * FROM tickets WHERE id=?', (req.params as { id: string }).id);
    return r ? toTicket(r) : reply.code(404).send({ error: '工单不存在' });
  });
  app.post('/api/tickets', async (req, reply) => {
    const body = z.object({ title: z.string().min(1).max(120), type: z.string().default('其他'), priority: z.enum(['P0', 'P1', 'P2']).default('P2'), description: z.string().max(2000).default(''), customerId: z.string().nullable().default(null), conversationId: z.string().nullable().default(null), assignee: z.string().nullable().default(null), actor: z.string().default('坐席') }).parse(req.body);
    const now = nowIso();
    const hours = { P0: 2, P1: 8, P2: 24 }[body.priority];
    const id = `TK-${now.slice(0, 10).replace(/-/g, '')}-${uid().slice(0, 4).toUpperCase()}`;
    const cust = body.customerId ? await db().get<{ name: string }>('SELECT name FROM customers WHERE id=?', body.customerId) : null;
    await db().run('INSERT INTO tickets VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id, body.title, body.type, 'open', body.priority, body.conversationId, body.customerId, cust?.name ?? '—', body.assignee, body.description, new Date(Date.now() + hours * 3600e3).toISOString(), now, now, 'manual', J.str([{ at: now, by: body.actor, action: '创建工单' }]));
    reply.code(201);
    return toTicket((await db().get('SELECT * FROM tickets WHERE id=?', id))!);
  });
  app.patch('/api/tickets/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ status: z.enum(['open', 'processing', 'pending', 'resolved', 'closed']).optional(), assignee: z.string().nullable().optional(), priority: z.enum(['P0', 'P1', 'P2']).optional(), note: z.string().max(1000).default(''), actor: z.string().default('坐席') }).parse(req.body);
    const r = await db().get('SELECT * FROM tickets WHERE id=?', id);
    if (!r) return reply.code(404).send({ error: '工单不存在' });
    const t = toTicket(r);
    const now = nowIso();
    const actions: string[] = [];
    if (body.status && body.status !== t.status) actions.push(`状态 ${t.status} → ${body.status}`);
    if (body.assignee !== undefined && body.assignee !== t.assignee) actions.push(`转派给 ${body.assignee ?? '未分配'}`);
    if (body.priority && body.priority !== t.priority) actions.push(`优先级 ${t.priority} → ${body.priority}`);
    if (!actions.length && !body.note) return t;
    t.history.push({ at: now, by: body.actor, action: actions.join('；') || '备注', note: body.note || undefined });
    await db().run('UPDATE tickets SET status=?, assignee=?, priority=?, updated_at=?, history=? WHERE id=?', body.status ?? t.status, body.assignee === undefined ? t.assignee : body.assignee, body.priority ?? t.priority, now, J.str(t.history), id);
    return toTicket((await db().get('SELECT * FROM tickets WHERE id=?', id))!);
  });
}
