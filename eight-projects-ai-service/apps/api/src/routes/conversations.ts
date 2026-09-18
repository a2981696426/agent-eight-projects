import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ticket } from '@eight/shared';
import { J, nowIso, openDb, uid } from '../db.ts';
import { appendMessage, loadCustomer, loadMessages, loadTrace, rowToConversation, runForConversation } from '../services/chain.ts';
import { classify, summarize } from '../services/aigc.ts';

const db = () => openDb();
const audit = (actor: string, action: string, target: string, detail: unknown = null) => db().run('INSERT INTO audit_log VALUES (?,?,?,?,?,?)', uid('al-'), nowIso(), actor, action, target, J.str(detail));

export async function conversationRoutes(app: FastifyInstance) {
  app.get('/api/conversations', async (req) => {
    const q = req.query as Record<string, string>;
    const where: string[] = [];
    const params: string[] = [];
    if (q.status) {
      where.push('status=?');
      params.push(q.status);
    }
    if (q.controller) {
      where.push('controller=?');
      params.push(q.controller);
    }
    if (q.channel) {
      where.push('channel=?');
      params.push(q.channel);
    }
    const rows = db().all(`SELECT * FROM conversations ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY CASE status WHEN 'waiting_human' THEN 0 WHEN 'open' THEN 1 ELSE 2 END, last_message_at DESC LIMIT 200`, ...params);
    return rows.map(rowToConversation);
  });

  app.post('/api/conversations', async (req, reply) => {
    const body = z.object({ channel: z.string().default('web'), customerId: z.string().nullable().default(null), title: z.string().max(120).default('新会话'), mode: z.enum(['bot', 'human']).default('bot') }).parse(req.body ?? {});
    let customerId = body.customerId;
    if (!customerId) {
      customerId = uid('cust-');
      db().run('INSERT INTO customers VALUES (?,?,?,?,?,?,?)', customerId, `访客${customerId.slice(-4)}`, '', 'normal', body.channel, J.str(['新访客']), '');
    }
    const id = uid('conv-');
    const now = nowIso();
    db().run('INSERT INTO conversations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id, body.title, body.channel, customerId, 'open', body.mode, null, null, null, now, now, null, 'agent-cs-main', null);
    audit('system', 'conversation.create', id, body);
    reply.code(201);
    return rowToConversation(db().get('SELECT * FROM conversations WHERE id=?', id)!);
  });

  app.get('/api/conversations/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db().get('SELECT * FROM conversations WHERE id=?', id);
    if (!row) return reply.code(404).send({ error: '会话不存在' });
    const conversation = rowToConversation(row);
    const messages = loadMessages(id);
    const customer = loadCustomer(conversation.customerId);
    const orders = customer ? db().all('SELECT id, product, status, paid_amount, created_at FROM orders WHERE customer_id=? ORDER BY created_at DESC', customer.id) : [];
    const traces = db().all<{ id: string; created_at: string; scenario: string; intent: string; decision: string; risk_level: string; duration_ms: number; status: string }>('SELECT id, created_at, scenario, intent, decision, risk_level, duration_ms, status FROM traces WHERE conversation_id=? ORDER BY created_at DESC', id);
    const tickets = db().all('SELECT id, title, status, priority FROM tickets WHERE conversation_id=?', id);
    return { conversation, messages, customer, orders, traces, tickets };
  });

  /** 发送消息：user 消息在机器人接待时触发执行链；agent 消息由坐席发送 */
  app.post('/api/conversations/:id/messages', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ role: z.enum(['user', 'agent']), text: z.string().min(1).max(4000) }).parse(req.body);
    const row = db().get('SELECT * FROM conversations WHERE id=?', id);
    if (!row) return reply.code(404).send({ error: '会话不存在' });
    if (row.status === 'closed') return reply.code(409).send({ error: '会话已结束，请先重新打开' });
    if (body.role === 'agent') {
      if (row.controller === 'bot') return reply.code(409).send({ error: '当前由机器人接待，请先接管再回复', code: 'TAKEOVER_REQUIRED' });
      const m = appendMessage(id, 'agent', body.text);
      db().run("UPDATE conversations SET status='open' WHERE id=? AND status='waiting_human'", id);
      return { message: m, conversation: rowToConversation(db().get('SELECT * FROM conversations WHERE id=?', id)!) };
    }
    if (row.controller !== 'bot') {
      const m = appendMessage(id, 'user', body.text);
      return { message: m, conversation: rowToConversation(db().get('SELECT * FROM conversations WHERE id=?', id)!), trace: null };
    }
    const r = await runForConversation(id, body.text, { mode: 'bot' });
    return { message: r.userMessage, botMessage: r.botMessage, trace: r.trace, conversation: r.conversation };
  });

  /** 坐席辅助：基于最后一条用户消息生成建议（不落库为消息） */
  app.post('/api/conversations/:id/assist', async (req, reply) => {
    const { id } = req.params as { id: string };
    const msgs = loadMessages(id);
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
    if (!lastUser) return reply.code(400).send({ error: '会话中没有用户消息' });
    // 辅助模式：把最后一条用户消息之前的历史作为上下文重跑一次链
    const r = await runForConversation(id, lastUser.text, { mode: 'assist', persistUserMessage: false });
    return { trace: r.trace, suggestion: r.trace.reply };
  });

  app.post('/api/conversations/:id/control', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ action: z.enum(['takeover', 'robot', 'close', 'reopen', 'handoff']), actor: z.string().default('坐席'), reason: z.string().max(300).default('') }).parse(req.body);
    const row = db().get('SELECT * FROM conversations WHERE id=?', id);
    if (!row) return reply.code(404).send({ error: '会话不存在' });
    const patch: Record<string, unknown> = {};
    if (body.action === 'takeover') Object.assign(patch, { controller: 'human', status: 'open', assignee: body.actor });
    if (body.action === 'robot') Object.assign(patch, { controller: 'bot', status: 'open', assignee: null });
    if (body.action === 'close') Object.assign(patch, { status: 'closed' });
    if (body.action === 'reopen') Object.assign(patch, { status: 'open' });
    if (body.action === 'handoff') Object.assign(patch, { controller: 'human', status: 'waiting_human', assignee: null, priority: row.priority ?? 'P2' });
    const keys = Object.keys(patch);
    db().run(`UPDATE conversations SET ${keys.map((k) => `${k}=?`).join(', ')} WHERE id=?`, ...(keys.map((k) => patch[k]) as (string | null)[]), id);
    appendMessage(id, 'system', `【${{ takeover: '人工接管', robot: '转回机器人', close: '会话结束', reopen: '重新打开', handoff: '转人工排队' }[body.action]}】${body.actor}${body.reason ? `：${body.reason}` : ''}`, { meta: { internal: true } });
    audit(body.actor, `conversation.${body.action}`, id, body);
    return rowToConversation(db().get('SELECT * FROM conversations WHERE id=?', id)!);
  });

  app.post('/api/conversations/:id/summary', async (req) => {
    const { id } = req.params as { id: string };
    const s = await summarize(id);
    const text = `问题：${s.problem}\n处理：${s.handling}\n结果：${s.outcome}${s.followUp ? `\n跟进：${s.followUp}` : ''}`;
    db().run('UPDATE conversations SET summary=? WHERE id=?', text, id);
    return s;
  });

  app.post('/api/conversations/:id/classify', async (req) => classify((req.params as { id: string }).id));

  app.post('/api/conversations/:id/ticket', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ title: z.string().min(1).max(120), type: z.string().default('其他'), priority: z.enum(['P0', 'P1', 'P2']).default('P2'), description: z.string().max(2000).default(''), assignee: z.string().nullable().default(null), actor: z.string().default('坐席') }).parse(req.body);
    const row = db().get('SELECT * FROM conversations WHERE id=?', id);
    if (!row) return reply.code(404).send({ error: '会话不存在' });
    const cust = db().get<{ name: string }>('SELECT name FROM customers WHERE id=?', String(row.customer_id));
    const now = nowIso();
    const hours = { P0: 2, P1: 8, P2: 24 }[body.priority];
    const tid = `TK-${now.slice(0, 10).replace(/-/g, '')}-${uid().slice(0, 4).toUpperCase()}`;
    const ticket: Ticket = { id: tid, title: body.title, type: body.type, status: 'open', priority: body.priority, conversationId: id, customerId: String(row.customer_id), customerName: cust?.name ?? '未知', assignee: body.assignee, description: body.description, slaDueAt: new Date(Date.now() + hours * 3600e3).toISOString(), createdAt: now, updatedAt: now, source: 'agent', history: [{ at: now, by: body.actor, action: '从会话创建工单' }] };
    db().run('INSERT INTO tickets VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', ticket.id, ticket.title, ticket.type, ticket.status, ticket.priority, ticket.conversationId, ticket.customerId, ticket.customerName, ticket.assignee, ticket.description, ticket.slaDueAt, ticket.createdAt, ticket.updatedAt, ticket.source, J.str(ticket.history));
    appendMessage(id, 'system', `【已创建工单 ${tid}】${body.title}`, { meta: { internal: true, ticketId: tid } });
    audit(body.actor, 'ticket.create', tid, { conversationId: id });
    reply.code(201);
    return ticket;
  });

  app.get('/api/customers', async () => db().all('SELECT * FROM customers ORDER BY name').map((c) => ({ ...c, tags: J.parse(c.tags, []) })));
  app.get('/api/customers/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const c = loadCustomer(id);
    if (!c) return reply.code(404).send({ error: '客户不存在' });
    const orders = db().all('SELECT * FROM orders WHERE customer_id=? ORDER BY created_at DESC', id).map((o) => ({
      ...o,
      logistics: db().get('SELECT * FROM logistics WHERE order_id=?', String(o.id)) ?? null,
      invoice: db().get('SELECT * FROM invoices WHERE order_id=?', String(o.id)) ?? null,
      refunds: db().all('SELECT * FROM refunds WHERE order_id=?', String(o.id)),
    }));
    const conversations = db().all('SELECT * FROM conversations WHERE customer_id=? ORDER BY last_message_at DESC', id).map(rowToConversation);
    return { customer: c, orders, conversations };
  });

  app.get('/api/traces', async (req) => {
    const q = req.query as Record<string, string>;
    const limit = Math.min(200, Number(q.limit ?? 50));
    return db().all('SELECT id, conversation_id, agent_id, agent_version, created_at, scenario, intent, decision, risk_level, duration_ms, status FROM traces ORDER BY created_at DESC LIMIT ?', limit);
  });
  app.get('/api/traces/:id', async (req, reply) => {
    const t = loadTrace((req.params as { id: string }).id);
    return t ?? reply.code(404).send({ error: 'trace 不存在' });
  });
  app.get('/api/audit', async () => db().all('SELECT * FROM audit_log ORDER BY at DESC LIMIT 200').map((a) => ({ ...a, detail: J.parse(a.detail, null) })));
}
