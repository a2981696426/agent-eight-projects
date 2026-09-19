import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.LLM_MOCK = '1';
process.env.DATA_DIR = ':memory:';
process.env.DMS_MODE = 'mock';

const { initDb, closeDb } = await import('../src/db.ts');
const { seed } = await import('../src/seed.ts');
const { buildServer } = await import('../src/server.ts');
const { ensureHandoffTask } = await import('../src/services/handoff.ts');

type App = Awaited<ReturnType<typeof buildServer>>;
let app: App;
let cookie = '';

const call = async (method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown) => {
  const r = await app.inject({ method, url, payload: body as Record<string, unknown> | undefined, headers: { cookie, 'content-type': 'application/json' } });
  return { status: r.statusCode, json: r.body ? (JSON.parse(r.body) as Record<string, unknown>) : null };
};

before(async () => {
  await initDb();
  await seed(true);
  app = await buildServer();
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin123' } });
  assert.equal(login.statusCode, 200);
  cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
});
after(async () => {
  await app.close();
  await closeDb();
});

test('子案件：创建 → 开始处理 → 关联 DMS（normal）→ linked_dms 且单号形如 DMS-', async () => {
  const created = await call('POST', '/api/cases', { title: 'e2e 物流催件', type: '物流', priority: 'P2', description: '订单 20260918000123 停滞', conversationId: 'conv-001', customerId: 'cust-001' });
  assert.equal(created.status, 201);
  const id = String(created.json!.id);
  assert.match(id, /^CS-\d{8}-[A-Z0-9]{4}$/);
  assert.equal(created.json!.status, 'pending_human');

  const started = await call('PATCH', `/api/cases/${id}`, { status: 'in_progress', note: '开始跟进' });
  assert.equal(started.json!.status, 'in_progress');

  const linked = await call('POST', `/api/cases/${id}/dms/link`, {});
  assert.equal(linked.status, 200);
  assert.equal(linked.json!.status, 'linked_dms');
  const dms = linked.json!.dms as { ticketNo: string; status: string; pending: boolean };
  assert.match(dms.ticketNo, /^DMS-/);
  assert.equal(dms.status, 'received');
  assert.equal(dms.pending, false);

  // 幂等：再 link 一次仍是同一单号
  const again = await call('POST', `/api/cases/${id}/dms/link`, {});
  assert.equal((again.json!.dms as { ticketNo: string }).ticketNo, dms.ticketNo);
});

test('PATCH 不允许把状态直接改成 linked_dms；本地没有 resolved/closed', async () => {
  const created = await call('POST', '/api/cases', { title: '越权状态', type: '其他' });
  const id = String(created.json!.id);
  assert.equal((await call('PATCH', `/api/cases/${id}`, { status: 'linked_dms' })).status, 400);
  assert.equal((await call('PATCH', `/api/cases/${id}`, { status: 'resolved' })).status, 400);
});

test('DMS 不可用 → 待同步案件；恢复后 retry-pending 全部关联', async () => {
  assert.equal((await call('POST', '/api/dms/simulate', { mode: 'unavailable' })).status, 200);
  const created = await call('POST', '/api/cases', { title: '待同步演示', type: '退款', priority: 'P2' });
  const id = String(created.json!.id);
  const linked = await call('POST', `/api/cases/${id}/dms/link`, {});
  assert.equal(linked.status, 200);
  assert.equal(linked.json!.status, 'pending_human', '不可用时状态不变');
  const dms = linked.json!.dms as { pending: boolean; ticketNo: string | null; lastError: string };
  assert.equal(dms.pending, true);
  assert.equal(dms.ticketNo, null);
  assert.match(dms.lastError, /不可用/);

  await call('POST', '/api/dms/simulate', { mode: 'normal' });
  const retry = await call('POST', '/api/dms/retry-pending', {});
  assert.equal(retry.status, 200);
  assert.equal(retry.json!.stillPending, 0);
  const after = await call('GET', `/api/cases/${id}`);
  assert.equal(after.json!.status, 'linked_dms');
});

