import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { ChannelAdapter, SendResult } from '../src/services/channels.ts';

process.env.LLM_MOCK = '1';
process.env.DATA_DIR = ':memory:';

const { initDb, closeDb, openDb, J } = await import('../src/db.ts');
const { seed } = await import('../src/seed.ts');
const { refreshIndex, appendMessage } = await import('../src/services/chain.ts');
const { registerChannel, resolveIdentity, findOrCreateConversation } = await import('../src/services/channels.ts');
const { startJobs, stopJobs, enqueueDeliver, enqueueInbound, jobsStatus, jobById, QUEUES } = await import('../src/services/jobs.ts');

class FlakyAdapter implements ChannelAdapter {
  readonly channel = 'wechat' as const;
  readonly capabilities = { asyncReply: true, media: true, windowHours: 48 };
  failuresLeft = 0;
  sent: string[] = [];
  async send(_to: string, text: string): Promise<SendResult> {
    if (this.failuresLeft > 0) {
      this.failuresLeft--;
      return { ok: false, kind: 'unavailable', message: '模拟上游超时', retryable: true };
    }
    this.sent.push(text);
    return { ok: true, externalMsgId: `x-${this.sent.length}` };
  }
  async health() {
    return { ok: true, mode: 'flaky' };
  }
}
const adapter = new FlakyAdapter();

const waitFor = async (fn: () => Promise<boolean>, timeoutMs: number) => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
};
const delivery = async (messageId: string) => {
  const row = await openDb().get<{ meta: string }>('SELECT meta FROM messages WHERE id=?', messageId);
  return J.parse<{ delivery?: { status: string } }>(row?.meta, {}).delivery?.status ?? null;
};

before(async () => {
  await initDb();
  await seed(true);
  await refreshIndex();
  registerChannel(adapter);
  await startJobs({ pollingIntervalSeconds: 0.5 });
});
after(async () => {
  await stopJobs();
  await closeDb();
});

test('startJobs 在 PGlite 后端启动并创建三个队列', () => {
  const s = jobsStatus();
  assert.equal(s.started, true);
  assert.equal(s.backend, 'pglite');
  assert.deepEqual(s.queues, [QUEUES.inbound, QUEUES.deliver, QUEUES.embed]);
});

test('enqueueDeliver：worker 投递成功并写 delivery.sent', async () => {
  const { customerId } = await resolveIdentity('wechat', 'openid-J1');
  const conv = await findOrCreateConversation('wechat', customerId, '队列测试');
  const m = await appendMessage(conv, 'bot', '队列投递的消息');
  const jobId = await enqueueDeliver(conv, m.id);
  assert.ok(jobId);
  assert.equal(await waitFor(async () => (await delivery(m.id)) === 'sent', 8000), true);
  assert.ok(adapter.sent.includes('队列投递的消息'));
});

test('可重试失败按 pg-boss 重试，最终成功；retryCount ≥ 2', async () => {
  const { customerId } = await resolveIdentity('wechat', 'openid-J2');
  const conv = await findOrCreateConversation('wechat', customerId, '重试测试');
  const m = await appendMessage(conv, 'bot', '重试后送达');
  adapter.failuresLeft = 2;
  const jobId = await enqueueDeliver(conv, m.id, { retryDelay: 1, retryLimit: 5 });
  assert.ok(jobId);
  assert.equal(await waitFor(async () => (await delivery(m.id)) === 'sent', 20000), true);
  const job = await jobById(QUEUES.deliver, jobId!);
  assert.ok(job);
  assert.ok((job!.retryCount ?? 0) >= 2, `retryCount=${job!.retryCount}`);
});

test('enqueueInbound：入站入队 → 执行链回复 → 自动入队投递', async () => {
  const id = `in-${Date.now()}`;
  const jobId = await enqueueInbound({ channel: 'wechat', externalUserId: 'openid-J3', externalMsgId: id, kind: 'text', text: '你好', attachments: [], receivedAt: new Date().toISOString() });
  assert.ok(jobId);
  const ok = await waitFor(async () => {
    const row = await openDb().get<{ conversation_id: string | null }>('SELECT conversation_id FROM channel_messages WHERE channel=? AND external_msg_id=?', 'wechat', id);
    if (!row?.conversation_id) return false;
    const bot = await openDb().get<{ id: string; meta: string }>("SELECT id, meta FROM messages WHERE conversation_id=? AND role='bot' ORDER BY at DESC LIMIT 1", row.conversation_id);
    return !!bot && J.parse<{ delivery?: { status: string } }>(bot.meta, {}).delivery?.status === 'sent';
  }, 15000);
  assert.equal(ok, true);
});
