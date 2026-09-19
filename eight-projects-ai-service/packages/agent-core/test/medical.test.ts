import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MEDICAL_BOUNDARY_TEXT, containsMedicalAdvice, detectMedicalRequest } from '../src/medical.js';
import { runChain } from '../src/pipeline.js';
import { BM25Index } from '../src/retrieval.js';
import { MockLlmClient } from '../src/llm.js';
import { ToolRegistry } from '../src/tools.js';
import type { AgentConfig } from '@eight/shared';

test('detectMedicalRequest：用药/剂量/诊断/饮食治疗类请求命中；设备与业务问题不命中', () => {
  const positives = ['血糖高了要不要多打一针胰岛素', '我这个血糖值算糖尿病吗', '二甲双胍可以停了吗', '晚上血糖 3.5 要吃点什么', '传感器显示 18 我该加多少药', '能不能不吃药只靠饮食控制', '低血糖了喝可乐行不行', '孕妇血糖多少算正常'];
  for (const p of positives) assert.equal(detectMedicalRequest(p).medical, true, p);
  const negatives = ['血糖仪数据不准怎么办', '传感器多久换一次', '发票抬头写错了想换开', '订单 20260918000123 的快递三天没动了', '这个传感器洗澡能戴吗'];
  for (const n of negatives) assert.equal(detectMedicalRequest(n).medical, false, n);
});

test('detectMedicalRequest：紧急症状标记 emergency', () => {
  const e = detectMedicalRequest('我妈低血糖晕倒了怎么办');
  assert.equal(e.medical, true);
  assert.equal(e.emergency, true);
  assert.equal(detectMedicalRequest('血糖高了要不要多打一针胰岛素').emergency, false);
  assert.equal(detectMedicalRequest('设备说我血糖 25 要去医院吗').medical, true);
});

test('containsMedicalAdvice：捕获用药/剂量/诊断/饮食治疗话术，放过正常售后话术与边界文案', () => {
  const advice = ['建议您把胰岛素剂量调到每天 20 单位', '可以先停药观察两天', '建议服用二甲双胍', '这属于糖尿病，需要饮食治疗', '建议少吃主食多运动就能降下来'];
  for (const a of advice) assert.equal(containsMedicalAdvice(a).advice, true, a);
  const fine = ['您的订单已发出，预计明天送达。', '开票 90 天内支持换开抬头。', MEDICAL_BOUNDARY_TEXT, '传感器出现数据不准，建议先校准并联系人工客服。'];
  for (const f of fine) assert.equal(containsMedicalAdvice(f).advice, false, f);
});

const agent: AgentConfig = {
  id: 'a', name: 'a', description: '', version: 1, status: 'published',
  models: { fast: 'mock', reasoning: 'mock', reasoningEffort: 'low' },
  persona: '客服', scenarios: ['logistics', 'invoice', 'refund_price_diff', 'presale', 'complaint', 'general'],
  whitelistScenarios: ['logistics', 'invoice', 'presale', 'general'], maxAutoRisk: 'L1',
  retrieval: { topK: 3, minScore: 0.22, rewriteOnMiss: false }, handoffRules: { keywords: [], maxBotTurns: 6 }, tools: [], updatedAt: new Date().toISOString(),
};
const ctx = (text: string) => ({ llm: new MockLlmClient(), tools: new ToolRegistry(), index: new BM25Index(), agent, conversation: { id: 'c', customerId: null, channel: 'web', messages: [] }, customer: null, history: { slots: {}, scenario: null }, traceId: `t-${Math.random()}` });

test('执行链：医疗请求 → flags 含 medical、不自主回复、发送固定边界文案且不含医疗建议', async () => {
  const t = await runChain(ctx('血糖高了要不要多打一针胰岛素'), { text: '血糖高了要不要多打一针胰岛素' });
  assert.ok(t.risk?.flags.includes('medical'));
  assert.notEqual(t.autonomy?.decision, 'auto_reply');
  assert.ok(t.reply!.text.startsWith(MEDICAL_BOUNDARY_TEXT), t.reply!.text);
  assert.equal(containsMedicalAdvice(t.reply!.text).advice, false);
  assert.equal(t.reply!.kind, 'boundary');
});

test('执行链：紧急症状 → escalate P0，文案含 120', async () => {
  const t = await runChain(ctx('我妈低血糖晕倒了怎么办'), { text: '我妈低血糖晕倒了怎么办' });
  assert.equal(t.autonomy?.decision, 'escalate');
  assert.equal(t.autonomy?.priority, 'P0');
  assert.match(t.reply!.text, /120/);
  assert.ok(t.risk?.flags.includes('safety'));
});
