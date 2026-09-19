import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATA_DIR = ':memory:';
process.env.LLM_MOCK = '1';
process.env.ONCALL_MODE = 'mock';
process.env.ONCALL_ROSTER = '值班A,售后负责人,质量值班';

const { initDb, closeDb } = await import('../src/db.ts');
const { seed } = await import('../src/seed.ts');
const { buildServer } = await import('../src/server.ts');
const { ensureHandoffTask } = await import('../src/services/handoff.ts');
const { raiseP0Alert } = await import('../src/services/oncall.ts');

type App = Awaited<ReturnType<typeof buildServer>>;
let app: App;
const cookieOf = async (u: string, p: string) => {
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u, password: p } });
  assert.equal(login.statusCode, 200);
  return login.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
};

before(async () => {
  await initDb();
  await seed(true);
  app = await buildServer();
});
after(async () => {
  await app.close();
  await closeDb();
});

test('GET /api/oncall/status：未登录 401；登录后可见花名册与当值', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/api/oncall/status' })).statusCode, 401);
  const cookie = await cookieOf('agent', 'agent123');
  const r = await app.inject({ method: 'GET', url: '/api/oncall/status', headers: { cookie } });
  assert.equal(r.statusCode, 200);
  const body = JSON.parse(r.body) as { mode: string; configured: boolean; roster: string[]; duty: string | null };
  assert.equal(body.mode, 'mock');
  assert.equal(body.configured, true);
  assert.equal(body.roster.length, 3);
  assert.ok(body.duty);
});

test('POST /api/oncall/alerts/:id/ack：坐席可确认；escalate 仅管理员', async () => {
  const { task } = await ensureHandoffTask({ conversationId: 'c-oncall-api', channel: 'web', priority: 'P0', reason: '接口演练', progress: { doneStages: [], evidence: [], missing: [], candidate: null, failure: null, nextAction: '确认' }, traceId: null });
  const raised = await raiseP0Alert(task.id);
  assert.equal(raised.delivered, true);

  const agent = await cookieOf('agent', 'agent123');
  const analyst = await cookieOf('analyst', 'analyst123');
  const admin = await cookieOf('admin', 'admin123');

  const forbidden = await app.inject({ method: 'POST', url: `/api/oncall/alerts/${task.id}/escalate`, headers: { cookie: analyst } });
  assert.equal(forbidden.statusCode, 403);

  const agentEsc = await app.inject({ method: 'POST', url: `/api/oncall/alerts/${task.id}/escalate`, headers: { cookie: agent } });
  assert.equal(agentEsc.statusCode, 403);

  const esc = await app.inject({ method: 'POST', url: `/api/oncall/alerts/${task.id}/escalate`, headers: { cookie: admin } });
  assert.equal(esc.statusCode, 200);
  assert.equal((JSON.parse(esc.body) as { sent: boolean }).sent, true);

  const ack = await app.inject({ method: 'POST', url: `/api/oncall/alerts/${task.id}/ack`, payload: {}, headers: { cookie: agent } });
  assert.equal(ack.statusCode, 200);
  assert.ok((JSON.parse(ack.body) as { alert: { ackAt: string | null } }).alert.ackAt);

  const skip = await app.inject({ method: 'POST', url: `/api/oncall/alerts/${task.id}/escalate`, headers: { cookie: admin } });
  assert.equal((JSON.parse(skip.body) as { sent: boolean; reason: string }).sent, false);
});
