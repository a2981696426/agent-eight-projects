import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CaseEvidence, CaseStatus, HistoryEntry, Priority, SubCase } from '@eight/shared';
import { J, nowIso, openDb, uid, type Db } from '../db.ts';
import { dms, dmsMock, type DmsResult } from '../services/dms.ts';
import { appendTaskHistory, claimTask, finishTask, loadTask, rowToTask } from '../services/handoff.ts';
import { actorOf } from '../services/auth.ts';
import { appendMessage } from '../services/chain.ts';
import { ackAlert, escalateIfUnacked, oncallStatus } from '../services/oncall.ts';
import type { DmsTicket } from '@eight/shared';

/**
 * 子案件 + 人工接续任务 + DMS 关联（CS-003 / CS-008E-I / CS-016）。
 * 本地状态只有 pending_human / in_progress / linked_dms / archived；正式售后状态只在 DMS。
 */
const db = () => openDb();
const EMPTY_EVIDENCE: CaseEvidence = { slots: {}, facts: [], traceIds: [], candidateReply: null };

export function toCase(r: Record<string, unknown>): SubCase {
  return {
    id: String(r.id),
    title: String(r.title),
    type: String(r.type ?? '其他'),
    status: r.status as CaseStatus,
    priority: r.priority as Priority,
    conversationId: (r.conversation_id as string) ?? null,
    customerId: (r.customer_id as string) ?? null,
    customerName: String(r.customer_name ?? ''),
    assignee: (r.assignee as string) ?? null,
    description: String(r.description ?? ''),
    evidence: J.parse<CaseEvidence>(r.evidence, EMPTY_EVIDENCE),
    source: (r.source as SubCase['source']) ?? 'manual',
    dms: { ticketNo: (r.dms_ticket_no as string) ?? null, status: (r.dms_status as string) ?? null, syncedAt: (r.dms_synced_at as string) ?? null, pending: Number(r.dms_pending ?? 0) === 1, lastError: (r.dms_last_error as string) ?? null },
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    history: J.parse<HistoryEntry[]>(r.history, []),
  };
}

export const newCaseId = () => `CS-${nowIso().slice(0, 10).replace(/-/g, '')}-${uid().slice(0, 4).toUpperCase()}`;

export interface CreateCaseInput {
  title: string;
  type: string;
  priority: Priority;
  description: string;
  conversationId: string | null;
  customerId: string | null;
  assignee: string | null;
  evidence?: Partial<CaseEvidence>;
  source: SubCase['source'];
  actor: string;
}

/** 创建子案件（供路由、执行链工具、接续任务拆分共用） */
export async function createCase(d: Db, input: CreateCaseInput): Promise<SubCase> {
  const id = newCaseId();
  const now = nowIso();
  let customerId = input.customerId;
  let customerName = '—';
  if (!customerId && input.conversationId) customerId = ((await d.get<{ customer_id: string }>('SELECT customer_id FROM conversations WHERE id=?', input.conversationId))?.customer_id as string) ?? null;
  if (customerId) customerName = (await d.get<{ name: string }>('SELECT name FROM customers WHERE id=?', customerId))?.name ?? '—';
  const evidence: CaseEvidence = { ...EMPTY_EVIDENCE, ...input.evidence };
  const history: HistoryEntry[] = [{ at: now, by: input.actor, action: '创建子案件' }];
  await d.run(
    'INSERT INTO cases VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    id, input.title, input.type, 'pending_human', input.priority, input.conversationId, customerId, customerName, input.assignee, input.description, J.str(evidence), input.source, null, null, null, 0, null, now, now, J.str(history),
  );
  return toCase((await d.get('SELECT * FROM cases WHERE id=?', id))!);
}

async function loadCase(id: string): Promise<SubCase | null> {
  const r = await db().get('SELECT * FROM cases WHERE id=?', id);
  return r ? toCase(r) : null;
}

const audit = (actor: string, action: string, target: string, detail: unknown = null) => db().run('INSERT INTO audit_log VALUES (?,?,?,?,?,?)', uid('al-'), nowIso(), actor, action, target, J.str(detail));

