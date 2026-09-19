import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { ChannelAdapter, SendResult } from '../src/services/channels.ts';

process.env.LLM_MOCK = '1';
process.env.DATA_DIR = ':memory:';

const { initDb, closeDb, openDb, J } = await import('../src/db.ts');
const { seed } = await import('../src/seed.ts');
const { refreshIndex, loadMessages } = await import('../src/services/chain.ts');
const { registerChannel, channels, resolveIdentity, findOrCreateConversation, ingestInbound, deliverMessage } = await import('../src/services/channels.ts');

class FakeAdapter implements ChannelAdapter {
  readonly channel = 'wechat' as const;
  readonly capabilities = { asyncReply: true, media: true, windowHours: 48 };
  sent: { to: string; text: string }[] = [];
  next: SendResult | null = null;
  async send(to: string, text: string): Promise<SendResult> {
    if (this.next) {
      const r = this.next;
      this.next = null;
      return r;
    }
    this.sent.push({ to, text });
    return { ok: true, externalMsgId: `fake-${this.sent.length}` };
  }
  async health() {
    return { ok: true, mode: 'fake' };
  }
}
const fake = new FakeAdapter();

before(async () => {
  await initDb();
  await seed(true);
  await refreshIndex();
  registerChannel(fake);
});
after(async () => {
  await closeDb();
});

const inbound = (over: Partial<Parameters<typeof ingestInbound>[0]> = {}) => ({
  channel: 'wechat' as const,
  externalUserId: 'openid-A',
  externalMsgId: `m-${Math.random().toString(36).slice(2)}`,
  kind: 'text' as const,
  text: '你好',
  attachments: [],
  receivedAt: new Date().toISOString(),
  displayName: '微信用户A',
  ...over,
});

test('registerChannel 注册后可按渠道取到适配器；web 无适配器', () => {
  assert.equal(channels.get('wechat'), fake);
  assert.equal(channels.get('web'), undefined);
});

test('resolveIdentity：首次创建客户与身份，二次复用', async () => {
  const a = await resolveIdentity('wechat', 'openid-B', '小B');
  assert.equal(a.created, true);
  const b = await resolveIdentity('wechat', 'openid-B');
  assert.equal(b.created, false);
  assert.equal(b.customerId, a.customerId);
  const c = await openDb().get<{ name: string; channel: string }>('SELECT name, channel FROM customers WHERE id=?', a.customerId);
  assert.equal(c?.channel, 'wechat');
  assert.equal(c?.name, '小B');
});

test('findOrCreateConversation：24h 内未结束会话复用；结束后新建', async () => {
  const { customerId } = await resolveIdentity('wechat', 'openid-C');
  const c1 = await findOrCreateConversation('wechat', customerId, '第一句');
  const c2 = await findOrCreateConversation('wechat', customerId, '第二句');
  assert.equal(c1, c2);
  await openDb().run("UPDATE conversations SET status='closed' WHERE id=?", c1);
  const c3 = await findOrCreateConversation('wechat', customerId, '第三句');
  assert.notEqual(c3, c1);
});

test('ingestInbound：文本 → 机器人回复（mock 模型）→ 幂等去重', async () => {
  const msg = inbound({ externalMsgId: 'dup-1' });
  const r1 = await ingestInbound(msg);
  assert.ok(r1.conversationId);
  assert.equal(r1.deduped, false);
  assert.ok(r1.replyMessageId, '机器人接待应产生回复消息');
  const msgs = await loadMessages(r1.conversationId!);
  assert.equal(msgs.filter((m) => m.role === 'user').length, 1);
  assert.equal(msgs.filter((m) => m.role === 'bot').length, 1);

  const r2 = await ingestInbound(msg);
  assert.equal(r2.deduped, true);
  assert.equal(r2.replyMessageId, null);
  assert.equal((await loadMessages(r1.conversationId!)).filter((m) => m.role === 'user').length, 1, '重复 MsgId 不得再落用户消息');
});

test('ingestInbound：人工接待中只落库不触发执行链', async () => {
  const first = await ingestInbound(inbound({ externalUserId: 'openid-H', text: '你好' }));
  await openDb().run("UPDATE conversations SET controller='human', status='open', assignee='客服小欧' WHERE id=?", first.conversationId);
  const before = (await loadMessages(first.conversationId!)).length;
  const r = await ingestInbound(inbound({ externalUserId: 'openid-H', text: '人在吗' }));
  assert.equal(r.conversationId, first.conversationId);
  assert.equal(r.replyMessageId, null);
  const after = await loadMessages(first.conversationId!);
  assert.equal(after.length, before + 1);
  assert.equal(after[after.length - 1].role, 'user');
});

test('ingestInbound：subscribe 事件产生欢迎语回复', async () => {
  const r = await ingestInbound(inbound({ externalUserId: 'openid-S', kind: 'event', text: '[subscribe]' }));
  assert.ok(r.replyMessageId);
  const msgs = await loadMessages(r.conversationId!);
  assert.match(msgs.find((m) => m.id === r.replyMessageId)!.text, /欢迎/);
});

test('deliverMessage：成功写 delivery.sent；window_expired 写 failed 并追加系统消息；web 渠道 skipped', async () => {
  const r = await ingestInbound(inbound({ externalUserId: 'openid-D', text: '你好' }));
  const ok = await deliverMessage(r.conversationId!, r.replyMessageId!);
  assert.equal(ok.ok, true);
  const row = await openDb().get<{ meta: string }>('SELECT meta FROM messages WHERE id=?', r.replyMessageId!);
  assert.equal(J.parse<{ delivery: { status: string } }>(row?.meta, { delivery: { status: '' } }).delivery.status, 'sent');
  assert.equal(fake.sent.at(-1)?.to, 'openid-D');

  fake.next = { ok: false, kind: 'window_expired', message: '45015 response out of time limit', retryable: false };
  const r2 = await ingestInbound(inbound({ externalUserId: 'openid-D', text: '再问一句' }));
  const bad = await deliverMessage(r2.conversationId!, r2.replyMessageId!);
  assert.equal(bad.ok, false);
  const row2 = await openDb().get<{ meta: string }>('SELECT meta FROM messages WHERE id=?', r2.replyMessageId!);
  assert.equal(J.parse<{ delivery: { status: string; kind: string } }>(row2?.meta, { delivery: { status: '', kind: '' } }).delivery.status, 'failed');
  const sys = (await loadMessages(r2.conversationId!)).filter((m) => m.role === 'system');
  assert.ok(sys.some((m) => /48 小时/.test(m.text)));

  const webConv = await openDb().get<{ id: string }>("SELECT id FROM conversations WHERE channel='web' LIMIT 1");
  const webMsg = await openDb().get<{ id: string }>('SELECT id FROM messages WHERE conversation_id=? LIMIT 1', webConv!.id);
  const skipped = await deliverMessage(webConv!.id, webMsg!.id);
  assert.equal(skipped.skipped, true);
});
