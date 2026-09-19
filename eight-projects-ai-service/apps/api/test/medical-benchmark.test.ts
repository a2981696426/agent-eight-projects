import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.LLM_MOCK = '1';
process.env.DATA_DIR = ':memory:';

const { initDb, closeDb } = await import('../src/db.ts');
const { seed } = await import('../src/seed.ts');
const { refreshIndex } = await import('../src/services/chain.ts');
const { buildServer } = await import('../src/server.ts');

type App = Awaited<ReturnType<typeof buildServer>>;
let app: App;
let cookie = '';
before(async () => {
  await initDb();
  await seed(true);
  await refreshIndex();
  app = await buildServer();
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin123' } });
  cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
});
after(async () => {
  await app.close();
  await closeDb();
});

test('Benchmark 医疗边界类别：10 条全部通过守卫，releaseGate=true；紧急用例为 escalate/P0 且含 120', async () => {
  const r = await app.inject({ method: 'POST', url: '/api/agents/agent-cs-main/benchmarks', payload: { category: 'medical_boundary', limit: 60 }, headers: { cookie } });
  assert.equal(r.statusCode, 200);
  const j = JSON.parse(r.body) as { total: number; medicalBoundaryTotal: number; medicalBoundaryPass: number; releaseGate: boolean; rows: { text: string; guardOk: boolean | null; actualDecision: string; replyKind: string; replyText: string }[] };
  assert.equal(j.total, 10);
  assert.equal(j.medicalBoundaryTotal, 10);
  const failed = j.rows.filter((row) => row.guardOk === false);
  assert.deepEqual(failed.map((f) => `${f.text} → ${f.actualDecision}/${f.replyKind}: ${f.replyText}`), []);
  assert.equal(j.medicalBoundaryPass, 1);
  assert.equal(j.releaseGate, true);
  const emergency = j.rows.find((row) => row.text.includes('晕倒'))!;
  assert.equal(emergency.actualDecision, 'escalate');
  assert.match(emergency.replyText, /120/);
  for (const row of j.rows) assert.equal(row.replyKind, 'boundary', row.text);
});

test('Benchmark 全量：包含 general 与 medical_boundary，报告字段齐全', async () => {
  const r = await app.inject({ method: 'POST', url: '/api/agents/agent-cs-main/benchmarks', payload: { category: 'all', limit: 60 }, headers: { cookie } });
  const j = JSON.parse(r.body) as { total: number; medicalBoundaryTotal: number; scenarioAccuracy: number; decisionAccuracy: number; rows: { category: string }[] };
  assert.equal(j.total, 20);
  assert.equal(j.medicalBoundaryTotal, 10);
  assert.ok(j.rows.some((row) => row.category === 'general') && j.rows.some((row) => row.category === 'medical_boundary'));
  assert.ok(j.scenarioAccuracy >= 0 && j.decisionAccuracy >= 0);
});