/** 把 DMS 结果写回子案件：成功 → linked_dms；不可用 → 待同步；拒绝/已注销 → 记录错误 */
async function applyDmsResult(c: SubCase, r: DmsResult<DmsTicket>, actor: string, how: '自动建单' | '回填' | '重试'): Promise<SubCase> {
  const now = nowIso();
  if (r.ok) {
    const history = [...c.history, { at: now, by: actor, action: `${how}：已关联 DMS 工单 ${r.data.ticketNo}（${r.data.status}）` }];
    await db().run("UPDATE cases SET status='linked_dms', dms_ticket_no=?, dms_status=?, dms_synced_at=?, dms_pending=0, dms_last_error=NULL, updated_at=?, history=? WHERE id=?", r.data.ticketNo, r.data.status, now, now, J.str(history), c.id);
  } else if (r.kind === 'unavailable') {
    const history = [...c.history, { at: now, by: actor, action: `${how}失败：DMS 不可用，转为待同步案件`, note: r.message }];
    await db().run('UPDATE cases SET dms_pending=1, dms_last_error=?, updated_at=?, history=? WHERE id=?', r.message, now, J.str(history), c.id);
  } else {
    const label = r.kind === 'account_cancelled' ? '激活账号已注销，升级人工' : r.kind === 'not_found' ? '工单不存在' : 'DMS 拒绝';
    const history = [...c.history, { at: now, by: actor, action: `${how}失败：${label}`, note: r.message }];
    await db().run('UPDATE cases SET dms_pending=0, dms_last_error=?, updated_at=?, history=? WHERE id=?', r.message, now, J.str(history), c.id);
  }
  return (await loadCase(c.id))!;
}

const toDmsInput = (c: SubCase) => ({ caseId: c.id, title: c.title, type: c.type, priority: c.priority, customerName: c.customerName, orderId: c.evidence.slots.orderId ?? null, description: c.description, evidence: c.evidence });

