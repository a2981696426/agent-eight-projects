import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

process.env.LLM_MOCK = '1';
process.env.DATA_DIR = ':memory:';
process.env.WECHAT_MOCK = '1';
process.env.WECHAT_TOKEN = 'e2e-token';
process.env.WECHAT_APPID = 'wx-test-appid';
process.env.WECHAT_AES_KEY = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'; // 43 位

const { initDb, closeDb, openDb } = await import('../src/db.ts');
const { seed } = await import('../src/seed.ts');
const { refreshIndex } = await import('../src/services/chain.ts');
const { buildServer } = await import('../src/server.ts');
const { startJobs, stopJobs } = await import('../src/services/jobs.ts');
const { verifySignature, verifyMsgSignature, decryptMessage, encryptMessage, parseWechatXml, WechatAdapter, wechatAdapter } = await import('../src/channels/wechat.ts');

const sha1 = (...parts: string[]) => createHash('sha1').update([...parts].sort().join('')).digest('hex');

test('verifySignature：sha1(sort(token,timestamp,nonce)) 正确通过、错误拒绝', () => {
  const sig = sha1('e2e-token', '1700000000', 'nonce1');
  assert.equal(verifySignature('e2e-token', '1700000000', 'nonce1', sig), true);
  assert.equal(verifySignature('e2e-token', '1700000000', 'nonce1', 'deadbeef'), false);
  assert.equal(verifySignature('other', '1700000000', 'nonce1', sig), false);
});

test('安全模式：encrypt → decrypt 往返，appId 一致；msg_signature 校验', () => {
  const xml = '<xml><ToUserName><![CDATA[gh_1]]></ToUserName><FromUserName><![CDATA[openid-x]]></FromUserName><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[你好]]></Content><MsgId>1</MsgId></xml>';
  const enc = encryptMessage(process.env.WECHAT_AES_KEY!, xml, 'wx-test-appid');
  const dec = decryptMessage(process.env.WECHAT_AES_KEY!, enc);
  assert.equal(dec.xml, xml);
  assert.equal(dec.appId, 'wx-test-appid');
  const ms = sha1('e2e-token', '1700000000', 'n', enc);
  assert.equal(verifyMsgSignature('e2e-token', '1700000000', 'n', enc, ms), true);
  assert.equal(verifyMsgSignature('e2e-token', '1700000000', 'n', enc, 'bad'), false);
});

test('parseWechatXml：text / image / subscribe 事件 / 不支持类型', () => {
  const text = parseWechatXml('<xml><ToUserName><![CDATA[gh]]></ToUserName><FromUserName><![CDATA[o1]]></FromUserName><CreateTime>1700000000</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[订单 20260918000123 到哪了]]></Content><MsgId>101</MsgId></xml>');
  assert.deepEqual({ kind: text?.kind, uid: text?.externalUserId, mid: text?.externalMsgId, t: text?.text }, { kind: 'text', uid: 'o1', mid: '101', t: '订单 20260918000123 到哪了' });
  const img = parseWechatXml('<xml><FromUserName><![CDATA[o2]]></FromUserName><CreateTime>1700000001</CreateTime><MsgType><![CDATA[image]]></MsgType><PicUrl><![CDATA[https://mmbiz.qpic.cn/x.jpg]]></PicUrl><MediaId><![CDATA[media-1]]></MediaId><MsgId>102</MsgId></xml>');
  assert.equal(img?.kind, 'image');
  assert.equal(img?.attachments[0]?.mediaId, 'media-1');
  const sub = parseWechatXml('<xml><FromUserName><![CDATA[o3]]></FromUserName><CreateTime>1700000002</CreateTime><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[subscribe]]></Event></xml>');
  assert.equal(sub?.kind, 'event');
  assert.equal(sub?.text, '[subscribe]');
  assert.match(sub?.externalMsgId ?? '', /^evt-o3-1700000002/);
  assert.equal(parseWechatXml('<xml><FromUserName><![CDATA[o4]]></FromUserName><MsgType><![CDATA[voice]]></MsgType><MsgId>104</MsgId></xml>'), null);
  assert.equal(parseWechatXml('not xml'), null);
});

test('WechatAdapter mock 模式：send 记录到 mockSent 并返回 ok；health 报告 mock', async () => {
  const a = new WechatAdapter({ appId: 'wx', secret: '', token: 't', aesKey: '', mock: true });
  const r = await a.send('openid-z', '测试');
  assert.equal(r.ok, true);
  assert.equal(a.mockSent.at(-1)?.to, 'openid-z');
  assert.deepEqual(await a.health(), { ok: true, mode: 'mock' });
});

type App = Awaited<ReturnType<typeof buildServer>>;
let app: App;
before(async () => {
  await initDb();
  await seed(true);
  await refreshIndex();
  app = await buildServer();
  await startJobs({ pollingIntervalSeconds: 0.5 });
});
after(async () => {
  await stopJobs();
  await app.close();
  await closeDb();
});

