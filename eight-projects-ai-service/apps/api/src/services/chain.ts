import { BM25Index, LlmClient, LlmRouter, MockLlmClient, ToolRegistry, runChain, type ChainContext, type LlmBase } from '@eight/agent-core';
import type { AgentConfig, Conversation, Customer, KnowledgeChunk, Message, StageRecord, Trace } from '@eight/shared';
import { J, hasVector, nowIso, openDb, uid } from '../db.ts';
import { env } from '../env.ts';
import { embeddingFromEnv } from './embeddings.ts';
import { HybridRetriever, VectorStore } from './retriever.ts';
import { DEFAULT_AGENT } from '../seed.ts';
import { createCase } from '../routes/cases.ts';
import { ensureHandoffTask, windowSentence } from './handoff.ts';
import { whitelistFor } from './whitelist.ts';
import { PlatformUnavailable, detectPlatformOrder, platformSourceFromEnv, type PlatformDataSource } from './platform-data.ts';

const db = () => openDb();

/* ───────────── 模型路由：主 provider → 备用 provider；LLM_MOCK=1 时只用离线假模型 ───────────── */
function buildRouter() {
  const providers: (LlmBase & { id: string })[] = [];
  if (env.llmMock) providers.push(new MockLlmClient());
  else {
    providers.push(new LlmClient({ id: 'primary', ...env.llm }));
    if (env.llmFallback.baseUrl && env.llmFallback.apiKey && env.llmFallback.modelFast) providers.push(new LlmClient({ id: 'fallback', ...env.llmFallback, timeoutMs: env.llm.timeoutMs }));
  }
  return new LlmRouter(providers, env.router);
}
export const llm = buildRouter();

/* ───────────── 电商平台只读数据源（CS-018）：本地库未命中且订单号为平台形态时作为证据来源 ───────────── */
export const platformSource: PlatformDataSource | null = platformSourceFromEnv();
async function platformLookup<T>(orderId: string, fn: (s: PlatformDataSource) => Promise<T | null>): Promise<{ hit: T | null; unavailable: boolean; source: string | null; reason?: string }> {
  if (!platformSource || !detectPlatformOrder(orderId)) return { hit: null, unavailable: false, source: null };
  const source = `${platformSource.platform}-${platformSource.mode}`;
  try {
    return { hit: await fn(platformSource), unavailable: false, source };
  } catch (e) {
    const kind = e instanceof PlatformUnavailable ? e.kind : 'error';
    return { hit: null, unavailable: true, source, reason: `${kind}：${(e as Error).message}` };
  }
}

