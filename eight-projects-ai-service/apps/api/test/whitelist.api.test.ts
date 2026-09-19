import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.LLM_MOCK = '1';
process.env.DATA_DIR = ':memory:';

const { initDb, closeDb } = await import('../src/db.ts');
const { seed } = await import('../src/seed.ts');
const { refreshIndex, runStandalone } = await import('../src/services/chain.ts');
const { buildServer } = await import('../src/server.ts');
const { clearWhitelistCache } = await import('../src/services/whitelist.ts');

type App = Awaited<ReturnType<typeof buildServer>>;
let app: App;
let admin = '';
let agentCookie = '';
const call = async (method: 'GET' | 'POST', url: string, body?: unknown, cookie = admin) => {
  const r = await app.inject({ method, url, payload: body as Record<string, unknown> | undefined, headers: { cookie } });
  return { status: r.statusCode, json: r.body ? (JSON.parse(r.body) as Record<string, unknown>) : null };
};

before(async () => {
  await initDb();
  await seed(true);
  await refreshIndex();
  app = await buildServer();
  for (const [u, p] of [['admin', 'admin123'], ['agent', 'agent123']]) {
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u, password: p } });
    const ck = login.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    if (u === 'admin') admin = ck;
    else agentCookie = ck;
  }
});
after(async () => {
  await app.close();
  await closeDb();
});

test('seed 后两个范围各有 v1 生效；active 接口返回门禁版本', async () => {
  const r = await call('GET', '/api/whitelists/active');
  assert.equal(r.status, 200);
  assert.equal((r.json!.owned as { version: number }).version, 1);
  assert.equal((r.json!.platform as { version: number }).version, 1);
  assert.equal((r.json!.gates as { web: string }).web, 'owned@1');
});

test('执行链在 web 渠道按 owned 白名单自动回复并记录版本；停用后同一问题不再自动回复', async () => {
  const t1 = await runStandalone('订单 20260918000123 的快递三天没动了', { customerId: 'cust-001', channel: 'web' });
  assert.equal(t1.autonomy?.decision, 'auto_reply');
  assert.equal(t1.autonomy?.whitelistVersion, 'owned@1');

  const list = (await call('GET', '/api/whitelists?scope=owned')).json as unknown as { id: string; status: string }[];
  const v1 = list.find((w) => w.status === 'published')!;
  assert.equal((await call('POST', `/api/whitelists/${v1.id}/disable`, { reason: '演练' })).status, 200);
  clearWhitelistCache();
  const t2 = await runStandalone('订单 20260918000123 的快递三天没动了', { customerId: 'cust-001', channel: 'web' });
  assert.notEqual(t2.autonomy?.decision, 'auto_reply');
  assert.equal(t2.autonomy?.whitelistVersion, null);
  assert.ok(t2.autonomy?.reasons.some((r) => /默认拒绝/.test(r)));
});

test('草稿 → 签发 → 发布 恢复自动回复；坐席角色写操作 403', async () => {
  const forbidden = await call('POST', '/api/whitelists', { scope: 'owned', items: [{ scenario: 'logistics', maxRisk: 'L1' }] }, agentCookie);
  assert.equal(forbidden.status, 403);
  const draft = await call('POST', '/api/whitelists', { scope: 'owned', items: [{ scenario: 'logistics', maxRisk: 'L1' }, { scenario: 'general', maxRisk: 'L1' }], note: 'v2 恢复' });
  assert.equal(draft.status, 201);
  const id = String(draft.json!.id);
  assert.equal((await call('POST', `/api/whitelists/${id}/publish`)).status, 409, '未签发不能发布');
  assert.equal((await call('POST', `/api/whitelists/${id}/sign`)).status, 200);
  const pub = await call('POST', `/api/whitelists/${id}/publish`);
  assert.equal(pub.status, 200);
  assert.equal(pub.json!.status, 'published');
  clearWhitelistCache();
  const t3 = await runStandalone('订单 20260918000123 的快递三天没动了', { customerId: 'cust-001', channel: 'web' });
  assert.equal(t3.autonomy?.decision, 'auto_reply');
  assert.equal(t3.autonomy?.whitelistVersion, 'owned@2');
  const audit = (await call('GET', '/api/audit')).json as unknown as { action: string }[];
  assert.ok(audit.some((a) => a.action === 'whitelist.publish'));
});

test('platform 渠道：工作时段一律不自动回复（辅助模式）', async () => {
  // 用 taobao 渠道试跑；无论当前是否工作时段，结果都不得违反：工作时段 → 非 auto；非工作时段 → 允许 auto
  const { isWorkTime, calendarFromEnv } = await import('../src/services/handoff.ts');
  const t = await runStandalone('订单 20260918000123 的快递三天没动了', { customerId: 'cust-001', channel: 'taobao' });
  if (isWorkTime(new Date(), calendarFromEnv())) {
    assert.notEqual(t.autonomy?.decision, 'auto_reply');
    assert.ok(t.autonomy?.reasons.some((r) => /辅助模式|工作时段/.test(r)));
  } else {
    assert.equal(t.autonomy?.whitelistVersion, 'platform@1');
  }
});