test('GET webhook：签名正确回 echostr（公开接口，无需登录）；签名错误 403', async () => {
  const ts = '1700000000';
  const ok = await app.inject({ method: 'GET', url: `/api/channels/wechat/webhook?signature=${sha1('e2e-token', ts, 'n1')}&timestamp=${ts}&nonce=n1&echostr=hello-wx` });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body, 'hello-wx');
  const bad = await app.inject({ method: 'GET', url: `/api/channels/wechat/webhook?signature=bad&timestamp=${ts}&nonce=n1&echostr=x` });
  assert.equal(bad.statusCode, 403);
});

test('POST webhook：明文文本 → 200 success ≤ 5s → 异步入库并产生 bot 回复 → mock 发送记录；重复 MsgId 幂等', async () => {
  const ts = '1700000000';
  const xml = '<xml><ToUserName><![CDATA[gh_1]]></ToUserName><FromUserName><![CDATA[openid-wh1]]></FromUserName><CreateTime>1700000000</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[你好]]></Content><MsgId>555001</MsgId></xml>';
  const t0 = Date.now();
  const r = await app.inject({ method: 'POST', url: `/api/channels/wechat/webhook?signature=${sha1('e2e-token', ts, 'n2')}&timestamp=${ts}&nonce=n2`, payload: xml, headers: { 'content-type': 'text/xml' } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body, 'success');
  assert.ok(Date.now() - t0 < 5000);

  const end = Date.now() + 15000;
  let convId: string | null = null;
  while (Date.now() < end && !convId) {
    const row = await openDb().get<{ conversation_id: string | null }>("SELECT conversation_id FROM channel_messages WHERE channel='wechat' AND external_msg_id='555001'");
    convId = row?.conversation_id ?? null;
    if (!convId) await new Promise((res) => setTimeout(res, 200));
  }
  assert.ok(convId, '入站应异步落库为会话');
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !wechatAdapter.mockSent.some((s) => s.to === 'openid-wh1')) await new Promise((res) => setTimeout(res, 200));
  assert.ok(wechatAdapter.mockSent.some((s) => s.to === 'openid-wh1'), 'bot 回复应经出站队列以客服消息发送');

  const again = await app.inject({ method: 'POST', url: `/api/channels/wechat/webhook?signature=${sha1('e2e-token', ts, 'n3')}&timestamp=${ts}&nonce=n3`, payload: xml, headers: { 'content-type': 'text/xml' } });
  assert.equal(again.body, 'success');
  await new Promise((res) => setTimeout(res, 1500));
  const users = await openDb().all("SELECT id FROM messages WHERE conversation_id=? AND role='user'", convId!);
  assert.equal(users.length, 1, '重复 MsgId 不得重复落库');
});

test('POST webhook：安全模式密文可解并处理；签名错误 403', async () => {
  const ts = '1700000000';
  const xml = '<xml><ToUserName><![CDATA[gh_1]]></ToUserName><FromUserName><![CDATA[openid-wh2]]></FromUserName><CreateTime>1700000000</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[转人工]]></Content><MsgId>555002</MsgId></xml>';
  const enc = encryptMessage(process.env.WECHAT_AES_KEY!, xml, 'wx-test-appid');
  const body = `<xml><ToUserName><![CDATA[gh_1]]></ToUserName><Encrypt><![CDATA[${enc}]]></Encrypt></xml>`;
  const msgSig = sha1('e2e-token', ts, 'n4', enc);
  const r = await app.inject({ method: 'POST', url: `/api/channels/wechat/webhook?signature=${sha1('e2e-token', ts, 'n4')}&timestamp=${ts}&nonce=n4&encrypt_type=aes&msg_signature=${msgSig}`, payload: body, headers: { 'content-type': 'text/xml' } });
  assert.equal(r.body, 'success');
  const bad = await app.inject({ method: 'POST', url: `/api/channels/wechat/webhook?signature=bad&timestamp=${ts}&nonce=n4`, payload: xml, headers: { 'content-type': 'text/xml' } });
  assert.equal(bad.statusCode, 403);
  const end = Date.now() + 15000;
  let found = false;
  while (Date.now() < end && !found) {
    const row = await openDb().get("SELECT conversation_id FROM channel_messages WHERE channel='wechat' AND external_msg_id='555002' AND conversation_id IS NOT NULL");
    found = !!row;
    if (!found) await new Promise((res) => setTimeout(res, 200));
  }
  assert.equal(found, true);
});

test('GET /api/channels/status 需登录并返回 wechat 适配器与队列状态', async () => {
  const anon = await app.inject({ method: 'GET', url: '/api/channels/status' });
  assert.equal(anon.statusCode, 401);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin123' } });
  const cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const r = await app.inject({ method: 'GET', url: '/api/channels/status', headers: { cookie } });
  assert.equal(r.statusCode, 200);
  const j = JSON.parse(r.body) as { adapters: Record<string, { mode: string }>; jobs: { started: boolean } };
  assert.equal(j.adapters.wechat.mode, 'mock');
  assert.equal(j.jobs.started, true);
});
