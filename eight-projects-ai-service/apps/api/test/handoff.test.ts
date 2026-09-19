import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb, openDb, nowIso } from '../src/db.ts';
import { addWorkHours, computeWindow, ensureHandoffTask, claimTask, isWorkTime, nextWorkStart, type WorkCalendar } from '../src/services/handoff.ts';

// 固定日历：09:00–18:00，周一至周五，2026-10-01 假日；时间用本地时区（测试机与生产均为 Asia/Shanghai）
const cal: WorkCalendar = { startMin: 9 * 60, endMin: 18 * 60, days: [1, 2, 3, 4, 5], holidays: new Set(['2026-10-01']) };
const local = (y: number, m: number, d: number, h: number, mi = 0) => new Date(y, m - 1, d, h, mi, 0, 0);
const fmt = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

test('isWorkTime / nextWorkStart：周五 10:00 在工作时段；周六 → 下周一 09:00', () => {
  assert.equal(isWorkTime(local(2026, 9, 18, 10), cal), true); // 周五
  assert.equal(isWorkTime(local(2026, 9, 19, 10), cal), false); // 周六
  assert.equal(fmt(nextWorkStart(local(2026, 9, 19, 10), cal).toISOString()), '2026-09-21 09:00');
  assert.equal(fmt(nextWorkStart(local(2026, 9, 18, 10), cal).toISOString()), '2026-09-18 10:00');
});

test('addWorkHours：17:00 + 2h 跨到次工作日 10:00；周五 10:00 + 9h → 下周一 10:00', () => {
  assert.equal(fmt(addWorkHours(local(2026, 9, 18, 17), 2, cal).toISOString()), '2026-09-21 10:00');
  assert.equal(fmt(addWorkHours(local(2026, 9, 18, 10), 9, cal).toISOString()), '2026-09-21 10:00');
});

test('computeWindow P1：工作时段内 2 小时后；周六则下周一 11:00 且文案提示人工上线后', () => {
  const a = computeWindow('P1', local(2026, 9, 18, 10), cal);
  assert.equal(fmt(a.dueAt), '2026-09-18 12:00');
  assert.equal(a.text, '预计 2 个工作小时内开始接续');
  const b = computeWindow('P1', local(2026, 9, 19, 10), cal);
  assert.equal(fmt(b.dueAt), '2026-09-21 11:00');
  assert.equal(b.text, '人工上线后优先处理，预计 2 个工作小时内开始接续');
});

test('computeWindow P2 = 9 个工时（一个工作日）；假日 2026-10-01 被跳过', () => {
  const a = computeWindow('P2', local(2026, 9, 18, 10), cal);
  assert.equal(fmt(a.dueAt), '2026-09-21 10:00');
  assert.equal(a.text, '预计 1 个工作日内开始处理');
  const b = computeWindow('P1', local(2026, 9, 30, 17), cal); // 周三 17:00，剩 1h；10-01 假日；10-02 周五 +1h → 10:00
  assert.equal(fmt(b.dueAt), '2026-10-02 10:00');
});

test('computeWindow P0 = 15 自然分钟；未取得告警回执时不说"已优先通知专人"', () => {
  const a = computeWindow('P0', local(2026, 9, 19, 10), cal);
  assert.equal(fmt(a.dueAt), '2026-09-19 10:15');
  assert.ok(!a.text.includes('已优先通知专人'));
  const b = computeWindow('P0', local(2026, 9, 19, 10), cal, true);
  assert.ok(b.text.includes('已优先通知专人'));
});

before(async () => {
  await initDb({ url: '', dataDir: null });
  const db = openDb();
  await db.run('INSERT INTO customers VALUES (?,?,?,?,?,?,?)', 'c1', '张三', '', 'normal', 'web', '[]', '');
  await db.run('INSERT INTO conversations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', 'conv-h1', '测试', 'web', 'c1', 'waiting_human', 'bot', null, 'complaint', 'P2', nowIso(), nowIso(), null, 'agent-cs-main', null);
});
after(async () => {
  await closeDb();
});

const progress = { doneStages: ['intake', 'intent'], evidence: [], missing: [], candidate: null, failure: null, nextAction: '接续会话并处理诉求' };

test('ensureHandoffTask：同会话第二次触发不新建；优先级只升不降；created_at 不变', async () => {
  const first = await ensureHandoffTask({ conversationId: 'conv-h1', channel: 'web', priority: 'P2', reason: '第一次', progress, traceId: 't1' });
  assert.equal(first.created, true);
  assert.equal(first.task.status, 'pending');
  const second = await ensureHandoffTask({ conversationId: 'conv-h1', channel: 'web', priority: 'P1', reason: '第二次', progress: { ...progress, doneStages: ['intake', 'intent', 'evidence'] }, traceId: 't2' });
  assert.equal(second.created, false);
  assert.equal(second.task.id, first.task.id);
  assert.equal(second.task.priority, 'P1');
  assert.equal(second.task.createdAt, first.task.createdAt);
  assert.equal(second.task.progress.doneStages.length, 3);
  const third = await ensureHandoffTask({ conversationId: 'conv-h1', channel: 'web', priority: 'P2', reason: '第三次', progress, traceId: 't3' });
  assert.equal(third.task.priority, 'P1', '优先级不得被降回 P2');
  const rows = await openDb().all("SELECT id FROM handoff_tasks WHERE conversation_id='conv-h1'");
  assert.equal(rows.length, 1);
});

test('claimTask：任务 claimed，会话切到人工并记录认领人', async () => {
  const { task } = await ensureHandoffTask({ conversationId: 'conv-h1', channel: 'web', priority: 'P1', reason: 'x', progress, traceId: null });
  const claimed = await claimTask(task.id, '客服小欧');
  assert.equal(claimed.status, 'claimed');
  assert.equal(claimed.claimedBy, '客服小欧');
  const conv = await openDb().get<{ controller: string; assignee: string; status: string }>('SELECT controller, assignee, status FROM conversations WHERE id=?', 'conv-h1');
  assert.equal(conv?.controller, 'human');
  assert.equal(conv?.assignee, '客服小欧');
  assert.equal(conv?.status, 'open');
});