/* ───────────── 知识索引：BM25（发布态 chunk）+ 向量（pgvector，供应商可用时） ───────────── */
const bm25 = new BM25Index();
export const embeddingProvider = embeddingFromEnv();
let vectorStoreInst: VectorStore | null | undefined;
/** 向量库：initDb 之后才知道 pgvector 是否可用，因此惰性创建 */
export function getVectorStore(): VectorStore | null {
  if (vectorStoreInst === undefined) vectorStoreInst = embeddingProvider && hasVector() ? new VectorStore(embeddingProvider) : null;
  return vectorStoreInst;
}
let retriever: HybridRetriever | null = null;
/** 检索器（混合或纯 BM25）：注入执行链 ChainContext.index */
export function knowledgeIndex(): HybridRetriever {
  return (retriever ??= new HybridRetriever(bm25, getVectorStore(), embeddingProvider));
}
/** 重建 BM25；返回已发布块数。向量缺口由 scheduleMissingEmbeddings 补齐（异步） */
export async function refreshIndex() {
  const rows = await db().all<{ id: string; doc_id: string; seq: number; text: string; tags: string; title: string }>(
    `SELECT c.id, c.doc_id, c.seq, c.text, c.tags, d.title FROM knowledge_chunks c JOIN knowledge_docs d ON d.id=c.doc_id WHERE d.status='published'`,
  );
  const chunks = rows.map((r) => ({ docTitle: r.title, chunk: { id: r.id, docId: r.doc_id, seq: r.seq, text: r.text, tags: J.parse<string[]>(r.tags, []) } as KnowledgeChunk }));
  bm25.rebuild(chunks);
  return chunks.length;
}
/** 为指定文档（或全部缺失块）写入向量；供作业与同步路径调用 */
export async function embedDoc(docId: string | null): Promise<number> {
  const vectorStore = getVectorStore();
  if (!vectorStore) return 0;
  const rows = docId
    ? await db().all<{ id: string; doc_id: string; text: string; title: string }>("SELECT c.id, c.doc_id, c.text, d.title FROM knowledge_chunks c JOIN knowledge_docs d ON d.id=c.doc_id WHERE d.status='published' AND c.doc_id=?", docId)
    : await (async () => {
        const missing = await vectorStore.missingPublishedChunkIds();
        if (!missing.length) return [];
        return db().all<{ id: string; doc_id: string; text: string; title: string }>(`SELECT c.id, c.doc_id, c.text, d.title FROM knowledge_chunks c JOIN knowledge_docs d ON d.id=c.doc_id WHERE c.id IN (${missing.map(() => '?').join(',')})`, ...missing);
      })();
  if (!rows.length) return 0;
  return vectorStore.upsertChunks(rows.map((r) => ({ id: r.id, docId: r.doc_id, text: r.text, title: r.title })));
}
export async function vectorStats() {
  const vectorStore = getVectorStore();
  if (!vectorStore || !embeddingProvider) return { enabled: false as const, provider: null, model: null, count: 0, published: bm25.size, coverage: 0 };
  const count = await vectorStore.count();
  const published = bm25.size;
  return { enabled: true as const, provider: embeddingProvider.id, model: embeddingProvider.model, dims: embeddingProvider.dims, count, published, coverage: published ? Number((Math.min(count, published) / published).toFixed(3)) : 0, mode: knowledgeIndex().mode };
}

