import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { J, nowIso, openDb, uid } from '../db.ts';
import { appendMessage, loadCustomer, loadMessages, loadTrace, rowToConversation, runForConversation } from '../services/chain.ts';
import { classify, summarize } from '../services/aigc.ts';
import { activeTask, cancelActiveTasks, claimActiveTask, ensureHandoffTask } from '../services/handoff.ts';
import { createCase, toCase } from './cases.ts';

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
    const rows = await db().all(`SELECT * FROM conversations ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY CASE status WHEN 'waiting_human' THEN 0 WHEN 'open' THEN 1 ELSE 2 END, last_message_at DESC LIMIT 200`, ...params);
    return Promise.all(rows.map((r) => rowToConversation(r)));
  });

  app.post('/api/conversations', async (req, reply) => {
    const body = z.object({ channel: z.string().default('web'), customerId: z.string().nullable().default(null), title: z.string().max(120).default('新会话'), mode: z.enum(['bot', 'human']).default('bot') }).parse(req.body ?? {});
    let customerId = body.customerId;
    if (!customerId) {
      customerId = uid('cust-');
      await db().run('INSERT INTO customers VALUES (?,?,?,?,?,?,?)', customerId, `访客${customerId.slice(-4)}`, '', 'normal', body.channel, J.str(['新访客']), '');
    }
    const id = uid('conv-');
    const now = nowIso();
    await db().run('INSERT INTO conversations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id, body.title, body.channel, customerId, 'open', body.mode, null, null, null, now, now, null, 'agent-cs-main', null);
    await audit('system', 'conversation.create', id, body);
    reply.code(201);
    return await rowToConversation((await db().get('SELECT * FROM conversations WHERE id=?', id))!);
  });

  app.get('/api/conversations/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await db().get('SELECT * FROM conversations WHERE id=?', id);
    if (!row) return reply.code(404).send({ error: '会话不存在' });
    const conversation = await rowToConversation(row);
    const messages = await loadMessages(id);
    const customer = await loadCustomer(conversation.customerId);
    const orders = customer ? await db().all('SELECT id, product, status, paid_amount, created_at FROM orders WHERE customer_id=? ORDER BY created_at DESC', customer.id) : [];
    const traces = await db().all<{ id: string; created_at: string; scenario: string; intent: string; decision: string; risk_level: string; duration_ms: number; status: string }>('SELECT id, created_at, scenario, intent, decision, risk_level, duration_ms, status FROM traces WHERE conversation_id=? ORDER BY created_at DESC', id);
    const cases = (await db().all('SELECT * FROM cases WHERE conversation_id=? ORDER BY created_at DESC', id)).map(toCase);
    const handoffTask = await activeTask(id);
    return { conversation, messages, customer, orders, traces, cases, handoffTask };
  });

  /** 发送消息：user 消息在机器人接待时触发执行链；agent 消息由坐席发送 */
  app.post('/api/conversations/:id/messages', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ role: z.enum(['user', 'agent']), text: z.string().min(1).max(4000) }).parse(req.body);
    const row = await db().get('SELECT * FROM conversations WHERE id=?', id);
    if (!row) return reply.code(404).send({ error: '会话不存在' });
    if (row.status === 'closed') return reply.code(409).send({ error: '会话已结束，请先重新打开' });
    if (body.role === 'agent') {
      if (row.controller === 'bot') return reply.code(409).send({ error: '当前由机器人接待，请先接管再回复', code: 'TAKEOVER_REQUIRED' });
      const m = await appendMessage(id, 'agent', body.text);
      await db().run("UPDATE conversations SET status='open' WHERE id=? AND status='waiting_human'", id);
      return { message: m, conversation: await rowToConversation((await db().get('SELECT * FROM conversations WHERE id=?', id))!) };
    }
    if (row.controller !== 'bot') {
      const m = await appendMessage(id, 'user', body.text);
      return { message: m, conversation: await rowToConversation((await db().get('SELECT * FROM conversations WHERE id=?', id))!), trace: null };
    }
    const r = await runForConversation(id, body.text, { mode: 'bot' });
    return { message: r.userMessage, botMessage: r.botMessage, trace: r.trace, conversation: r.conversation };
  });

  /**
   * 流式版本：以 SSE 逐阶段推送执行链进度（event: stage / done / error）。
   * 借鉴多智能体创作平台的 SSE 推送：把 8~14s 的等待变成可见进度。用 fetch 流式读取（POST 不能用 EventSource）。
   */
  app.post('/api/conversations/:id/messages/stream', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ role: z.literal('user'), text: z.string().min(1).max(4000) }).parse(req.body);
    const row = await db().get('SELECT * FROM conversations WHERE id=?', id);
    if (!row) return reply.code(404).send({ error: '会话不存在' });
    if (row.status === 'closed') return reply.code(409).send({ error: '会话已结束，请先重新打开' });
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const send = (event: string, data: unknown) => {
      if (!raw.writableEnded) raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const heartbeat = setInterval(() => !raw.writableEnded && raw.write(': ping\n\n'), 10_000);
    try {
      if (row.controller !== 'bot') {
        const m = await appendMessage(id, 'user', body.text);
        send('done', { message: m, botMessage: null, trace: null, conversation: await rowToConversation((await db().get('SELECT * FROM conversations WHERE id=?', id))!) });
      } else {
        send('accepted', { at: nowIso() });
        const r = await runForConversation(id, body.text, {
          mode: 'bot',
          onStage: (stage) => send('stage', { id: stage.id, label: stage.label, status: stage.status, durationMs: stage.durationMs, summary: stage.summary }),
        });
        send('done', { message: r.userMessage, botMessage: r.botMessage, trace: r.trace, conversation: r.conversation });
      }
    } catch (e) {
      send('error', { error: (e as Error).message });
    } finally {
      clearInterval(heartbeat);
      raw.end();
    }
  });

  /** 坐席辅助：基于最后一条用户消息生成建议（不落库为消息） */
  app.post('/api/conversations/:id/assist', async (req, reply) => {
    const { id } = req.params as { id: string };
    const msgs = await loadMessages(id);
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
    if (!lastUser) return reply.code(400).send({ error: '会话中没有用户消息' });
    // 辅助模式：把最后一条用户消息之前的历史作为上下文重跑一次链
    const r = await runForConversation(id, lastUser.text, { mode: 'assist', persistUserMessage: false });
    return { trace: r.trace, suggestion: r.trace.reply };
  });

  app.post('/api/conversations/:id/control', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = z.object({ action: z.enum(['takeover', 'robot', 'close', 'reopen', 'handoff']), actor: z.string().default('坐席'), reason: z.string().max(300).default('') }).parse(req.body);
    // 登录用户优先作为操作者，避免前端伪造
    const body = { ...parsed, actor: req.user?.name ?? parsed.actor };
    const row = await db().get('SELECT * FROM conversations WHERE id=?', id);
    if (!row) return reply.code(404).send({ error: '会话不存在' });
    const patch: Record<string, unknown> = {};
    if (body.action === 'takeover') Object.assign(patch, { controller: 'human', status: 'open', assignee: body.actor });
    if (body.action === 'robot') Object.assign(patch, { controller: 'bot', status: 'open', assignee: null });
    if (body.action === 'close') Object.assign(patch, { status: 'closed' });
    if (body.action === 'reopen') Object.assign(patch, { status: 'open' });
    if (body.action === 'handoff') Object.assign(patch, { controller: 'human', status: 'waiting_human', assignee: null, priority: row.priority ?? 'P2' });
    const keys = Object.keys(patch);
    await db().run(`UPDATE conversations SET ${keys.map((k) => `${k}=?`).join(', ')} WHERE id=?`, ...(keys.map((k) => patch[k]) as (string | null)[]), id);
    await appendMessage(id, 'system', `【${{ takeover: '人工接管', robot: '转回机器人', close: '会话结束', reopen: '重新打开', handoff: '转人工排队' }[body.action]}】${body.actor}${body.reason ? `：${body.reason}` : ''}`, { meta: { internal: true } });
    await audit(body.actor, `conversation.${body.action}`, id, body);
    // 人工接续任务联动：排队 → 创建/追加任务；接管 → 认领活动任务；结束/转回机器人 → 取消活动任务
    if (body.action === 'handoff') {
      const p = ((row.priority as string) ?? 'P2') as 'P0' | 'P1' | 'P2';
      const { task, created } = await ensureHandoffTask({ conversationId: id, channel: String(row.channel ?? 'web'), priority: p, reason: `坐席转人工排队${body.reason ? `：${body.reason}` : ''}`, progress: { doneStages: [], evidence: [], missing: [], candidate: null, failure: null, nextAction: '接续会话并处理诉求' }, traceId: null });
      if (created) await appendMessage(id, 'system', `【已创建人工接续任务 ${task.id}】${task.windowText}`, { meta: { internal: true, handoffId: task.id } });
    } else if (body.action === 'takeover') {
      await claimActiveTask(id, body.actor);
    } else if (body.action === 'close' || body.action === 'robot') {
      await cancelActiveTasks(id, body.actor, body.action === 'close' ? '会话结束' : '转回机器人接待');
    }
    // 后处理闭环（借鉴云商坐席辅助第三环）：会话结束后自动生成小记与待办，不阻塞响应
    if (body.action === 'close' && (await loadMessages(id)).filter((m) => m.role !== 'system').length >= 2) {
      summarize(id)
        .then(async (s) => {
          const text = `问题：${s.problem}\n处理：${s.handling}\n结果：${s.outcome}${s.followUp ? `\n跟进：${s.followUp}` : ''}`;
          await db().run('UPDATE conversations SET summary=? WHERE id=?', text, id);
          await appendMessage(id, 'system', `【自动小记】${text}${s.tags.length ? `\n标签：${s.tags.join('、')}` : ''}`, { meta: { internal: true, autoSummary: true } });
        })
        .catch((e) => app.log.warn(`自动小记失败 ${id}: ${(e as Error).message}`));
    }
    return await rowToConversation((await db().get('SELECT * FROM conversations WHERE id=?', id))!);
  });

  /** 访客满意度评价（会话结束后） */
  app.post('/api/conversations/:id/rate', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ score: z.number().int().min(1).max(5) }).parse(req.body);
    const row = await db().get('SELECT * FROM conversations WHERE id=?', id);
    if (!row) return reply.code(404).send({ error: '会话不存在' });
    await db().run('UPDATE conversations SET satisfaction=? WHERE id=?', body.score, id);
    await appendMessage(id, 'system', `【访客评价】${body.score} 星`, { meta: { internal: true, satisfaction: body.score } });
    return await rowToConversation((await db().get('SELECT * FROM conversations WHERE id=?', id))!);
  });

  app.post('/api/conversations/:id/summary', async (req) => {
    const { id } = req.params as { id: string };
    const s = await summarize(id);
    const text = `问题：${s.problem}\n处理：${s.handling}\n结果：${s.outcome}${s.followUp ? `\n跟进：${s.followUp}` : ''}`;
    await db().run('UPDATE conversations SET summary=? WHERE id=?', text, id);
    return s;
  });

  app.post('/api/conversations/:id/classify', async (req) => await classify((req.params as { id: string }).id));

  /** 从会话拆出子案件（坐席操作；正式售后工单在 DMS，关联在子案件页完成） */
  app.post('/api/conversations/:id/case', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = z.object({ title: z.string().min(1).max(120), type: z.string().default('其他'), priority: z.enum(['P0', 'P1', 'P2']).default('P2'), description: z.string().max(2000).default(''), assignee: z.string().nullable().default(null), actor: z.string().default('坐席') }).parse(req.body);
    const actor = req.user?.name ?? parsed.actor;
    const row = await db().get('SELECT * FROM conversations WHERE id=?', id);
    if (!row) return reply.code(404).send({ error: '会话不存在' });
    const lastTrace = await db().get<{ id: string; doc: string }>('SELECT id, doc FROM traces WHERE conversation_id=? ORDER BY created_at DESC LIMIT 1', id);
    const traceDoc = lastTrace ? J.parse<{ slots?: { key: string; value: string | null; source: string }[]; evidence?: { items?: { tool: string; ok: boolean; summary?: string }[] }; reply?: { candidate?: string | null } }>(lastTrace.doc, {}) : {};
    const slots = Object.fromEntries((traceDoc.slots ?? []).filter((s) => s.value && s.source !== 'missing').map((s) => [s.key, String(s.value)]));
    const facts = (traceDoc.evidence?.items ?? []).filter((i) => i.ok).map((i) => ({ tool: i.tool, summary: i.summary ?? '' }));
    const c = await createCase(db(), { ...parsed, conversationId: id, customerId: String(row.customer_id), evidence: { slots, facts, traceIds: lastTrace ? [lastTrace.id] : [], candidateReply: traceDoc.reply?.candidate ?? null }, source: 'agent', actor });
    await appendMessage(id, 'system', `【已拆出子案件 ${c.id}】${c.title}`, { meta: { internal: true, caseId: c.id } });
    await audit(actor, 'case.create', c.id, { conversationId: id });
    reply.code(201);
    return c;
  });

  app.get('/api/customers', async () => (await db().all('SELECT * FROM customers ORDER BY name')).map((c) => ({ ...c, tags: J.parse(c.tags, []) })));
  app.get('/api/customers/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const c = await loadCustomer(id);
    if (!c) return reply.code(404).send({ error: '客户不存在' });
    const orderRows = await db().all('SELECT * FROM orders WHERE customer_id=? ORDER BY created_at DESC', id);
    const orders = await Promise.all(
      orderRows.map(async (o) => ({
        ...o,
        logistics: (await db().get('SELECT * FROM logistics WHERE order_id=?', String(o.id))) ?? null,
        invoice: (await db().get('SELECT * FROM invoices WHERE order_id=?', String(o.id))) ?? null,
        refunds: await db().all('SELECT * FROM refunds WHERE order_id=?', String(o.id)),
      })),
    );
    const convRows = await db().all('SELECT * FROM conversations WHERE customer_id=? ORDER BY last_message_at DESC', id);
    const conversations = await Promise.all(convRows.map((r) => rowToConversation(r)));
    return { customer: c, orders, conversations };
  });

  app.get('/api/traces', async (req) => {
    const q = req.query as Record<string, string>;
    const limit = Math.min(200, Number(q.limit ?? 50));
    return await db().all('SELECT id, conversation_id, agent_id, agent_version, created_at, scenario, intent, decision, risk_level, duration_ms, status FROM traces ORDER BY created_at DESC LIMIT ?', limit);
  });
  app.get('/api/traces/:id', async (req, reply) => {
    const t = await loadTrace((req.params as { id: string }).id);
    return t ?? reply.code(404).send({ error: 'trace 不存在' });
  });
  app.get('/api/audit', async () => (await db().all('SELECT * FROM audit_log ORDER BY at DESC LIMIT 200')).map((a) => ({ ...a, detail: J.parse(a.detail, null) })));
}
