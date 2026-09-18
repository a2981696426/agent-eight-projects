import { BM25Index, LlmClient, ToolRegistry, runChain, type ChainContext } from '@eight/agent-core';
import type { AgentConfig, Conversation, Customer, KnowledgeChunk, Message, Trace } from '@eight/shared';
import { J, nowIso, openDb, uid } from '../db.ts';
import { env } from '../env.ts';
import { DEFAULT_AGENT } from '../seed.ts';

const db = () => openDb();

export const llm = new LlmClient({ ...env.llm, timeoutMs: 90_000 });

/* ───────────── 知识索引（发布态 chunk） ───────────── */
let index: BM25Index | null = null;
export function knowledgeIndex() {
  if (!index) {
    index = new BM25Index();
    refreshIndex();
  }
  return index;
}
export function refreshIndex() {
  const rows = db().all<{ id: string; doc_id: string; seq: number; text: string; tags: string; title: string }>(
    `SELECT c.id, c.doc_id, c.seq, c.text, c.tags, d.title FROM knowledge_chunks c JOIN knowledge_docs d ON d.id=c.doc_id WHERE d.status='published'`,
  );
  const chunks = rows.map((r) => ({ docTitle: r.title, chunk: { id: r.id, docId: r.doc_id, seq: r.seq, text: r.text, tags: J.parse<string[]>(r.tags, []) } as KnowledgeChunk }));
  (index ??= new BM25Index()).rebuild(chunks);
  return chunks.length;
}

