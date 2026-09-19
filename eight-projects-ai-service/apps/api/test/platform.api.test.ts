import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.LLM_MOCK = '1';
process.env.DATA_DIR = ':memory:';
process.env.TAOBAO_MODE = 'sandbox';

const { initDb, closeDb } = await import('../src/db.ts');
const { seed } = await import('../src/seed.ts');
const { refreshIndex, runStandalone, platformSource } = await import('../src/services/chain.ts');
const { buildServer } = await import('../src/server.ts');
const { TmallSandboxSource } = await import('../src/services/platform-data.ts');

type App = Awaited<ReturnType<typeof buildServer>>;
let app: App;
let admin = '';
let analyst = '';
const TID = '2026091800012345678';

before(async () => {
  await initDb();
  await seed(true);
  await refreshIndex();
  app = await buildServer();
  for (const [u, p] of [['admin', 'admin123'], ['analyst', 'analyst123']]) {
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u, password: p } });
    const ck = login.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    if (u === 'admin') admin = ck;
    else analyst = ck;
  }
});
after(async () => {
  await app.close();
  await closeDb();
});

test('执行链：天猫订单号被识别为 orderId，物流证据来自 tmall-sandbox 且判定停滞', async () => {
  assert.ok(platformSource instanceof TmallSandboxSource);
  const t = await runStandalone(`订单 ${TID} 的快递三天没动了`, { customerId: null, channel: 'web' });
  assert.equal(t.scenario, 'logistics');
  assert.equal(t.slots.find((s) => s.key === 'orderId')?.value, TID);
  const lg = t.evidence.find((e) => e.tool === 'logistics.track');
  assert.ok(lg && lg.ok, JSON.stringify(t.evidence));
  const data = lg!.data as { source: string; stalled: boolean; carrier: string; readOnly: boolean };
  assert.equal(data.source, 'tmall-sandbox');
  assert.equal(data.stalled, true);
  assert.equal(data.carrier, '顺丰速运');
  assert.equal(data.readOnly, true);
  const od = t.evidence.find((e) => e.tool === 'orders.lookup')!.data as { receiver: { phoneMasked: string }; source: string };
  assert.equal(od.source, 'tmall-sandbox');
  assert.match(od.receiver.phoneMasked, /^\d{3}\*{4}\d{4}$/);
  assert.ok(!JSON.stringify(t.evidence).includes('13900001111'), '原始手机号不得进入证据');
});

test('平台不可用：工具返回 unavailable，证据不完整 → 风险 ≥ L2、不自主回复；恢复后正常', async () => {
  const r = await app.inject({ method: 'POST', url: '/api/platform/tmall/simulate', payload: { mode: 'unavailable' }, headers: { cookie: admin } });
  assert.equal(r.statusCode, 200);
  const t = await runStandalone(`订单 ${TID} 的快递三天没动了`, { customerId: null, channel: 'web' });
  const lg = t.evidence.find((e) => e.tool === 'logistics.track')!;
  assert.equal((lg.data as { unavailable?: boolean }).unavailable, true);
  assert.equal(lg.ok, false, '软失败应计为证据缺口');
  assert.ok(['L2', 'L3'].includes(t.risk!.level), t.risk!.reasons.join(' | '));
  assert.notEqual(t.autonomy?.decision, 'auto_reply');
  const forbidden = await app.inject({ method: 'POST', url: '/api/platform/tmall/simulate', payload: { mode: 'normal' }, headers: { cookie: analyst } });
  assert.equal(forbidden.statusCode, 403);
  await app.inject({ method: 'POST', url: '/api/platform/tmall/simulate', payload: { mode: 'normal' }, headers: { cookie: admin } });
  const t2 = await runStandalone(`订单 ${TID} 的快递三天没动了`, { customerId: null, channel: 'web' });
  assert.equal((t2.evidence.find((e) => e.tool === 'logistics.track')!.data as { stalled: boolean }).stalled, true);
});

test('GET /api/platform/tmall/orders/:id 返回订单/物流/退款；非平台订单号 400；未查到 404；status 报沙箱', async () => {
  (platformSource as InstanceType<typeof TmallSandboxSource>).simulate('normal');
  const ok = await app.inject({ method: 'GET', url: `/api/platform/tmall/orders/2026091600098765432`, headers: { cookie: analyst } });
  assert.equal(ok.statusCode, 200);
  const j = JSON.parse(ok.body) as { order: { statusText: string }; logistics: { status: string }; refunds: { statusText: string }[]; source: string };
  assert.equal(j.order.statusText, '交易成功');
  assert.equal(j.refunds[0].statusText, '买家已申请，等待卖家同意');
  assert.equal(j.source, 'tmall-sandbox');
  assert.equal((await app.inject({ method: 'GET', url: '/api/platform/tmall/orders/20260918000123', headers: { cookie: analyst } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'GET', url: '/api/platform/tmall/orders/9999999999999999', headers: { cookie: analyst } })).statusCode, 404);
  const st = JSON.parse((await app.inject({ method: 'GET', url: '/api/platform/status', headers: { cookie: analyst } })).body) as { platforms: { mode: string; ok: boolean; sampleOrderIds: string[] }[] };
  assert.equal(st.platforms[0].mode, 'sandbox');
  assert.equal(st.platforms[0].ok, true);
  assert.equal(st.platforms[0].sampleOrderIds.length, 3);
});
