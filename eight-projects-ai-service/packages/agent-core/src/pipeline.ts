import { z } from 'zod';
import type {
  AgentConfig,
  AutonomyResult,
  Citation,
  Customer,
  EvidenceItem,
  KnowledgeHit,
  Message,
  Priority,
  ProposedAction,
  RiskAssessment,
  RiskLevel,
  ScenarioPack,
  Slot,
  StageId,
  StageRecord,
  Trace,
} from '@eight/shared';
import { STAGE_LABELS } from '@eight/shared';
import { LlmClient, LlmError, sumUsage } from './llm.js';
import type { LlmUsage } from '@eight/shared';
import { BM25Index } from './retrieval.js';
import { ToolRegistry } from './tools.js';
import { SCENARIO_PACKS, scenarioById } from './scenarios.js';

export interface ChainContext {
  llm: LlmClient;
  tools: ToolRegistry;
  index: BM25Index;
  agent: AgentConfig;
  conversation: { id: string; customerId: string | null; channel: string; messages: Message[] };
  customer: Customer | null;
  /** 上一轮 trace 留下的槽位与场景，用于跨轮实体延续 */
  history: { slots: Record<string, string>; scenario: string | null };
  traceId: string;
  now?: () => string;
}

const RISK_ORDER: RiskLevel[] = ['L0', 'L1', 'L2', 'L3'];
const riskRank = (l: RiskLevel) => RISK_ORDER.indexOf(l);
const maxRisk = (a: RiskLevel, b: RiskLevel) => (riskRank(a) >= riskRank(b) ? a : b);
const minRisk = (a: RiskLevel, b: RiskLevel) => (riskRank(a) <= riskRank(b) ? a : b);

const SLOT_LABELS: Record<string, string> = {
  orderId: '订单号',
  trackingNo: '运单号',
  phone: '手机号',
  amount: '金额',
  invoiceTitle: '发票抬头',
  taxId: '税号',
  product: '商品/型号',
  address: '收货地址',
  customerLevel: '客户等级',
};

const GREETING = /^(你好|您好|在吗|有人吗|hi|hello|哈喽|嗨)[!！。.~～\s]*$/i;
const THANKS = /^(谢谢|感谢|好的谢谢|thx|thanks|辛苦了)[!！。.~～\s]*$/i;
const HUMAN_REQUEST = /(转|找|要|叫|换).{0,3}人工|真人客服|人工客服|人工服务/;