/* ───────────── 业务工具（模拟业务系统，数据来自 SQLite） ───────────── */
export const tools = new ToolRegistry()
  .register({
    name: 'crm.lookupCustomer',
    label: 'CRM 客户档案',
    description: '按客户 ID 查询等级、标签、历史订单数',
    requires: ['customerId'],
    run: async (a) => {
      const c = db().get('SELECT * FROM customers WHERE id=?', String(a.customerId));
      if (!c) throw new Error('客户不存在');
      const orders = db().all<{ id: string; status: string; product: string; created_at: string }>('SELECT id,status,product,created_at FROM orders WHERE customer_id=? ORDER BY created_at DESC', String(a.customerId));
      return { id: c.id, name: c.name, level: c.level, tags: J.parse(c.tags, []), note: c.note, recentOrders: orders.slice(0, 5) };
    },
  })
  .register({
    name: 'orders.lookup',
    label: '订单查询',
    description: '按订单号查询订单状态、金额、商品、地址',
    requires: ['orderId'],
    run: async (a) => {
      const o = db().get('SELECT * FROM orders WHERE id=?', String(a.orderId));
      if (!o) throw new Error(`订单 ${a.orderId} 不存在`);
      return { orderId: o.id, product: o.product, sku: o.sku, listPrice: o.amount, paidAmount: o.paid_amount, status: o.status, createdAt: o.created_at, paidAt: o.paid_at, shippedAt: o.shipped_at, address: o.address, priceProtectDays: o.price_protect_days, belongsToCustomer: a.customerId ? o.customer_id === a.customerId : null };
    },
  })
  .register({
    name: 'logistics.track',
    label: '物流轨迹',
    description: '按订单号查询承运商、运单号、最新状态与轨迹',
    requires: ['orderId'],
    run: async (a) => {
      const l = db().get('SELECT * FROM logistics WHERE order_id=?', String(a.orderId));
      if (!l) {
        const o = db().get<{ status: string }>('SELECT status FROM orders WHERE id=?', String(a.orderId));
        if (!o) throw new Error('订单不存在');
        return { orderId: a.orderId, status: o.status === 'paid' ? 'not_shipped' : 'no_logistics', note: o.status === 'paid' ? '订单已付款尚未发货' : '暂无物流记录' };
      }
      const hoursSinceUpdate = Math.round((Date.now() - new Date(String(l.last_update)).getTime()) / 36e5);
      return { orderId: l.order_id, carrier: l.carrier, trackingNo: l.tracking_no, status: l.status, lastUpdate: l.last_update, hoursSinceUpdate, stalled: hoursSinceUpdate >= 72 && !['delivered', 'returned'].includes(String(l.status)), events: J.parse(l.events, []) };
    },
  })
  .register({
    name: 'invoices.lookup',
    label: '发票状态',
    description: '按订单号查询开票状态、抬头、税号、类型',
    requires: ['orderId'],
    run: async (a) => {
      const i = db().get('SELECT * FROM invoices WHERE order_id=?', String(a.orderId));
      if (!i) {
        const o = db().get<{ status: string }>('SELECT status FROM orders WHERE id=?', String(a.orderId));
        if (!o) throw new Error('订单不存在');
        return { orderId: a.orderId, status: 'not_requested', orderStatus: o.status, note: ['completed', 'delivered'].includes(o.status) ? '确认收货后 48 小时内自动开具' : '订单尚未完成，暂不开票' };
      }
      return { orderId: i.order_id, status: i.status, title: i.title, taxId: i.tax_id, type: i.type, issuedAt: i.issued_at, url: i.url, note: i.note };
    },
  })
  .register({
    name: 'refunds.lookup',
    label: '退款记录',
    description: '按订单号查询退款申请、状态、金额、预计到账',
    requires: ['orderId'],
    run: async (a) => {
      const rows = db().all('SELECT * FROM refunds WHERE order_id=? ORDER BY applied_at DESC', String(a.orderId));
      return { orderId: a.orderId, refunds: rows.map((r) => ({ id: r.id, type: r.type, amount: r.amount, status: r.status, appliedAt: r.applied_at, processedAt: r.processed_at, reason: r.reason, eta: r.channel_eta })), count: rows.length };
    },
  })
  .register({
    name: 'pricing.priceDifference',
    label: '保价/差价核算',
    description: '按订单号核算是否在保价期内以及可退差价',
    requires: ['orderId'],
    run: async (a) => {
      const o = db().get('SELECT * FROM orders WHERE id=?', String(a.orderId));
      if (!o) throw new Error('订单不存在');
      const paidAt = new Date(String(o.paid_at ?? o.created_at)).getTime();
      const protectDays = Number(o.price_protect_days ?? 15);
      const withinWindow = Date.now() - paidAt <= protectDays * 86400e3;
      const currentPrice = o.promo_price != null && o.promo_start && o.promo_end && Date.now() >= new Date(String(o.promo_start)).getTime() && Date.now() <= new Date(String(o.promo_end)).getTime() ? Number(o.promo_price) : Number(o.amount);
      const diff = Math.max(0, Number(o.paid_amount) - currentPrice);
      return { orderId: o.id, paidAmount: o.paid_amount, currentPrice, protectDays, withinWindow, eligible: withinWindow && diff >= 1, priceDifference: Number(diff.toFixed(2)), note: withinWindow ? (diff >= 1 ? '符合退差价条件，需人工审核后原路退回' : '当前价格未低于实付价') : '已超出保价期' };
    },
  })
  .register({
    name: 'catalog.search',
    label: '商品目录',
    description: '按关键词返回在售 SKU 与价格',
    requires: [],
    run: async (a) => {
      const rows = db().all<{ product: string; sku: string; amount: number }>('SELECT DISTINCT product, sku, amount FROM orders');
      const kw = String(a.product ?? '').trim();
      return { items: rows.filter((r) => !kw || r.product.includes(kw) || r.sku.includes(kw)).map((r) => ({ product: r.product, sku: r.sku, listPrice: r.amount, inStock: true })) };
    },
  })
  .register({
    name: 'tickets.create',
    label: '创建工单',
    description: '创建跟进工单（动作工具，仅在自治门禁允许时执行）',
    requires: ['conversationId'],
    mutating: true,
    run: async (a) => {
      const id = `TK-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${uid().slice(0, 4).toUpperCase()}`;
      const conv = db().get<{ customer_id: string; title: string }>('SELECT customer_id,title FROM conversations WHERE id=?', String(a.conversationId));
      const cust = conv ? db().get<{ name: string }>('SELECT name FROM customers WHERE id=?', conv.customer_id) : null;
      const now = nowIso();
      const due = new Date(Date.now() + 24 * 3600e3).toISOString();
      const type = ({ logistics: '物流', invoice: '发票', refund_price_diff: '退款', complaint: '投诉', presale: '售前' } as Record<string, string>)[String(a.scenario)] ?? '其他';
      db().run('INSERT INTO tickets VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id, String(a.title ?? '执行链自动建单'), type, 'open', 'P2', String(a.conversationId), conv?.customer_id ?? null, cust?.name ?? '未知', null, `由执行链自动创建。${a.reason ?? ''}`.trim(), due, now, now, 'chain', J.str([{ at: now, by: '执行链', action: '自动创建工单' }]));
      return { id, type, slaDueAt: due };
    },
  });

/* ───────────── Agent 配置 ───────────── */
export function loadAgent(id = DEFAULT_AGENT.id): AgentConfig {
  const row = db().get<{ doc: string }>('SELECT doc FROM agents WHERE id=?', id);
  return row ? J.parse<AgentConfig>(row.doc, DEFAULT_AGENT) : DEFAULT_AGENT;
}

/* ───────────── 会话读取 ───────────── */
export function rowToConversation(r: Record<string, unknown>): Conversation {
  const name = db().get<{ name: string }>('SELECT name FROM customers WHERE id=?', String(r.customer_id))?.name ?? '匿名访客';
  const count = db().get<{ n: number }>('SELECT COUNT(*) n FROM messages WHERE conversation_id=?', String(r.id))?.n ?? 0;
  return {
    id: String(r.id),
    title: String(r.title),
    channel: r.channel as Conversation['channel'],
    customerId: String(r.customer_id),
    customerName: name,
    status: r.status as Conversation['status'],
    controller: r.controller as Conversation['controller'],
    assignee: (r.assignee as string) ?? null,
    scenario: (r.scenario as string) ?? null,
    priority: (r.priority as Conversation['priority']) ?? null,
    lastMessageAt: String(r.last_message_at),
    createdAt: String(r.created_at),
    messageCount: count,
    summary: (r.summary as string) ?? null,
  };
}
export function loadMessages(conversationId: string): Message[] {
  return db()
    .all('SELECT * FROM messages WHERE conversation_id=? ORDER BY at ASC', conversationId)
    .map((m) => ({ id: String(m.id), conversationId, role: m.role as Message['role'], text: String(m.text), at: String(m.at), traceId: (m.trace_id as string) ?? null, meta: J.parse(m.meta, null) }));
}
export function loadCustomer(id: string | null): Customer | null {
  if (!id) return null;
  const c = db().get('SELECT * FROM customers WHERE id=?', id);
  return c ? { id: String(c.id), name: String(c.name), phone: String(c.phone), level: c.level as Customer['level'], channel: c.channel as Customer['channel'], tags: J.parse(c.tags, []), note: (c.note as string) ?? '' } : null;
}
export function appendMessage(conversationId: string, role: Message['role'], text: string, extra: { traceId?: string | null; meta?: Record<string, unknown> | null } = {}) {
  const id = uid('m-');
  const at = nowIso();
  db().run('INSERT INTO messages VALUES (?,?,?,?,?,?,?)', id, conversationId, role, text, at, extra.traceId ?? null, extra.meta ? J.str(extra.meta) : null);
  db().run('UPDATE conversations SET last_message_at=? WHERE id=?', at, conversationId);
  return { id, conversationId, role, text, at, traceId: extra.traceId ?? null, meta: extra.meta ?? null } as Message;
}
export function saveTrace(t: Trace) {
  db().run('INSERT OR REPLACE INTO traces VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', t.id, t.conversationId, t.agentId, t.agentVersion, t.createdAt, t.scenario, t.intent, t.autonomy?.decision ?? null, t.risk?.level ?? null, t.totalDurationMs, t.status, J.str(t));
}
export function loadTrace(id: string): Trace | null {
  const r = db().get<{ doc: string }>('SELECT doc FROM traces WHERE id=?', id);
  return r ? J.parse<Trace | null>(r.doc, null) : null;
}

/* ───────────── 执行链入口 ───────────── */
export interface RunOptions {
  agentId?: string;
  /** bot：机器人接待，自主回复直接落库；assist：坐席辅助，仅返回建议 */
  mode: 'bot' | 'assist';
  persistUserMessage?: boolean;
}

export async function runForConversation(conversationId: string, text: string, opts: RunOptions) {
  const d = db();
  const row = d.get('SELECT * FROM conversations WHERE id=?', conversationId);
  if (!row) throw Object.assign(new Error('会话不存在'), { status: 404 });
  const conv = rowToConversation(row);
  const agent = loadAgent(opts.agentId ?? (row.agent_id as string) ?? undefined);
  const messages = loadMessages(conversationId);
  const customer = loadCustomer(conv.customerId);
  const lastTrace = d.get<{ doc: string }>('SELECT doc FROM traces WHERE conversation_id=? ORDER BY created_at DESC LIMIT 1', conversationId);
  const prev = lastTrace ? J.parse<Trace | null>(lastTrace.doc, null) : null;
  const history = { slots: Object.fromEntries((prev?.slots ?? []).filter((s) => s.value && s.source !== 'missing').map((s) => [s.key, s.value!])), scenario: prev?.scenario ?? conv.scenario };

  let userMessage: Message | null = null;
  if (opts.persistUserMessage !== false) userMessage = appendMessage(conversationId, 'user', text);

  const ctx: ChainContext = {
    llm,
    tools,
    index: knowledgeIndex(),
    agent,
    conversation: { id: conversationId, customerId: conv.customerId, channel: conv.channel, messages },
    customer,
    history,
    traceId: uid('tr-'),
  };
  const trace = await runChain(ctx, { text });
  saveTrace(trace);
  if (userMessage) d.run('UPDATE messages SET trace_id=? WHERE id=?', trace.id, userMessage.id);

  let botMessage: Message | null = null;
  const decision = trace.autonomy?.decision ?? 'escalate';
  d.run('UPDATE conversations SET scenario=? WHERE id=?', trace.scenario, conversationId);
  if (opts.mode === 'bot') {
    if (decision === 'auto_reply' && trace.reply) {
      botMessage = appendMessage(conversationId, 'bot', trace.reply.text, { traceId: trace.id, meta: { kind: trace.reply.kind, risk: trace.risk?.level } });
    } else {
      const p = trace.autonomy?.priority ?? 'P2';
      d.run("UPDATE conversations SET controller='human', status='waiting_human', priority=? WHERE id=?", p, conversationId);
      botMessage = appendMessage(conversationId, 'bot', trace.reply?.kind === 'handoff' ? trace.reply.text : `您的问题需要人工客服进一步核实，已为您转接（优先级 ${p}）。`, { traceId: trace.id, meta: { kind: 'handoff', decision, priority: p } });
      appendMessage(conversationId, 'system', `【${decision === 'human_confirm' ? '待人工确认' : '升级人工'} ${p}】${trace.reply?.internalNote ?? ''}`, { traceId: trace.id, meta: { internal: true } });
    }
  }
  if (trace.scenario && ['logistics', 'invoice', 'refund_price_diff'].includes(trace.scenario)) {
    d.run('INSERT INTO employee_runs VALUES (?,?,?,?,?,?,?,?)', uid('er-'), trace.scenario, trace.id, conversationId, trace.createdAt, decision, trace.risk?.level ?? null, trace.reply?.internalNote?.split('\n')[1] ?? '');
  }
  return { trace, userMessage, botMessage, conversation: rowToConversation(d.get('SELECT * FROM conversations WHERE id=?', conversationId)!) };
}

/** 无会话上下文的单次试跑（Agent Studio 测试台 / Benchmark） */
export async function runStandalone(text: string, opts: { agent?: AgentConfig; customerId?: string | null; channel?: string } = {}) {
  const agent = opts.agent ?? loadAgent();
  const customer = loadCustomer(opts.customerId ?? null);
  const ctx: ChainContext = {
    llm,
    tools,
    index: knowledgeIndex(),
    agent,
    conversation: { id: `sandbox-${uid()}`, customerId: customer?.id ?? null, channel: opts.channel ?? 'web', messages: [] },
    customer,
    history: { slots: {}, scenario: null },
    traceId: uid('tr-'),
  };
  // 沙箱中不允许动作工具真正建单
  const sandboxTools = new ToolRegistry();
  for (const t of tools.list()) {
    const def = tools.get(t.name)!;
    sandboxTools.register(def.mutating ? { ...def, run: async () => ({ id: 'SANDBOX', note: '沙箱未执行' }) } : def);
  }
  ctx.tools = sandboxTools;
  const trace = await runChain(ctx, { text });
  saveTrace(trace);
  return trace;
}
