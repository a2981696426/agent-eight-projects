import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentConfig } from '@eight/shared';
import { LlmBase, LlmError, LlmRouter, MockLlmClient, type ChatMessage, type ChatOptions, type ChatResult } from '../src/llm.js';
import { BM25Index } from '../src/retrieval.js';
import { ToolRegistry } from '../src/tools.js';
import { runChain } from '../src/pipeline.js';

/** 可编程故障的假 provider */
class FlakyClient extends LlmBase {
  calls = 0;
  constructor(readonly id: string, private readonly failures: LlmError[] = [], private readonly answer = '{"ok":true}') {
    super();
  }
  get configured() {
    return true;
  }
  async chat(_m: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    this.calls++;
    const f = this.failures.shift();
    if (f) throw f;
    return { content: this.answer, reasoning: null, toolCalls: [], usage: { model: this.id, provider: this.id, promptTokens: 1, completionTokens: 1, durationMs: 1, thinking: !!opts.mode }, raw: {} };
  }
}

test('可重试错误先在同一 provider 重试，再切换到备用 provider', async () => {
  const primary = new FlakyClient('primary', [new LlmError('timeout', 'LLM_TIMEOUT'), new LlmError('timeout', 'LLM_TIMEOUT')]);
  const backup = new FlakyClient('backup');
  const router = new LlmRouter([primary, backup], { maxRetries: 1, backoffMs: 1 });
  const r = await router.chat([{ role: 'user', content: 'hi' }]);
  assert.equal(r.usage.provider, 'backup');
  assert.equal(r.usage.failedOver, true);
  assert.equal(primary.calls, 2, '主 provider 重试 1 次后放弃');
  assert.equal(backup.calls, 1);
  assert.ok(router.events.some((e) => e.type === 'failover'));
});

test('连续失败触发熔断，熔断期间跳过该 provider；冷却后半开试探成功即恢复', async () => {
  const primary = new FlakyClient('primary', Array.from({ length: 6 }, () => new LlmError('500', 'LLM_SERVER_ERROR')));
  const backup = new FlakyClient('backup');
  const router = new LlmRouter([primary, backup], { maxRetries: 0, failureThreshold: 2, cooldownMs: 20 });
  await router.chat([{ role: 'user', content: '1' }]);
  await router.chat([{ role: 'user', content: '2' }]);
  assert.equal(router.status()[0].circuit, 'open');
  const before = primary.calls;
  await router.chat([{ role: 'user', content: '3' }]);
  assert.equal(primary.calls, before, '熔断中不再调用主 provider');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(router.status()[0].circuit, 'half_open');
  primary['failures'].length = 0; // 主 provider 恢复
  const r = await router.chat([{ role: 'user', content: '4' }]);
  assert.equal(r.usage.provider, 'primary');
  assert.equal(router.status()[0].circuit, 'closed');
});

test('401 不重试直接切换；400 类错误不切换直接抛出', async () => {
  const p1 = new FlakyClient('p1', [new LlmError('401', 'LLM_UNAUTHORIZED')]);
  const p2 = new FlakyClient('p2');
  const r = await new LlmRouter([p1, p2], { maxRetries: 2, backoffMs: 1 }).chat([{ role: 'user', content: 'x' }]);
  assert.equal(r.usage.provider, 'p2');
  assert.equal(p1.calls, 1);
  const bad = new FlakyClient('bad', [new LlmError('400', 'LLM_HTTP_ERROR')]);
  await assert.rejects(new LlmRouter([bad, new FlakyClient('never')]).chat([{ role: 'user', content: 'x' }]), (e: LlmError) => e.code === 'LLM_HTTP_ERROR');
});

test('故障演练 all_down → configured=false；执行链进入规则降级并转人工', async () => {
  const router = new LlmRouter([new MockLlmClient()]);
  router.simulate('all_down');
  assert.equal(router.configured, false);
  const agent: AgentConfig = { id: 'a', name: 'A', description: '', version: 1, status: 'published', models: { fast: 'x', reasoning: 'x', reasoningEffort: 'low' }, persona: 'p', scenarios: ['logistics', 'invoice', 'refund_price_diff', 'presale', 'complaint', 'general'], whitelistScenarios: ['logistics'], maxAutoRisk: 'L1', retrieval: { topK: 4, minScore: 0.2, rewriteOnMiss: true }, handoffRules: { keywords: [], maxBotTurns: 6 }, tools: ['orders.lookup', 'logistics.track'], updatedAt: '' };
  const tools = new ToolRegistry().register({ name: 'orders.lookup', label: '订单查询', description: '', requires: ['orderId'], run: async (a) => ({ orderId: a.orderId, product: 'M8', status: 'shipped', paidAmount: 279 }) }).register({ name: 'logistics.track', label: '物流轨迹', description: '', requires: ['orderId'], run: async () => ({ carrier: '顺丰', trackingNo: 'SF1', status: 'in_transit', hoursSinceUpdate: 90 }) });
  const trace = await runChain({ llm: router, tools, index: new BM25Index(), agent, conversation: { id: 'c', customerId: null, channel: 'web', messages: [] }, customer: null, history: { slots: {}, scenario: null }, traceId: 't' }, { text: '订单 20260918000123 的快递怎么还没到' });
  assert.equal(trace.degraded, true);
  assert.equal(trace.scenario, 'logistics', '关键词规则识别场景');
  assert.equal(trace.evidence.filter((e) => e.ok).length, 2, '降级仍取证');
  assert.match(trace.reply!.text, /受限模式|顺丰/);
  assert.equal(trace.autonomy?.decision, 'escalate');
  assert.equal(trace.usage.calls, 0);
  assert.ok(trace.risk?.flags.includes('degraded'));
  router.simulate('normal');
  assert.equal(router.configured, true);
});

test('缺必填槽位时不调用推理模型（只 1 次意图调用），证据与检索并行完成', async () => {
  const mock = new MockLlmClient();
  const agent: AgentConfig = { id: 'a', name: 'A', description: '', version: 1, status: 'published', models: { fast: 'x', reasoning: 'x', reasoningEffort: 'low' }, persona: 'p', scenarios: ['logistics', 'general'], whitelistScenarios: ['logistics'], maxAutoRisk: 'L1', retrieval: { topK: 4, minScore: 0.2, rewriteOnMiss: true }, handoffRules: { keywords: [], maxBotTurns: 6 }, tools: ['orders.lookup'], updatedAt: '' };
  const trace = await runChain({ llm: mock, tools: new ToolRegistry(), index: new BM25Index(), agent, conversation: { id: 'c', customerId: null, channel: 'web', messages: [] }, customer: null, history: { slots: {}, scenario: null }, traceId: 't' }, { text: '我的快递到哪了' });
  assert.equal(trace.usage.calls, 1);
  assert.equal(trace.reply?.kind, 'clarify');
  assert.match(trace.reply!.text, /订单号/);
  assert.equal(trace.stages.map((s) => s.id).join(','), 'intake,completion,intent,evidence,knowledge,reasoning,risk,autonomy,reply');
  assert.equal(trace.autonomy?.decision, 'auto_reply');
});
