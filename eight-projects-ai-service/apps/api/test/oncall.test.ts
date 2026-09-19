import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATA_DIR = ':memory:';
process.env.LLM_MOCK = '1';
process.env.ONCALL_MODE = 'mock';
process.env.ONCALL_ROSTER = '值班A,售后负责人,质量值班';

const { initDb, closeDb } = await import('../src/db.ts');
const { calendarFromEnv, computeWindow, ensureHandoffTask } = await import('../src/services/handoff.ts');
const { MockOncall, ackAlert, currentOncall, escalateIfUnacked, oncallFromEnv, raiseP0Alert, visitorP0Sentence } = await import('../src/services/oncall.ts');

before(async () => {
  await initDb();
});
after(async () => {
  await closeDb();
});

test('visitorP0Sentence：无回执不得声称已通知专人；有回执才用签发口径', () => {
  assert.equal(visitorP0Sentence(false), '已升级处理，专人会尽快联系您');
  assert.ok(!visitorP0Sentence(false).includes('已优先通知'));
  assert.equal(visitorP0Sentence(true), '已优先通知专人处理，专人会尽快联系您');
});

test('computeWindow P0：alertDelivered 切换对外文案，时限仍是 15 自然分钟', () => {
  const now = new Date('2026-09-19T22:00:00+08:00');
  const a = computeWindow('P0', now, calendarFromEnv(), false);
  const b = computeWindow('P0', now, calendarFromEnv(), true);
  assert.equal(new Date(a.dueAt).getTime() - now.getTime(), 15 * 60_000);
  assert.equal(a.text, visitorP0Sentence(false));
  assert.equal(b.text, visitorP0Sentence(true));
});

test('raiseP0Alert：mock 投递成功写入 deliveredAt 与 hop 回执；ack 写入 ackAt', async () => {
  const duty = currentOncall();
  const { task } = await ensureHandoffTask({ conversationId: 'c-p0-1', channel: 'web', priority: 'P0', reason: '紧急低血糖', progress: { doneStages: [], evidence: [], missing: [], candidate: null, failure: null, nextAction: '立即确认' }, traceId: 'tr-1' });
  const r = await raiseP0Alert(task.id);
  assert.equal(r.delivered, true);
  assert.ok(r.task.alert?.deliveredAt);
  assert.equal(r.task.alert?.ackAt, null);
  assert.equal(r.task.alert?.hops?.length, 1);
  assert.equal(r.task.alert?.hops?.[0].target, duty.name);
  assert.match(r.task.windowText, /已优先通知专人/);
  const acked = await ackAlert(task.id, duty.name);
  assert.ok(acked?.alert?.ackAt);
});

test('raiseP0Alert：投递失败不写 deliveredAt，对外文案不得含已通知专人；升级链下一跳', async () => {
  const duty = currentOncall();
  const transport = oncallFromEnv() as MockOncall;
  transport.failNext = 1;
  const { task } = await ensureHandoffTask({ conversationId: 'c-p0-2', channel: 'wechat', priority: 'P0', reason: '账号被盗', progress: { doneStages: [], evidence: [], missing: [], candidate: null, failure: null, nextAction: '核验身份' }, traceId: 'tr-2' });
  const r = await raiseP0Alert(task.id);
  assert.equal(r.delivered, false);
  assert.equal(r.task.alert?.deliveredAt, null);
  assert.ok(!r.task.windowText.includes('已优先通知'));
  const next = await escalateIfUnacked(task.id);
  assert.equal(next.sent, true);
  assert.equal(next.task.alert?.hops?.at(-1)?.target, duty.chain[1]);
  assert.ok(next.task.alert?.deliveredAt, '第二跳成功应补回执');
  transport.failNext = 0;
});

test('escalateIfUnacked：已确认不再发送', async () => {
  const { task } = await ensureHandoffTask({ conversationId: 'c-p0-3', channel: 'web', priority: 'P0', reason: 'x', progress: { doneStages: [], evidence: [], missing: [], candidate: null, failure: null, nextAction: '' }, traceId: null });
  await raiseP0Alert(task.id);
  await ackAlert(task.id, currentOncall().name);
  const skip = await escalateIfUnacked(task.id);
  assert.equal(skip.sent, false);
  assert.match(skip.reason ?? '', /已确认|acked/);
});

test('escalateIfUnacked：名单走完仍记录失败，不得静默', async () => {
  const { task } = await ensureHandoffTask({ conversationId: 'c-p0-4', channel: 'web', priority: 'P0', reason: '链尽', progress: { doneStages: [], evidence: [], missing: [], candidate: null, failure: null, nextAction: '' }, traceId: null });
  await raiseP0Alert(task.id);
  assert.equal((await escalateIfUnacked(task.id)).sent, true);
  assert.equal((await escalateIfUnacked(task.id)).sent, true);
  const done = await escalateIfUnacked(task.id);
  assert.equal(done.sent, false);
  assert.match(done.reason ?? '', /升级链已尽/);
  assert.ok(done.task.history.some((h) => /走完/.test(h.action)));
});

test('currentOncall：按花名册轮转；空名单抛错而不是静默', () => {
  const a = currentOncall(new Date('2026-09-19T10:00:00+08:00'));
  assert.equal(a.chain.length, 3);
  assert.equal(new Set(a.chain).size, 3);
  assert.ok(a.chain.includes(a.name));
  process.env.ONCALL_ROSTER = '';
  assert.throws(() => currentOncall(), /花名册/);
  process.env.ONCALL_ROSTER = '值班A,售后负责人,质量值班';
});