/* ───────────── 业务工具（模拟业务系统，数据来自本库；接真实平台数据源时只替换 run） ───────────── */
export const tools = new ToolRegistry()
  .register({
    name: 'crm.lookupCustomer',
    label: 'CRM 客户档案',
    description: '按客户 ID 查询等级、标签、历史订单数',
    requires: ['customerId'],
    run: async (a) => {
      const c = await db().get('SELECT * FROM customers WHERE id=?', String(a.customerId));
      if (!c) throw new Error('客户不存在');
      const orders = await db().all<{ id: string; status: string; product: string; created_at: string }>('SELECT id,status,product,created_at FROM orders WHERE customer_id=? ORDER BY created_at DESC', String(a.customerId));
      return { id: c.id, name: c.name, level: c.level, tags: J.parse(c.tags, []), note: c.note, recentOrders: orders.slice(0, 5) };
    },
  })
  .register({
    name: 'orders.lookup',
    label: '订单查询',
    description: '按订单号查询订单状态、金额、商品、地址（本地订单或电商平台只读数据）',
    requires: ['orderId'],
    run: async (a) => {
      const id = String(a.orderId);
      const o = await db().get('SELECT * FROM orders WHERE id=?', id);
      if (!o) {
        const p = await platformLookup(id, (s) => s.getOrder(id));
        if (p.hit === null && p.unavailable) return { orderId: id, unavailable: true, source: p.source, reason: p.reason, note: '电商平台数据暂不可用，无法核实订单' };
        if (p.hit) return { orderId: p.hit.orderId, product: p.hit.items.map((i) => i.title).join('、'), sku: p.hit.items.map((i) => i.skuText).join('；'), listPrice: p.hit.amount, paidAmount: p.hit.paidAmount, status: p.hit.status, statusText: p.hit.statusText, createdAt: p.hit.createdAt, paidAt: p.hit.paidAt, shippedAt: p.hit.shippedAt, receiver: p.hit.receiver, buyerNick: p.hit.buyerNickMasked, source: p.hit.source, readOnly: true, belongsToCustomer: null };
        throw new Error(`订单 ${id} 不存在${detectPlatformOrder(id) ? '（电商平台未查到）' : ''}`);
      }
      return { orderId: o.id, product: o.product, sku: o.sku, listPrice: o.amount, paidAmount: o.paid_amount, status: o.status, createdAt: o.created_at, paidAt: o.paid_at, shippedAt: o.shipped_at, address: o.address, priceProtectDays: o.price_protect_days, source: 'local', belongsToCustomer: a.customerId ? o.customer_id === a.customerId : null };
    },
  })
  .register({
    name: 'logistics.track',
    label: '物流轨迹',
    description: '按订单号查询承运商、运单号、最新状态与轨迹',
    requires: ['orderId'],
    run: async (a) => {
      const id = String(a.orderId);
      const l = await db().get('SELECT * FROM logistics WHERE order_id=?', id);
      if (!l) {
        const o = await db().get<{ status: string }>('SELECT status FROM orders WHERE id=?', id);
        if (!o) {
          const p = await platformLookup(id, (s) => s.getLogistics(id));
          if (p.unavailable) return { orderId: id, unavailable: true, source: p.source, reason: p.reason, note: '电商平台物流数据暂不可用' };
          if (p.hit) return { orderId: id, carrier: p.hit.company, trackingNo: p.hit.trackingNo, status: p.hit.status, lastUpdate: p.hit.lastUpdate, hoursSinceUpdate: p.hit.hoursSinceUpdate, stalled: p.hit.stalled, events: p.hit.events, source: p.hit.source, readOnly: true };
          if (p.source) {
            const po = await platformLookup(id, (s) => s.getOrder(id));
            if (po.hit) return { orderId: id, status: po.hit.status === 'WAIT_SELLER_SEND_GOODS' ? 'not_shipped' : 'no_logistics', note: po.hit.status === 'WAIT_SELLER_SEND_GOODS' ? '平台订单已付款尚未发货' : '平台暂无物流记录', source: po.hit.source };
          }
          throw new Error('订单不存在');
        }
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
      const i = await db().get('SELECT * FROM invoices WHERE order_id=?', String(a.orderId));
      if (!i) {
        const o = await db().get<{ status: string }>('SELECT status FROM orders WHERE id=?', String(a.orderId));
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
      const id = String(a.orderId);
      const rows = await db().all('SELECT * FROM refunds WHERE order_id=? ORDER BY applied_at DESC', id);
      if (!rows.length && detectPlatformOrder(id)) {
        const p = await platformLookup(id, (s) => s.getRefunds(id));
        if (p.unavailable) return { orderId: id, unavailable: true, source: p.source, reason: p.reason, refunds: [], count: 0 };
        if (p.hit) return { orderId: id, refunds: p.hit.map((r) => ({ id: r.refundId, type: 'refund', amount: r.amount, status: r.status, statusText: r.statusText, appliedAt: r.createdAt, processedAt: r.modifiedAt, reason: r.reason })), count: p.hit.length, source: p.hit[0]?.source ?? 'tmall', readOnly: true };
      }
      return { orderId: a.orderId, refunds: rows.map((r) => ({ id: r.id, type: r.type, amount: r.amount, status: r.status, appliedAt: r.applied_at, processedAt: r.processed_at, reason: r.reason, eta: r.channel_eta })), count: rows.length, source: 'local' };
    },
  })
  .register({
    name: 'pricing.priceDifference',
    label: '保价/差价核算',
    description: '按订单号核算是否在保价期内以及可退差价',
    requires: ['orderId'],
    run: async (a) => {
      const o = await db().get('SELECT * FROM orders WHERE id=?', String(a.orderId));
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
      const rows = await db().all<{ product: string; sku: string; amount: number }>('SELECT DISTINCT product, sku, amount FROM orders');
      const kw = String(a.product ?? '').trim();
      return { items: rows.filter((r) => !kw || r.product.includes(kw) || r.sku.includes(kw)).map((r) => ({ product: r.product, sku: r.sku, listPrice: r.amount, inStock: true })) };
    },
  })
  .register({
    name: 'cases.create',
    label: '拆出子案件',
    description: '把当前诉求拆为本地子案件供人工跟进（动作工具，仅在自治门禁允许时执行；不会写 DMS）',
    requires: ['conversationId'],
    mutating: true,
    run: async (a) => {
      const conv = await db().get<{ customer_id: string; title: string }>('SELECT customer_id,title FROM conversations WHERE id=?', String(a.conversationId));
      const type = ({ logistics: '物流', invoice: '发票', refund_price_diff: '退款', complaint: '投诉', presale: '售前' } as Record<string, string>)[String(a.scenario)] ?? '其他';
      const slots = Object.fromEntries(Object.entries(a).filter(([k, v]) => ['orderId', 'phone', 'invoiceTitle', 'taxId'].includes(k) && v != null).map(([k, v]) => [k, String(v)]));
      const c = await createCase(db(), {
        title: String(a.title ?? '执行链自动拆案'),
        type,
        priority: 'P2',
        description: `由执行链自动拆出。${a.reason ?? ''}`.trim(),
        conversationId: String(a.conversationId),
        customerId: conv?.customer_id ?? null,
        assignee: null,
        evidence: { slots, traceIds: a.traceId ? [String(a.traceId)] : [] },
        source: 'chain',
        actor: '执行链',
      });
      return { id: c.id, type: c.type, status: c.status };
    },
  });

/* ───────────── Agent 配置 ───────────── */
export async function loadAgent(id = DEFAULT_AGENT.id): Promise<AgentConfig> {
  const row = await db().get<{ doc: string }>('SELECT doc FROM agents WHERE id=?', id);
  return row ? J.parse<AgentConfig>(row.doc, DEFAULT_AGENT) : DEFAULT_AGENT;
}

/* ───────────── 会话读取 ───────────── */
export async function rowToConversation(r: Record<string, unknown>): Promise<Conversation> {
  const name = (await db().get<{ name: string }>('SELECT name FROM customers WHERE id=?', String(r.customer_id)))?.name ?? '匿名访客';
  const count = (await db().get<{ n: number }>('SELECT COUNT(*)::int n FROM messages WHERE conversation_id=?', String(r.id)))?.n ?? 0;
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
    satisfaction: (r.satisfaction as number) ?? null,
  };
}
export async function loadMessages(conversationId: string): Promise<Message[]> {
  const rows = await db().all('SELECT * FROM messages WHERE conversation_id=? ORDER BY at ASC', conversationId);
  return rows.map((m) => ({ id: String(m.id), conversationId, role: m.role as Message['role'], text: String(m.text), at: String(m.at), traceId: (m.trace_id as string) ?? null, meta: J.parse(m.meta, null) }));
}
export async function loadCustomer(id: string | null): Promise<Customer | null> {
  if (!id) return null;
  const c = await db().get('SELECT * FROM customers WHERE id=?', id);
  return c ? { id: String(c.id), name: String(c.name), phone: String(c.phone), level: c.level as Customer['level'], channel: c.channel as Customer['channel'], tags: J.parse(c.tags, []), note: (c.note as string) ?? '' } : null;
}
export async function appendMessage(conversationId: string, role: Message['role'], text: string, extra: { traceId?: string | null; meta?: Record<string, unknown> | null } = {}) {
  const id = uid('m-');
  const at = nowIso();
  await db().run('INSERT INTO messages VALUES (?,?,?,?,?,?,?)', id, conversationId, role, text, at, extra.traceId ?? null, extra.meta ? J.str(extra.meta) : null);
  await db().run('UPDATE conversations SET last_message_at=? WHERE id=?', at, conversationId);
  return { id, conversationId, role, text, at, traceId: extra.traceId ?? null, meta: extra.meta ?? null } as Message;
}
export async function saveTrace(t: Trace) {
  await db().run(
    `INSERT INTO traces (id,conversation_id,agent_id,agent_version,created_at,scenario,intent,decision,risk_level,duration_ms,status,doc,degraded,failed_over,llm_calls)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (id) DO UPDATE SET conversation_id=EXCLUDED.conversation_id, agent_id=EXCLUDED.agent_id, agent_version=EXCLUDED.agent_version, created_at=EXCLUDED.created_at, scenario=EXCLUDED.scenario, intent=EXCLUDED.intent, decision=EXCLUDED.decision, risk_level=EXCLUDED.risk_level, duration_ms=EXCLUDED.duration_ms, status=EXCLUDED.status, doc=EXCLUDED.doc, degraded=EXCLUDED.degraded, failed_over=EXCLUDED.failed_over, llm_calls=EXCLUDED.llm_calls`,
    t.id, t.conversationId, t.agentId, t.agentVersion, t.createdAt, t.scenario, t.intent, t.autonomy?.decision ?? null, t.risk?.level ?? null, t.totalDurationMs, t.status, J.str(t), t.degraded ? 1 : 0, t.failedOver ? 1 : 0, t.usage.calls);
}
export async function loadTrace(id: string): Promise<Trace | null> {
  const r = await db().get<{ doc: string }>('SELECT doc FROM traces WHERE id=?', id);
  return r ? J.parse<Trace | null>(r.doc, null) : null;
}

/* ───────────── 执行链入口 ───────────── */
export interface RunOptions {
  agentId?: string;
  /** bot：机器人接待，自主回复直接落库；assist：坐席辅助，仅返回建议 */
  mode: 'bot' | 'assist';
  persistUserMessage?: boolean;
  /** 阶段进度回调（SSE） */
  onStage?: (stage: StageRecord, trace: Trace) => void;
}

export async function runForConversation(conversationId: string, text: string, opts: RunOptions) {
  const d = db();
  const row = await d.get('SELECT * FROM conversations WHERE id=?', conversationId);
  if (!row) throw Object.assign(new Error('会话不存在'), { status: 404 });
  const conv = await rowToConversation(row);
  const agent = await loadAgent(opts.agentId ?? (row.agent_id as string) ?? undefined);
  const messages = await loadMessages(conversationId);
  const customer = await loadCustomer(conv.customerId);
  const lastTrace = await d.get<{ doc: string }>('SELECT doc FROM traces WHERE conversation_id=? ORDER BY created_at DESC LIMIT 1', conversationId);
  const prev = lastTrace ? J.parse<Trace | null>(lastTrace.doc, null) : null;
  const history = { slots: Object.fromEntries((prev?.slots ?? []).filter((s) => s.value && s.source !== 'missing').map((s) => [s.key, s.value!])), scenario: prev?.scenario ?? conv.scenario };

  let userMessage: Message | null = null;
  if (opts.persistUserMessage !== false) userMessage = await appendMessage(conversationId, 'user', text);

  const ctx: ChainContext = {
    llm,
    tools,
    index: knowledgeIndex(),
    agent,
    conversation: { id: conversationId, customerId: conv.customerId, channel: conv.channel, messages },
    customer,
    history,
    traceId: uid('tr-'),
    onStage: opts.onStage,
    // 预计人工响应时窗按工作日历 + 优先级档位计算（CS-008G/I），与接续任务里记录的一致
    responseWindow: (p) => windowSentence(p),
    whitelist: await whitelistFor(conv.channel),
  };
  const trace = await runChain(ctx, { text });
  await saveTrace(trace);
  if (userMessage) await d.run('UPDATE messages SET trace_id=? WHERE id=?', trace.id, userMessage.id);

  let botMessage: Message | null = null;
  const decision = trace.autonomy?.decision ?? 'escalate';
  await d.run('UPDATE conversations SET scenario=? WHERE id=?', trace.scenario, conversationId);
  if (opts.mode === 'bot') {
    // 单一来源：对客发送的文本永远等于 trace.reply.text（自主回复=候选话术；人工确认/升级=等待或转接提示）
    const reply = trace.reply!;
    if (decision === 'auto_reply') {
      botMessage = await appendMessage(conversationId, 'bot', reply.text, { traceId: trace.id, meta: { kind: reply.kind, risk: trace.risk?.level } });
    } else {
      const p = trace.autonomy?.priority ?? 'P2';
      await d.run("UPDATE conversations SET controller='human', status='waiting_human', priority=? WHERE id=?", p, conversationId);
      botMessage = await appendMessage(conversationId, 'bot', reply.text, { traceId: trace.id, meta: { kind: reply.kind, decision, priority: p } });
      // 人工接续任务（CS-008E）：保存已完成步骤、证据、缺项、候选话术与下一步；同会话只有一个活动任务
      const { task, created } = await ensureHandoffTask({
        conversationId,
        channel: conv.channel,
        priority: p,
        reason: trace.autonomy?.reasons.join('；') ?? '执行链转人工',
        progress: {
          doneStages: trace.stages.filter((s) => s.status === 'ok').map((s) => s.id),
          evidence: (trace.evidence ?? []).filter((i) => i.ok).map((i) => i.id),
          missing: trace.slots.filter((s) => s.source === 'missing').map((s) => s.key),
          candidate: reply.candidate ?? null,
          failure: trace.degraded ? `规则降级：${trace.degradedReason ?? '模型不可用'}` : null,
          nextAction: decision === 'human_confirm' ? '核实候选话术后发送' : '接续会话并处理诉求',
        },
        traceId: trace.id,
      });
      await appendMessage(conversationId, 'system', `【${decision === 'human_confirm' ? '待人工确认' : '升级人工'} ${p} · 接续任务 ${task.id}${created ? '' : '（追加）'}】${reply.internalNote}`, { traceId: trace.id, meta: { internal: true, candidate: reply.candidate, handoffId: task.id } });
    }
  }
  if (trace.scenario && ['logistics', 'invoice', 'refund_price_diff'].includes(trace.scenario)) {
    await d.run('INSERT INTO employee_runs VALUES (?,?,?,?,?,?,?,?)', uid('er-'), trace.scenario, trace.id, conversationId, trace.createdAt, decision, trace.risk?.level ?? null, trace.reply?.internalNote?.split('\n')[1] ?? '');
  }
  return { trace, userMessage, botMessage, conversation: await rowToConversation((await d.get('SELECT * FROM conversations WHERE id=?', conversationId))!) };
}

/** 无会话上下文的单次试跑（Agent Studio 测试台 / Benchmark / L1 回放：可注入决策时点的历史消息与槽位） */
export async function runStandalone(
  text: string,
  opts: { agent?: AgentConfig; customerId?: string | null; channel?: string; messages?: Message[]; history?: { slots: Record<string, string>; scenario: string | null }; conversationId?: string; persist?: boolean; at?: Date } = {},
) {
  const agent = opts.agent ?? (await loadAgent());
  const customer = await loadCustomer(opts.customerId ?? null);
  const ctx: ChainContext = {
    llm,
    tools,
    index: knowledgeIndex(),
    agent,
    conversation: { id: opts.conversationId ?? `sandbox-${uid()}`, customerId: customer?.id ?? null, channel: opts.channel ?? 'web', messages: opts.messages ?? [] },
    customer,
    history: opts.history ?? { slots: {}, scenario: null },
    traceId: uid('tr-'),
    responseWindow: (p) => windowSentence(p),
    whitelist: await whitelistFor(opts.channel ?? 'web', opts.at),
  };
  // 沙箱中不允许动作工具真正建单
  const sandboxTools = new ToolRegistry();
  for (const t of tools.list()) {
    const def = tools.get(t.name)!;
    sandboxTools.register(def.mutating ? { ...def, run: async () => ({ id: 'SANDBOX', note: '沙箱未执行' }) } : def);
  }
  ctx.tools = sandboxTools;
  const trace = await runChain(ctx, { text });
  if (opts.persist !== false) await saveTrace(trace);
  return trace;
}