test('DMS 拒绝：记录错误、状态不变、不进入待同步', async () => {
  await call('POST', '/api/dms/simulate', { mode: 'reject' });
  const created = await call('POST', '/api/cases', { title: '被拒绝', type: '其他' });
  const id = String(created.json!.id);
  const linked = await call('POST', `/api/cases/${id}/dms/link`, {});
  assert.equal(linked.json!.status, 'pending_human');
  const dms = linked.json!.dms as { pending: boolean; lastError: string };
  assert.equal(dms.pending, false);
  assert.match(dms.lastError, /拒绝/);
  await call('POST', '/api/dms/simulate', { mode: 'normal' });
});

test('回填工单号：不存在的单号 400；存在的单号关联成功并回读状态', async () => {
  const created = await call('POST', '/api/cases', { title: '回填', type: '发票' });
  const id = String(created.json!.id);
  assert.equal((await call('POST', `/api/cases/${id}/dms/attach`, { ticketNo: 'DMS-00000000-9999' })).status, 400);
  const ok = await call('POST', `/api/cases/${id}/dms/attach`, { ticketNo: 'DMS-20260916-0001' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json!.status, 'linked_dms');
  assert.equal((ok.json!.dms as { status: string }).status, 'resolved');
});

test('接续任务：列表含 pending；claim 后会话切人工；done 完成；从任务拆子案件', async () => {
  const { task } = await ensureHandoffTask({ conversationId: 'conv-007', channel: 'app', priority: 'P2', reason: '测试', progress: { doneStages: ['intake'], evidence: [], missing: ['orderId'], candidate: null, failure: null, nextAction: '接续' }, traceId: null });
  const list = await call('GET', '/api/handoffs?status=pending');
  assert.ok((list.json as unknown as { id: string }[]).some((t) => t.id === task.id));

  const split = await call('POST', `/api/handoffs/${task.id}/case`, {});
  assert.equal(split.status, 201);
  assert.equal((split.json!.task as { caseId: string }).caseId, String((split.json!.case as { id: string }).id));

  const claimed = await call('POST', `/api/handoffs/${task.id}/claim`, {});
  assert.equal(claimed.json!.status, 'claimed');
  assert.equal(claimed.json!.claimedBy, '管理员');
  const conv = await call('GET', '/api/conversations/conv-007');
  assert.equal((conv.json!.conversation as { controller: string }).controller, 'human');
  assert.equal((conv.json!.handoffTask as { id: string }).id, task.id);

  const done = await call('POST', `/api/handoffs/${task.id}/done`, { note: '已处理' });
  assert.equal(done.json!.status, 'done');
  const stats = await call('GET', '/api/handoffs/stats');
  assert.equal(typeof stats.json!.overdue, 'number');
});

test('会话 control=handoff 创建接续任务；close 取消活动任务', async () => {
  const before = await call('GET', '/api/handoffs?status=pending');
  const handoff = await call('POST', '/api/conversations/conv-005/control', { action: 'reopen' });
  assert.equal(handoff.status, 200);
  const h2 = await call('POST', '/api/conversations/conv-005/control', { action: 'handoff', reason: '坐席转排队' });
  assert.equal(h2.status, 200);
  const afterList = await call('GET', '/api/handoffs?status=pending');
  assert.equal((afterList.json as unknown as unknown[]).length, (before.json as unknown as unknown[]).length + 1);
  await call('POST', '/api/conversations/conv-005/control', { action: 'close' });
  const cancelled = await call('GET', '/api/handoffs?status=cancelled');
  assert.ok((cancelled.json as unknown as { conversationId: string }[]).some((t) => t.conversationId === 'conv-005'));
});

test('鉴权：匿名访问 /api/cases 401；analyst 写 cases 403', async () => {
  const anon = await app.inject({ method: 'GET', url: '/api/cases' });
  assert.equal(anon.statusCode, 401);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'analyst', password: 'analyst123' } });
  const ck = login.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const forbidden = await app.inject({ method: 'POST', url: '/api/cases', payload: { title: 'x', type: '其他' }, headers: { cookie: ck } });
  assert.equal(forbidden.statusCode, 403);
  const simulate = await app.inject({ method: 'POST', url: '/api/dms/simulate', payload: { mode: 'normal' }, headers: { cookie: ck } });
  assert.equal(simulate.statusCode, 403);
});
