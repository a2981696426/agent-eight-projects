import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentConfig } from '@eight/shared';
import { BM25Index } from '../src/retrieval.js';
import { ToolRegistry } from '../src/tools.js';
import { LlmClient } from '../src/llm.js';
import { runChain } from '../src/pipeline.js';

const agent: AgentConfig = {
  id: 'a1',
  name: '测试 Agent',
  description: '',
  version: 1,
  status: 'published',
  models: { fast: 'x', reasoning: 'x', reasoningEffort: 'low' },
  persona: '你是客服。',
  scenarios: ['logistics', 'invoice', 'refund_price_diff', 'presale', 'complaint', 'general'],
  whitelistScenarios: ['logistics', 'general'],
  maxAutoRisk: 'L1',
  retrieval: { topK: 4, minScore: 0.2, rewriteOnMiss: false },
  handoffRules: { keywords: [], maxBotTurns: 6 },
  tools: ['orders.lookup', 'logistics.track'],
  updatedAt: new Date().toISOString(),
};

/** 不联网的假 LLM：按 system 提示词中的角色返回固定 JSON */
class FakeLlm extends LlmClient {
  constructor(private readonly plan: { intent: object; reason: object }) {
    super({ baseUrl: 'http://fake', apiKey: 'k', modelFast: 'f', modelReasoning: 'r' });
  }
  override async chat(messages: any[], opts: any = {}) {
    const sys = messages[0]?.content ?? '';
    const body = sys.includes('意图与场景识别') ? this.plan.intent : sys.includes('检索查询改写') ? { queries: ['改写'] } : this.plan.reason;
    return { content: JSON.stringify(body), reasoning: null, toolCalls: [], usage: { model: 'fake', promptTokens: 10, completionTokens: 5, durationMs: 1, thinking: !!opts.mode }, raw: {} };
  }
}

const base = (llm: LlmClient, tools: ToolRegistry, messages: any[] = []) => ({
  llm,
  tools,
  index: new BM25Index([{ docTitle: '物流说明', chunk: { id: 'k1', docId: 'd', seq: 1, text: '快递发货后 48 小时内更新物流轨迹；物流停滞超过 3 天可申请催件，快递还没到时先查询轨迹。', tags: ['物流'] } }]),
  agent,
  conversation: { id: 'c1', customerId: 'u1', channel: 'web', messages },
  customer: { id: 'u1', name: '张三', phone: '13800000000', level: 'normal' as const, channel: 'web' as const, tags: [] },
  history: { slots: {}, scenario: null },
  traceId: 't1',
});

test('寒暄走规则，不调用模型，自主回复', async () => {
  const llm = new FakeLlm({ intent: {}, reason: {} });
  const trace = await runChain(base(llm, new ToolRegistry()), { text: '你好' });
  assert.equal(trace.scenario, 'general');
  assert.equal(trace.autonomy?.decision, 'auto_reply');
  assert.equal(trace.usage.calls, 0);
  assert.equal(trace.stages.length, 9);
});

test('缺订单号 → 追问；有订单号 → 调工具、白名单自主回复', async () => {
  const tools = new ToolRegistry()
    .register({ name: 'orders.lookup', label: '订单查询', description: '', requires: ['orderId'], run: async (a) => ({ orderId: a.orderId, status: 'shipped' }) })
    .register({ name: 'logistics.track', label: '物流轨迹', description: '', requires: ['orderId'], run: async () => ({ carrier: 'SF', lastUpdate: '3 天前', status: 'stalled' }) });
  const llm = new FakeLlm({
    intent: { scenario: 'logistics', intent: '查询物流', confidence: 0.92, entities: {}, flags: [], needHuman: false, reason: '' },
    reason: { rootCause: '包裹停滞', analysis: 'x', draft: '您的包裹目前停滞，我已为您登记催件。', citations: [{ id: 'tool:logistics.track#2' }, { id: 'kb:k1' }, { id: 'kb:不存在' }], proposedAction: { type: 'create_ticket', params: {}, reason: '催件' }, needsHuman: false, selfConfidence: 0.8 },
  });
  const t1 = await runChain(base(llm, tools), { text: '我的快递怎么还没到' });
  assert.equal(t1.scenario, 'logistics');
  assert.equal(t1.reply?.kind, 'clarify');
  assert.equal(t1.reasoning?.proposedAction.type, 'clarify');
  assert.equal(t1.evidence.length, 0);

  const t2 = await runChain(base(llm, tools), { text: '订单号 20260918000123，快递怎么还没到' });
  assert.equal(t2.slots.find((s) => s.key === 'orderId')?.value, '20260918000123');
  assert.equal(t2.evidence.filter((e) => e.ok).length, 2);
  assert.equal(t2.reasoning?.citations.length, 2, '无效引用被剔除');
  assert.ok(t2.risk?.flags.includes('invalid_citation'));
  assert.equal(t2.risk?.level, 'L1');
  assert.equal(t2.autonomy?.decision, 'auto_reply');
  assert.equal(t2.reply?.kind, 'answer');
});

test('投诉信号 → L3 升级 P1；要求人工 → 升级', async () => {
  const llm = new FakeLlm({
    intent: { scenario: 'complaint', intent: '投诉服务', confidence: 0.9, entities: {}, flags: ['complaint'], needHuman: true, reason: '' },
    reason: { rootCause: '服务不满', analysis: 'x', draft: '非常抱歉。', citations: [], proposedAction: { type: 'handoff', params: {}, reason: '' }, needsHuman: true, selfConfidence: 0.9 },
  });
  const t = await runChain(base(llm, new ToolRegistry()), { text: '我要投诉你们' });
  assert.equal(t.risk?.level, 'L3');
  assert.equal(t.autonomy?.decision, 'escalate');
  assert.equal(t.autonomy?.priority, 'P1');
  assert.equal(t.reply?.kind, 'handoff');
  const t2 = await runChain(base(llm, new ToolRegistry()), { text: '转人工' });
  assert.ok(t2.autonomy?.reasons.some((r) => r.includes('用户明确要求人工')));
});

test('话术中出现证据里不存在的金额 → L2 人工确认', async () => {
  const tools = new ToolRegistry().register({ name: 'orders.lookup', label: '订单查询', description: '', requires: ['orderId'], run: async () => ({ paid: 299 }) }).register({ name: 'logistics.track', label: '物流', description: '', requires: ['orderId'], run: async () => ({ status: 'ok' }) });
  const llm = new FakeLlm({
    intent: { scenario: 'logistics', intent: '查询', confidence: 0.9, entities: {}, flags: [], needHuman: false, reason: '' },
    reason: { rootCause: 'x', analysis: 'x', draft: '可以为您补偿 50 元。', citations: [], proposedAction: { type: 'none', params: {}, reason: '' }, needsHuman: false, selfConfidence: 0.9 },
  });
  const t = await runChain(base(llm, tools), { text: '订单 20260918000123 慢了' });
  assert.ok(t.risk?.flags.includes('unsupported_amount'));
  assert.equal(t.autonomy?.decision, 'human_confirm');
});