export async function runChain(ctx: ChainContext, input: { text: string }): Promise<Trace> {
  const now = ctx.now ?? (() => new Date().toISOString());
  const stages: StageRecord[] = [];
  const usages: LlmUsage[] = [];
  const started = Date.now();
  const agent = ctx.agent;

  const trace: Trace = {
    id: ctx.traceId,
    conversationId: ctx.conversation.id,
    agentId: agent.id,
    agentVersion: agent.version,
    createdAt: now(),
    input: { text: input.text, turn: 0 },
    scenario: null,
    intent: null,
    slots: [],
    evidence: [],
    knowledge: [],
    reasoning: null,
    risk: null,
    autonomy: null,
    reply: null,
    stages,
    totalDurationMs: 0,
    usage: { promptTokens: 0, completionTokens: 0, calls: 0 },
    status: 'completed',
    error: null,
  };

  async function stage<T>(id: StageId, fn: () => Promise<{ summary: string; detail: Record<string, unknown>; value: T; llm?: LlmUsage[] }>): Promise<T | null> {
    const startedAt = now();
    const t0 = Date.now();
    try {
      const r = await fn();
      if (r.llm?.length) usages.push(...r.llm);
      stages.push({ id, label: STAGE_LABELS[id], status: 'ok', startedAt, durationMs: Date.now() - t0, summary: r.summary, detail: r.detail, llm: r.llm?.at(-1) ?? null });
      return r.value;
    } catch (e) {
      const msg = e instanceof LlmError ? `${e.code}: ${e.message}` : (e as Error).message;
      stages.push({ id, label: STAGE_LABELS[id], status: 'error', startedAt, durationMs: Date.now() - t0, summary: `阶段失败：${msg}`, detail: { error: msg } });
      trace.status = 'failed';
      trace.error = msg;
      return null;
    }
  }

  // ───────────────────────── 1. 用户输入 ─────────────────────────
  const intake = await stage('intake', async () => {
    const text = input.text.trim();
    const history = ctx.conversation.messages;
    const turn = history.filter((m) => m.role === 'user').length + 1;
    const botTurns = history.filter((m) => m.role === 'bot').length;
    const window = history.slice(-12).map((m) => ({ role: m.role, text: m.text.slice(0, 600) }));
    const greeting = GREETING.test(text);
    const thanks = THANKS.test(text);
    const requestHuman = HUMAN_REQUEST.test(text) || agent.handoffRules.keywords.some((k) => k && text.includes(k));
    trace.input = { text, turn };
    return {
      summary: `第 ${turn} 轮用户输入，${text.length} 字；机器人已回复 ${botTurns} 轮${greeting ? '；命中寒暄规则' : ''}${requestHuman ? '；用户要求人工' : ''}`,
      detail: { turn, botTurns, greeting, thanks, requestHuman, window },
      value: { text, turn, botTurns, window, greeting, thanks, requestHuman },
    };
  });
  if (!intake) return finish();

  // ───────────────────────── 2. 信息补全 ─────────────────────────
  const completion = await stage('completion', async () => {
    const slots = new Map<string, Slot>();
    const put = (key: string, value: string | null, source: Slot['source']) => {
      if (!value) return;
      if (slots.has(key) && slots.get(key)!.source !== 'missing') return;
      slots.set(key, { key, label: SLOT_LABELS[key] ?? key, value, source, required: false });
    };
    // 2a 正则从本轮与历史用户消息抽取
    const userTexts = [intake.text, ...ctx.conversation.messages.filter((m) => m.role === 'user').map((m) => m.text).reverse()];
    for (const [i, t] of userTexts.entries()) {
      const src: Slot['source'] = i === 0 ? 'regex' : 'history';
      put('orderId', t.match(/(?:订单|单号|order)?[号:：#\s]*\b(20\d{8,14})\b/i)?.[1] ?? null, src);
      put('trackingNo', t.match(/\b((?:SF|YT|JD|ZTO|STO|YD)\d{10,15})\b/i)?.[1]?.toUpperCase() ?? null, src);
      put('phone', t.match(/\b(1[3-9]\d{9})\b/)?.[1] ?? null, src);
      put('amount', t.match(/(?:¥|￥)?\s*(\d+(?:\.\d{1,2})?)\s*(?:元|块)/)?.[1] ?? null, src);
      put('taxId', t.match(/\b(9[0-9A-Z]{17})\b/)?.[1] ?? null, src);
    }
    // 2b 上一轮 trace 的槽位延续
    for (const [k, v] of Object.entries(ctx.history.slots)) put(k, v, 'history');
    // 2c CRM 补全
    if (ctx.customer) {
      put('phone', ctx.customer.phone, 'crm');
      put('customerLevel', ctx.customer.level, 'crm');
    }
    const list = [...slots.values()];
    const bySource = list.reduce<Record<string, number>>((a, s) => ((a[s.source] = (a[s.source] ?? 0) + 1), a), {});
    return {
      summary: list.length ? `补全 ${list.length} 个槽位：${list.map((s) => `${s.label}=${s.value}（${s.source}）`).join('，')}` : '本轮没有可从上下文补全的结构化信息',
      detail: { slots: list, bySource, customer: ctx.customer ? { id: ctx.customer.id, level: ctx.customer.level, tags: ctx.customer.tags } : null },
      value: slots,
    };
  });
  if (!completion) return finish();

  // ───────────────────────── 3. 意图/场景识别 ─────────────────────────
  const IntentSchema = z.object({
    scenario: z.string(),
    intent: z.string().min(1).max(60),
    confidence: z.number().min(0).max(1),
    entities: z.record(z.string(), z.string().nullable()).default({}),
    flags: z.array(z.string()).default([]),
    needHuman: z.boolean().default(false),
    reason: z.string().max(200).default(''),
  });
  type IntentOut = z.infer<typeof IntentSchema>;

  const intent = await stage('intent', async () => {
    const packs = SCENARIO_PACKS.filter((p) => agent.scenarios.includes(p.id));
    let out: IntentOut;
    let llm: LlmUsage[] = [];
    if (intake.greeting || intake.thanks) {
      out = { scenario: 'general', intent: intake.greeting ? '寒暄' : '致谢', confidence: 1, entities: {}, flags: [], needHuman: false, reason: '规则命中' };
    } else {
      const sys = [
        '你是客服意图与场景识别器。根据对话判断当前用户问题属于哪个场景包，抽取实体，标记风险信号。只输出 JSON。',
        '可选场景（scenario 字段只能取其中一个 id）：',
        ...packs.map((p) => `- ${p.id}：${p.name}。${p.description} 例：${p.examples.join(' / ')}`),
        '实体键只能用：orderId, trackingNo, phone, amount, invoiceTitle, taxId, product, address；没有的不要输出或置 null。',
        '实体只能来自用户原话或已知槽位，不能猜测。',
        'flags 可选：complaint(投诉/纠纷), legal(法律/监管/12315), safety(人身安全/医疗), urgent(用户强调紧急), vip, repeat(重复来问), promo(大促相关)。',
        'needHuman：用户明确要求人工，或问题明显超出上述场景时为 true。',
        '输出格式：{"scenario":string,"intent":string,"confidence":number,"entities":object,"flags":string[],"needHuman":boolean,"reason":string}',
      ].join('\n');
      const known = [...completion.values()].map((s) => `${s.key}=${s.value}`).join(', ') || '无';
      const user = [
        `客户等级：${ctx.customer?.level ?? '未知'}；渠道：${ctx.conversation.channel}`,
        `已知槽位：${known}`,
        `上一轮场景：${ctx.history.scenario ?? '无'}`,
        '最近对话：',
        ...intake.window.map((m) => `[${m.role}] ${m.text}`),
        `[user] ${intake.text}`,
      ].join('\n');
      const r = await ctx.llm.chatJson(IntentSchema, [{ role: 'system', content: sys }, { role: 'user', content: user }], { mode: 'fast', maxTokens: 400 });
      out = r.value;
      llm = r.usage;
      if (!packs.some((p) => p.id === out.scenario)) out.scenario = 'general';
    }
    if (intake.requestHuman) {
      out.needHuman = true;
      if (!out.flags.includes('request_human')) out.flags.push('request_human');
    }
    if (ctx.customer?.level && ctx.customer.level !== 'normal' && !out.flags.includes('vip')) out.flags.push('vip');
    // 合并 LLM 实体到槽位（不覆盖更可信的来源）
    for (const [k, v] of Object.entries(out.entities ?? {})) {
      if (v && !completion.has(k)) completion.set(k, { key: k, label: SLOT_LABELS[k] ?? k, value: v, source: 'llm', required: false });
    }
    const pack = scenarioById(out.scenario);
    for (const req of pack.requiredSlots) {
      const s = completion.get(req.key);
      if (s) s.required = true;
      else completion.set(req.key, { key: req.key, label: req.label, value: null, source: 'missing', required: true });
    }
    const missing = pack.requiredSlots.filter((r) => !completion.get(r.key)?.value);
    trace.scenario = pack.id;
    trace.intent = out.intent;
    trace.slots = [...completion.values()];
    return {
      summary: `场景=${pack.name}（${pack.id}），意图「${out.intent}」，置信度 ${out.confidence.toFixed(2)}${out.flags.length ? `，信号：${out.flags.join('/')}` : ''}${missing.length ? `，缺必填槽位：${missing.map((m) => m.label).join('、')}` : ''}`,
      detail: { ...out, pack: pack.id, missingSlots: missing.map((m) => m.key) },
      value: { out, pack, missing },
      llm,
    };
  });
  if (!intent) return finish();
  const pack: ScenarioPack = intent.pack;

  // ───────────────────────── 4. 证据获取 ─────────────────────────
  const evidence = await stage('evidence', async () => {
    const items: EvidenceItem[] = [];
    const slotArgs = Object.fromEntries([...completion.values()].filter((s) => s.value).map((s) => [s.key, s.value!]));
    let seq = 0;
    const skipped: { tool: string; reason: string }[] = [];
    const toolNames = [...new Set(['crm.lookupCustomer', ...pack.tools])].filter((t) => agent.tools.includes(t) || t === 'crm.lookupCustomer');
    for (const name of toolNames) {
      const def = ctx.tools.get(name);
      if (!def) {
        skipped.push({ tool: name, reason: '未注册' });
        continue;
      }
      if (def.mutating) continue;
      const args: Record<string, unknown> = { ...slotArgs, customerId: ctx.conversation.customerId };
      const lacking = def.requires.filter((k) => !args[k]);
      if (lacking.length) {
        skipped.push({ tool: name, reason: `缺少 ${lacking.join('/')}` });
        continue;
      }
      items.push(await ctx.tools.execute(name, args, { conversationId: ctx.conversation.id, customerId: ctx.conversation.customerId, traceId: ctx.traceId }, ++seq));
    }
    const businessTools = pack.tools.filter((t) => agent.tools.includes(t));
    const attempted = items.filter((i) => businessTools.includes(i.tool));
    const okBusiness = attempted.filter((i) => i.ok).length;
    // 完整度只衡量「已尝试」的业务工具；因缺查询键而未尝试的另行记录，不当作工具失败
    const completeness = attempted.length ? okBusiness / attempted.length : businessTools.length ? 0 : 1;
    const unattempted = businessTools.filter((t) => !attempted.some((i) => i.tool === t));
    trace.evidence = items;
    return {
      summary: items.length ? `调用 ${items.length} 个工具，成功 ${items.filter((i) => i.ok).length}；业务证据完整度 ${(completeness * 100).toFixed(0)}%${skipped.length ? `；跳过：${skipped.map((s) => `${s.tool}(${s.reason})`).join('，')}` : ''}` : `无可调用工具${skipped.length ? `（${skipped.map((s) => `${s.tool}:${s.reason}`).join('，')}）` : ''}`,
      detail: { items, skipped, completeness, attempted: attempted.length, unattempted },
      value: { items, completeness, skipped, attempted: attempted.length, unattempted },
    };
  });
  if (!evidence) return finish();

  // ───────────────────────── 5. 知识/工具调用（检索） ─────────────────────────
  const knowledge = await stage('knowledge', async () => {
    const entityText = [...completion.values()].filter((s) => s.value && ['product', 'invoiceTitle'].includes(s.key)).map((s) => s.value).join(' ');
    const query = [intake.text, intent.out.intent, entityText].filter(Boolean).join(' ');
    const { topK, minScore, rewriteOnMiss } = agent.retrieval;
    let hits: KnowledgeHit[] = ctx.index.search(query, { topK, tags: pack.knowledgeTags });
    let rewritten: string[] | null = null;
    let llm: LlmUsage[] = [];
    const weak = !hits.length || hits[0].score < minScore;
    if (weak && rewriteOnMiss && !intake.greeting && ctx.llm.configured) {
      const RewriteSchema = z.object({ queries: z.array(z.string().min(2).max(80)).min(1).max(3) });
      const r = await ctx.llm.chatJson(
        RewriteSchema,
        [
          { role: 'system', content: '你是检索查询改写器。用户当前问题可能省略了前文提到的品牌、型号、商品或主题。请结合对话补全省略实体，改写为 1~3 个适合知识库检索的完整中文查询。只输出 {"queries":[...]}。' },
          { role: 'user', content: `对话：\n${intake.window.map((m) => `[${m.role}] ${m.text}`).join('\n')}\n[user] ${intake.text}\n场景：${pack.name}；意图：${intent.out.intent}` },
        ],
        { mode: 'fast', maxTokens: 200 },
      );
      rewritten = r.value.queries;
      llm = r.usage;
      const merged = new Map<string, KnowledgeHit>(hits.map((h) => [h.id, h]));
      for (const q of rewritten) for (const h of ctx.index.search(q, { topK, tags: pack.knowledgeTags })) if (!merged.has(h.id) || merged.get(h.id)!.score < h.score) merged.set(h.id, h);
      hits = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, topK);
    }
    const kept = hits.filter((h) => h.score >= minScore * 0.6);
    const retrievalConfidence = kept[0]?.score ?? 0;
    trace.knowledge = kept;
    return {
      summary: kept.length ? `召回 ${kept.length} 条知识，最高分 ${retrievalConfidence.toFixed(2)}${rewritten ? `（首轮弱命中，改写后重检：${rewritten.join(' | ')}）` : ''}` : `未召回可用知识${rewritten ? `（已尝试改写：${rewritten.join(' | ')}）` : ''}`,
      detail: { query, rewritten, hits: kept, retrievalConfidence, indexSize: ctx.index.size },
      value: { hits: kept, retrievalConfidence, rewritten },
      llm,
    };
  });
  if (!knowledge) return finish();

  // ───────────────────────── 6. 推理与根因判断 ─────────────────────────
  const ActionType = z.enum(['none', 'clarify', 'create_ticket', 'reship', 'refund', 'price_difference_refund', 'invoice_reissue', 'handoff']);
  const ReasonSchema = z.object({
    rootCause: z.string().max(300),
    analysis: z.string().max(800),
    draft: z.string().min(1).max(1200),
    citations: z.array(z.object({ id: z.string(), quote: z.string().max(200).optional() })).default([]),
    proposedAction: z.object({ type: ActionType, params: z.record(z.string(), z.unknown()).default({}), reason: z.string().max(200).default('') }),
    needsHuman: z.boolean().default(false),
    selfConfidence: z.number().min(0).max(1).default(0.5),
  });

  const reasoning = await stage('reasoning', async () => {
    const allowed = new Set<string>([...knowledge.hits.map((h) => h.id), ...evidence.items.filter((i) => i.ok).map((i) => i.id)]);
    if (intake.greeting || intake.thanks) {
      const draft = intake.greeting ? `您好，欢迎咨询${agent.name}。我可以帮您查物流、处理发票、核对退款/差价，也可以解答产品问题。请问需要什么帮助？` : '不客气，有其他问题随时告诉我。祝您生活愉快！';
      const value = { rootCause: '寒暄/致谢，无业务问题', analysis: '规则直接应答，不调用模型。', draft, citations: [] as Citation[], proposedAction: { type: 'none', params: {}, reason: '无需动作' } as ProposedAction, needsHuman: false };
      trace.reasoning = value;
      return { summary: '规则应答（寒暄/致谢）', detail: { ...value, allowedSources: [...allowed] }, value: { ...value, selfConfidence: 1, invalidCitations: [] as string[] } };
    }
    const sys = [
      agent.persona,
      '',
      '工作规则：',
      '1. 只能依据「证据」与「知识」作答；证据（工具返回的业务数据）优先于用户自述。',
      '2. citations 只能引用给出的来源 id（kb:… 或 tool:…）；没有来源支撑的产品参数、政策、金额、时效不要写进 draft。',
      '3. 不得承诺已经完成退款/补发/赔付/开票；这些属于「动作提案」，由系统按风险决定是否执行或转人工。',
      `4. 本场景允许提案的动作：${pack.allowedAutoActions.join(', ')}，以及 handoff / refund / reship / price_difference_refund / invoice_reissue（后者会进入人工确认）。`,
      '5. 若必填信息缺失，proposedAction.type=clarify，draft 用一句话礼貌追问，不要重复索要已知信息。',
      '6. rootCause 写用户问题的根本原因（基于证据），analysis 写判断链条，draft 是给用户看的最终话术（口语化、分点、不超过 200 字）。',
      '7. 涉及投诉、法律、安全、医疗或证据与用户陈述冲突时 needsHuman=true。',
      '只输出 JSON：{"rootCause":string,"analysis":string,"draft":string,"citations":[{"id":string,"quote":string}],"proposedAction":{"type":string,"params":object,"reason":string},"needsHuman":boolean,"selfConfidence":number}',
    ].join('\n');
    const user = [
      `场景：${pack.name}（${pack.id}）；意图：${intent.out.intent}；风险信号：${intent.out.flags.join('/') || '无'}`,
      `槽位：${trace.slots.map((s) => `${s.label}=${s.value ?? '缺失'}${s.required ? '(必填)' : ''}`).join('；') || '无'}`,
      `缺失必填：${intent.missing.map((m) => m.label).join('、') || '无'}`,
      '',
      '证据（工具返回）：',
      ...(evidence.items.length ? evidence.items.map((i) => `- ${i.id} ${i.label} ${i.ok ? JSON.stringify(i.data).slice(0, 900) : `失败：${i.error}`}`) : ['- 无']),
      '',
      '知识：',
      ...(knowledge.hits.length ? knowledge.hits.map((h) => `- ${h.id} 《${h.docTitle}》：${h.text.slice(0, 500)}`) : ['- 无可用知识']),
      '',
      '对话：',
      ...intake.window.map((m) => `[${m.role}] ${m.text}`),
      `[user] ${intake.text}`,
    ].join('\n');
    const r = await ctx.llm.chatJson(ReasonSchema, [{ role: 'system', content: sys }, { role: 'user', content: user }], { mode: 'reasoning', reasoningEffort: agent.models.reasoningEffort, maxTokens: 2600 });
    const out = r.value;
    const invalidCitations = out.citations.filter((c) => !allowed.has(c.id)).map((c) => c.id);
    const citations = out.citations.filter((c) => allowed.has(c.id));
    let proposedAction = out.proposedAction as ProposedAction;
    let draft = out.draft;
    if (intent.missing.length && proposedAction.type !== 'clarify' && proposedAction.type !== 'handoff') {
      proposedAction = { type: 'clarify', params: { missing: intent.missing.map((m) => m.key) }, reason: '必填信息缺失，系统改为追问' };
      if (!/[?？]/.test(draft)) draft = intent.missing[0].ask;
    }
    const value = { rootCause: out.rootCause, analysis: out.analysis, draft, citations, proposedAction, needsHuman: out.needsHuman };
    trace.reasoning = value;
    return {
      summary: `根因：${out.rootCause.slice(0, 80)}；提案动作=${proposedAction.type}；引用 ${citations.length} 条${invalidCitations.length ? `（剔除无效引用 ${invalidCitations.length} 条）` : ''}${out.needsHuman ? '；模型建议人工介入' : ''}`,
      detail: { ...value, selfConfidence: out.selfConfidence, invalidCitations, modelReasoning: r.reasoning?.slice(0, 1500) ?? null, allowedSources: [...allowed] },
      value: { ...value, selfConfidence: out.selfConfidence, invalidCitations },
      llm: r.usage,
    };
  });

  // 推理失败时的兜底：转人工，但保留已获得的证据与知识
  const reasoningValue = reasoning ?? {
    rootCause: '推理阶段失败',
    analysis: trace.error ?? '模型不可用',
    draft: '您的问题我已记录，稍后由人工客服为您跟进处理，请留意消息。',
    citations: [] as Citation[],
    proposedAction: { type: 'handoff', params: {}, reason: '推理失败兜底' } as ProposedAction,
    needsHuman: true,
    selfConfidence: 0,
    invalidCitations: [] as string[],
  };
  if (!reasoning) trace.reasoning = { ...reasoningValue };

  // ───────────────────────── 7. 风险分级 ─────────────────────────
  const risk = await stage('risk', async () => {
    const flags = [...new Set([...intent.out.flags])];
    const reasons: string[] = [];
    let level: RiskLevel = 'L0';
    const bump = (l: RiskLevel, why: string) => {
      level = maxRisk(level, l);
      reasons.push(`${l}：${why}`);
    };
    const action = reasoningValue.proposedAction.type;
    const draft = reasoningValue.draft;
    const evidenceText = JSON.stringify(evidence.items.map((i) => i.data)) + knowledge.hits.map((h) => h.text).join('\n');
    const amounts = [...draft.matchAll(/(\d+(?:\.\d{1,2})?)\s*元/g)].map((m) => m[1]);
    const unsupportedAmounts = amounts.filter((a) => !evidenceText.includes(a));
    if (unsupportedAmounts.length) {
      flags.push('unsupported_amount');
      bump('L2', `话术含证据中不存在的金额 ${unsupportedAmounts.join('/')}`);
    }
    // 承诺检测：话术声称已完成某动作，但提案动作并不是它（或系统不会执行它）
    const promised: [RegExp, ProposedAction['type'][]][] = [
      [/已(?:经)?(?:为您)?(?:退款|退回|赔付|补偿)|(?:退款|赔付|补偿)(?:已)?(?:成功|到账|完成)/, ['refund', 'price_difference_refund']],
      [/已(?:经)?(?:为您)?(?:补发|重发|安排发货)/, ['reship']],
      [/已(?:经)?(?:为您)?(?:开票|重开|换开)/, ['invoice_reissue']],
      [/已(?:经)?(?:为您)?(?:登记|创建|提交|建立).{0,6}(?:工单|申请)/, ['create_ticket']],
    ];
    for (const [re, types] of promised) {
      if (re.test(draft) && !types.includes(action)) {
        flags.push('commitment_language');
        bump('L2', `话术声称已完成「${draft.match(re)?.[0]}」，但提案动作为 ${action}`);
        break;
      }
    }
    if (reasoningValue.invalidCitations.length) {
      flags.push('invalid_citation');
      bump('L1', `模型引用了 ${reasoningValue.invalidCitations.length} 条不存在的来源，已剔除`);
    }
    if (['refund', 'price_difference_refund', 'reship', 'invoice_reissue'].includes(action)) bump('L2', `动作 ${action} 涉及权益/资金变更`);
    if (action === 'handoff') bump('L2', '模型提案转人工');
    if (flags.some((f) => ['complaint', 'legal', 'safety'].includes(f))) bump('L3', '投诉/法律/安全类信号');
    if (reasoningValue.needsHuman) bump('L2', '模型判断需要人工介入');
    if (intent.out.confidence < 0.5) bump('L2', `意图置信度过低 ${intent.out.confidence.toFixed(2)}`);
    else if (intent.out.confidence < 0.7) bump('L1', `意图置信度偏低 ${intent.out.confidence.toFixed(2)}`);
    const businessTools = pack.tools.filter((t) => agent.tools.includes(t));
    if (businessTools.length && evidence.attempted > 0 && evidence.completeness < 1) bump('L2', `业务证据不完整（${(evidence.completeness * 100).toFixed(0)}%），存在工具失败或未命中`);
    else if (businessTools.length && evidence.attempted === 0 && !intent.missing.length && action !== 'clarify') bump('L1', `无可用业务证据（${evidence.unattempted.join('/')} 缺少查询键），结论只能基于用户自述与知识`);
    if (pack.id === 'presale' && action !== 'clarify' && knowledge.retrievalConfidence < agent.retrieval.minScore) bump('L2', `售前作答但知识置信度不足 ${knowledge.retrievalConfidence.toFixed(2)}`);
    if (action === 'clarify' && intent.missing.length) bump('L0', '仅追问缺失信息，不含业务结论');
    if (trace.status === 'failed') bump('L2', '执行链存在失败阶段');
    const ruleCertainty = Math.max(0, 1 - reasoningValue.invalidCitations.length * 0.3 - (pack.allowedAutoActions.includes(action) ? 0 : 0.3));
    const value: RiskAssessment = {
      level,
      signals: {
        intentConfidence: Number(intent.out.confidence.toFixed(2)),
        evidenceCompleteness: Number(evidence.completeness.toFixed(2)),
        retrievalConfidence: Number(knowledge.retrievalConfidence.toFixed(2)),
        ruleCertainty: Number(ruleCertainty.toFixed(2)),
      },
      flags: [...new Set(flags)],
      reasons: reasons.length ? reasons : ['L0：无风险信号'],
    };
    trace.risk = value;
    return { summary: `风险等级 ${level}；信号 意图${value.signals.intentConfidence}/证据${value.signals.evidenceCompleteness}/知识${value.signals.retrievalConfidence}/规则${value.signals.ruleCertainty}`, detail: value as unknown as Record<string, unknown>, value };
  });
  const riskValue: RiskAssessment = risk ?? { level: 'L3', signals: { intentConfidence: 0, evidenceCompleteness: 0, retrievalConfidence: 0, ruleCertainty: 0 }, flags: ['risk_stage_failed'], reasons: ['L3：风险阶段失败，保守升级'] };

  // ───────────────────────── 8. 自主处理 / 人工确认 / 升级 ─────────────────────────
  const autonomy = await stage('autonomy', async () => {
    const reasons: string[] = [];
    const whitelistMatched = agent.whitelistScenarios.includes(pack.id);
    const cap = minRisk(agent.maxAutoRisk, pack.maxAutoRisk);
    const action = reasoningValue.proposedAction;
    let decision: AutonomyResult['decision'];
    let priority: Priority | null = null;
    const executed: string[] = [];
    if (intent.out.flags.includes('request_human')) {
      decision = 'escalate';
      priority = intent.out.flags.includes('vip') ? 'P1' : 'P2';
      reasons.push('用户明确要求人工');
    } else if (riskValue.level === 'L3') {
      decision = 'escalate';
      priority = riskValue.flags.some((f) => ['safety', 'legal'].includes(f)) ? 'P0' : 'P1';
      reasons.push('风险 L3：投诉/法律/安全类，直接升级');
    } else if (intake.botTurns >= agent.handoffRules.maxBotTurns && action.type !== 'none') {
      decision = 'escalate';
      priority = 'P2';
      reasons.push(`机器人已连续回复 ${intake.botTurns} 轮未解决，超过阈值 ${agent.handoffRules.maxBotTurns}`);
    } else if (action.type === 'handoff') {
      decision = 'escalate';
      priority = intent.out.flags.includes('vip') || intent.out.flags.includes('urgent') ? 'P1' : 'P2';
      reasons.push('模型提案转人工');
    } else if (whitelistMatched && riskRank(riskValue.level) <= riskRank(cap) && pack.allowedAutoActions.includes(action.type)) {
      decision = 'auto_reply';
      reasons.push(`白名单场景 ${pack.id}，风险 ${riskValue.level} ≤ 上限 ${cap}，动作 ${action.type} 在允许列表`);
      if (action.type === 'create_ticket') {
        const def = ctx.tools.get('tickets.create');
        if (def) {
          const ev = await ctx.tools.execute('tickets.create', { ...action.params, conversationId: ctx.conversation.id, customerId: ctx.conversation.customerId, title: action.reason || intent.out.intent, scenario: pack.id }, { conversationId: ctx.conversation.id, customerId: ctx.conversation.customerId, traceId: ctx.traceId }, 99);
          if (ev.ok) executed.push(`create_ticket:${(ev.data as any)?.id ?? 'ok'}`);
          else reasons.push(`自动建单失败：${ev.error}`);
        }
      }
    } else {
      decision = 'human_confirm';
      priority = intent.out.flags.includes('vip') || intent.out.flags.includes('urgent') ? 'P1' : 'P2';
      if (!whitelistMatched) reasons.push(`场景 ${pack.id} 不在白名单`);
      if (riskRank(riskValue.level) > riskRank(cap)) reasons.push(`风险 ${riskValue.level} 超过自治上限 ${cap}`);
      if (!pack.allowedAutoActions.includes(action.type)) reasons.push(`动作 ${action.type} 不允许自动执行`);
    }
    const value: AutonomyResult = { decision, priority, reasons, autoActionsExecuted: executed, whitelistMatched };
    trace.autonomy = value;
    return { summary: `${decision === 'auto_reply' ? '自主回复' : decision === 'human_confirm' ? '人工确认' : `升级人工（${priority}）`}：${reasons.join('；')}`, detail: value as unknown as Record<string, unknown>, value };
  });
  const autonomyValue: AutonomyResult = autonomy ?? { decision: 'escalate', priority: 'P1', reasons: ['自治阶段失败，保守升级'], autoActionsExecuted: [], whitelistMatched: false };

  // ───────────────────────── 9. 最终回复 ─────────────────────────
  await stage('reply', async () => {
    const eta: Record<Priority, string> = { P0: '15 分钟内', P1: '2 小时内', P2: '1 个工作日内' };
    let kind: 'answer' | 'clarify' | 'handoff' = 'answer';
    let text = reasoningValue.draft;
    if (autonomyValue.decision === 'escalate') {
      kind = 'handoff';
      const p = autonomyValue.priority ?? 'P2';
      text = `${reasoningValue.proposedAction.type === 'clarify' ? '' : '您的问题我已经记录并整理好相关信息，'}已为您转接人工客服（优先级 ${p}，预计 ${eta[p]}开始处理）。人工上线后会直接接续本次对话，无需重复描述。`;
    } else if (reasoningValue.proposedAction.type === 'clarify') {
      kind = 'clarify';
    }
    if (autonomyValue.autoActionsExecuted.length) text += `\n\n（已为您创建跟进工单：${autonomyValue.autoActionsExecuted.map((a) => a.split(':')[1]).join('、')}）`;
    const internalNote = [
      `场景 ${pack.name} / 意图 ${trace.intent}`,
      `根因：${reasoningValue.rootCause}`,
      `证据：${evidence.items.map((i) => `${i.label}${i.ok ? '✓' : '✗'}`).join('，') || '无'}`,
      `知识：${knowledge.hits.map((h) => h.docTitle).join('，') || '无'}`,
      `风险 ${riskValue.level}：${riskValue.reasons.join('；')}`,
      `决策：${autonomyValue.decision}${autonomyValue.priority ? ` ${autonomyValue.priority}` : ''}；建议动作 ${reasoningValue.proposedAction.type}${reasoningValue.proposedAction.reason ? `（${reasoningValue.proposedAction.reason}）` : ''}`,
    ].join('\n');
    trace.reply = { text, internalNote, kind };
    return { summary: `${kind === 'answer' ? '生成回复' : kind === 'clarify' ? '生成追问' : '生成转人工话术'}，${text.length} 字`, detail: { text, internalNote, kind }, value: null };
  });

  return finish();

  function finish(): Trace {
    trace.totalDurationMs = Date.now() - started;
    trace.usage = sumUsage(usages);
    if (!trace.reply) {
      trace.reply = { text: '系统暂时无法处理您的问题，已为您转接人工客服。', internalNote: `执行链失败：${trace.error ?? '未知'}`, kind: 'handoff' };
      trace.autonomy = trace.autonomy ?? { decision: 'escalate', priority: 'P1', reasons: ['执行链失败兜底'], autoActionsExecuted: [], whitelistMatched: false };
    }
    return trace;
  }
}