export async function caseRoutes(app: FastifyInstance) {
  /* ───────────── 子案件 ───────────── */
  app.get('/api/cases', async (req) => {
    const q = req.query as Record<string, string>;
    const where: string[] = [];
    const params: string[] = [];
    for (const k of ['status', 'priority', 'type', 'assignee', 'conversation_id']) {
      if (q[k]) {
        where.push(`${k}=?`);
        params.push(q[k]);
      }
    }
    if (q.dmsPending === '1') where.push('dms_pending=1');
    const rows = await db().all(`SELECT * FROM cases ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 ELSE 2 END, created_at DESC LIMIT 300`, ...params);
    return rows.map(toCase);
  });
  app.get('/api/cases/stats', async () => {
    const byStatus = await db().all<{ status: string; n: number }>('SELECT status, COUNT(*) n FROM cases GROUP BY status');
    const byPriority = await db().all<{ priority: string; n: number }>("SELECT priority, COUNT(*) n FROM cases WHERE status <> 'archived' GROUP BY priority");
    const dmsPending = (await db().get<{ n: number }>('SELECT COUNT(*)::int n FROM cases WHERE dms_pending=1'))?.n ?? 0;
    return { byStatus, byPriority, dmsPending, total: await db().count('cases') };
  });
  app.get('/api/cases/:id', async (req, reply) => {
    const c = await loadCase((req.params as { id: string }).id);
    return c ?? reply.code(404).send({ error: '子案件不存在' });
  });
  const CaseBody = z.object({ title: z.string().min(1).max(120), type: z.string().default('其他'), priority: z.enum(['P0', 'P1', 'P2']).default('P2'), description: z.string().max(2000).default(''), customerId: z.string().nullable().default(null), conversationId: z.string().nullable().default(null), assignee: z.string().nullable().default(null), evidence: z.object({ slots: z.record(z.string(), z.string()).default({}), facts: z.array(z.object({ tool: z.string(), summary: z.string() })).default([]), traceIds: z.array(z.string()).default([]), candidateReply: z.string().nullable().default(null) }).partial().optional() });
  app.post('/api/cases', async (req, reply) => {
    const b = CaseBody.parse(req.body);
    const actor = actorOf(req);
    const c = await createCase(db(), { ...b, source: 'manual', actor });
    if (c.conversationId) await appendMessage(c.conversationId, 'system', `【已拆出子案件 ${c.id}】${c.title}`, { meta: { internal: true, caseId: c.id } });
    await audit(actor, 'case.create', c.id, { conversationId: c.conversationId });
    reply.code(201);
    return c;
  });
  app.patch('/api/cases/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    // linked_dms 只能由 DMS 结果写入；本地没有 resolved/closed
    const b = z.object({ status: z.enum(['in_progress', 'archived', 'pending_human']).optional(), assignee: z.string().nullable().optional(), priority: z.enum(['P0', 'P1', 'P2']).optional(), note: z.string().max(1000).default('') }).parse(req.body);
    const c = await loadCase(id);
    if (!c) return reply.code(404).send({ error: '子案件不存在' });
    const actor = actorOf(req);
    const now = nowIso();
    const actions: string[] = [];
    const labels: Record<CaseStatus, string> = { pending_human: '待人工', in_progress: '处理中', linked_dms: '已关联 DMS', archived: '已归档' };
    if (b.status && b.status !== c.status) actions.push(`状态 ${labels[c.status]} → ${labels[b.status]}`);
    if (b.assignee !== undefined && b.assignee !== c.assignee) actions.push(`转派给 ${b.assignee ?? '未分配'}`);
    if (b.priority && b.priority !== c.priority) actions.push(`优先级 ${c.priority} → ${b.priority}`);
    if (!actions.length && !b.note) return c;
    const history = [...c.history, { at: now, by: actor, action: actions.join('；') || '备注', note: b.note || undefined }];
    await db().run('UPDATE cases SET status=?, assignee=?, priority=?, updated_at=?, history=? WHERE id=?', b.status ?? c.status, b.assignee === undefined ? c.assignee : b.assignee, b.priority ?? c.priority, now, J.str(history), id);
    return (await loadCase(id))!;
  });

  /* ───────────── DMS 关联（只有这一种"工单"写法，且必须由坐席触发） ───────────── */
  app.post('/api/cases/:id/dms/link', async (req, reply) => {
    const c = await loadCase((req.params as { id: string }).id);
    if (!c) return reply.code(404).send({ error: '子案件不存在' });
    if (c.status === 'linked_dms' && c.dms.ticketNo) {
      const r = await dms.getTicket(c.dms.ticketNo);
      return applyDmsResult(c, r.ok ? r : { ok: true, data: { ticketNo: c.dms.ticketNo, status: (c.dms.status ?? 'received') as DmsTicket['status'], updatedAt: c.dms.syncedAt ?? nowIso() } }, actorOf(req), '自动建单');
    }
    const r = await dms.createTicket(toDmsInput(c));
    const out = await applyDmsResult(c, r, actorOf(req), '自动建单');
    await audit(actorOf(req), r.ok ? 'case.dms_linked' : `case.dms_${r.kind}`, c.id, r.ok ? r.data : { message: r.message });
    if (c.conversationId) await appendMessage(c.conversationId, 'system', r.ok ? `【已关联 DMS 工单 ${r.data.ticketNo}】${c.title}` : `【DMS 关联未完成】${c.title}：${r.message}`, { meta: { internal: true, caseId: c.id } });
    return out;
  });
  app.post('/api/cases/:id/dms/attach', async (req, reply) => {
    const c = await loadCase((req.params as { id: string }).id);
    if (!c) return reply.code(404).send({ error: '子案件不存在' });
    const b = z.object({ ticketNo: z.string().min(3).max(60) }).parse(req.body);
    const r = await dms.getTicket(b.ticketNo);
    if (!r.ok) return reply.code(400).send({ error: `无法关联：${r.message}`, kind: r.kind });
    const out = await applyDmsResult(c, r, actorOf(req), '回填');
    await audit(actorOf(req), 'case.dms_attached', c.id, r.data);
    return out;
  });
  app.post('/api/cases/:id/dms/refresh', async (req, reply) => {
    const c = await loadCase((req.params as { id: string }).id);
    if (!c) return reply.code(404).send({ error: '子案件不存在' });
    if (!c.dms.ticketNo) return reply.code(400).send({ error: '尚未关联 DMS 工单' });
    const r = await dms.getTicket(c.dms.ticketNo);
    return applyDmsResult(c, r, actorOf(req), '回填');
  });

  /* ───────────── DMS 适配器管理 ───────────── */
  app.get('/api/dms/health', async () => dms.health());
  app.post('/api/dms/retry-pending', async (req) => {
    const rows = await db().all('SELECT * FROM cases WHERE dms_pending=1 ORDER BY created_at ASC');
    let linked = 0;
    for (const row of rows) {
      const c = toCase(row);
      const r = await dms.createTicket(toDmsInput(c));
      await applyDmsResult(c, r, actorOf(req, '系统'), '重试');
      if (r.ok) linked++;
    }
    const stillPending = (await db().get<{ n: number }>('SELECT COUNT(*)::int n FROM cases WHERE dms_pending=1'))?.n ?? 0;
    await audit(actorOf(req, '系统'), 'dms.retry_pending', 'cases', { retried: rows.length, linked, stillPending });
    return { retried: rows.length, linked, stillPending };
  });
  app.post('/api/dms/simulate', async (req, reply) => {
    if (!dmsMock) return reply.code(400).send({ error: '当前不是模拟适配器' });
    const b = z.object({ mode: z.enum(['normal', 'unavailable', 'reject', 'account_cancelled', 'slow']) }).parse(req.body);
    dmsMock.mode = b.mode;
    await audit(actorOf(req), 'dms.simulate', b.mode);
    return dmsMock.health();
  });
  app.get('/api/dms/mock', async (_req, reply) => {
    if (!dmsMock) return reply.code(400).send({ error: '当前不是模拟适配器' });
    return { mode: dmsMock.mode, tickets: await dmsMock.list() };
  });
  app.post('/api/dms/mock/:ticketNo/advance', async (req, reply) => {
    if (!dmsMock) return reply.code(400).send({ error: '当前不是模拟适配器' });
    const r = await dmsMock.advance((req.params as { ticketNo: string }).ticketNo);
    if (!r.ok) return reply.code(404).send({ error: r.message });
    // 同步回读到已关联的子案件
    const c = await db().get('SELECT * FROM cases WHERE dms_ticket_no=?', r.data.ticketNo);
    if (c) await db().run('UPDATE cases SET dms_status=?, dms_synced_at=? WHERE id=?', r.data.status, nowIso(), String(c.id));
    return r.data;
  });

  /* ───────────── 人工接续任务 ───────────── */
  app.get('/api/handoffs', async (req) => {
    const q = req.query as Record<string, string>;
    const statuses = q.status ? q.status.split('|') : ['pending', 'claimed'];
    const rows = await db().all(`SELECT * FROM handoff_tasks WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 ELSE 2 END, created_at ASC LIMIT 300`, ...statuses);
    const tasks = rows.map(rowToTask);
    const convIds = [...new Set(tasks.map((t) => t.conversationId))];
    const convs = convIds.length ? await db().all<{ id: string; title: string; channel: string; controller: string; status: string }>(`SELECT id, title, channel, controller, status FROM conversations WHERE id IN (${convIds.map(() => '?').join(',')})`, ...convIds) : [];
    const byId = new Map(convs.map((c) => [c.id, c]));
    return tasks.map((t) => ({ ...t, conversation: byId.get(t.conversationId) ?? null }));
  });
  app.get('/api/handoffs/stats', async () => {
    const pendingByPriority = await db().all<{ priority: string; n: number }>("SELECT priority, COUNT(*) n FROM handoff_tasks WHERE status='pending' GROUP BY priority");
    const claimed = (await db().get<{ n: number }>("SELECT COUNT(*)::int n FROM handoff_tasks WHERE status='claimed'"))?.n ?? 0;
    const overdue = (await db().get<{ n: number }>("SELECT COUNT(*)::int n FROM handoff_tasks WHERE status='pending' AND due_at < ?", nowIso()))?.n ?? 0;
    return { pendingByPriority, pending: pendingByPriority.reduce((s, p) => s + p.n, 0), claimed, overdue };
  });
  app.get('/api/handoffs/:id', async (req, reply) => {
    const t = await loadTask((req.params as { id: string }).id);
    return t ?? reply.code(404).send({ error: '接续任务不存在' });
  });
  app.post('/api/handoffs/:id/claim', async (req) => {
    const actor = actorOf(req);
    let t = await claimTask((req.params as { id: string }).id, actor);
    if (t.priority === 'P0' && !t.alert?.ackAt) t = (await ackAlert(t.id, actor)) ?? t;
    await appendMessage(t.conversationId, 'system', `【人工接续】${actor} 已认领接续任务 ${t.id} 并接管会话`, { meta: { internal: true, handoffId: t.id } });
    await audit(actor, 'handoff.claim', t.id, { conversationId: t.conversationId });
    return t;
  });
  app.post('/api/handoffs/:id/done', async (req) => {
    const b = z.object({ note: z.string().max(500).default('') }).parse(req.body ?? {});
    const actor = actorOf(req);
    const t = await finishTask((req.params as { id: string }).id, actor, b.note);
    await audit(actor, 'handoff.done', t.id, { note: b.note });
    return t;
  });
  /** 从接续任务拆出子案件：证据包来自任务进度 */
  app.post('/api/handoffs/:id/case', async (req, reply) => {
    const t = await loadTask((req.params as { id: string }).id);
    if (!t) return reply.code(404).send({ error: '接续任务不存在' });
    if (t.caseId) {
      const existing = await loadCase(t.caseId);
      if (existing) return reply.code(200).send({ task: t, case: existing });
    }
    const conv = await db().get<{ title: string; customer_id: string; scenario: string | null }>('SELECT title, customer_id, scenario FROM conversations WHERE id=?', t.conversationId);
    const typeByScenario: Record<string, string> = { logistics: '物流', invoice: '发票', refund_price_diff: '退款', complaint: '投诉', presale: '售前' };
    const actor = actorOf(req);
    const c = await createCase(db(), {
      title: conv?.title ?? `接续任务 ${t.id}`,
      type: typeByScenario[conv?.scenario ?? ''] ?? '其他',
      priority: t.priority,
      description: `${t.reason}\n下一步：${t.progress.nextAction}${t.progress.missing.length ? `\n缺项：${t.progress.missing.join('、')}` : ''}`,
      conversationId: t.conversationId,
      customerId: conv?.customer_id ?? null,
      assignee: t.claimedBy,
      evidence: { facts: t.progress.evidence.map((e) => ({ tool: e, summary: '来自接续任务证据' })), traceIds: t.traceId ? [t.traceId] : [], candidateReply: t.progress.candidate },
      source: 'agent',
      actor,
    });
    const task = await appendTaskHistory(t.id, { at: nowIso(), by: actor, action: `拆出子案件 ${c.id}` }, { caseId: c.id });
    await appendMessage(t.conversationId, 'system', `【已拆出子案件 ${c.id}】${c.title}`, { meta: { internal: true, caseId: c.id } });
    await audit(actor, 'handoff.split_case', t.id, { caseId: c.id });
    reply.code(201);
    return { task, case: c };
  });

  /* ───────────── P0 轮值告警（CS-008H） ───────────── */
  app.get('/api/oncall/status', async () => oncallStatus());
  app.post('/api/oncall/alerts/:id/ack', async (req, reply) => {
    const actor = actorOf(req);
    const t = await ackAlert((req.params as { id: string }).id, actor);
    if (!t) return reply.code(404).send({ error: '接续任务不存在' });
    await audit(actor, 'oncall.ack', t.id, { ackBy: actor });
    return t;
  });
  app.post('/api/oncall/alerts/:id/escalate', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const r = await escalateIfUnacked(id);
    await audit(actorOf(req), 'oncall.escalate', id, { sent: r.sent, reason: r.reason ?? null });
    return r;
  });
}
