import { PgBoss, fromPglite } from 'pg-boss';
import type { InboundMessage } from '@eight/shared';
import { driverHandle } from '../db.ts';
import { deliverMessage, ingestInbound } from './channels.ts';
import { embedDoc } from './chain.ts';
import { escalateIfUnacked, pendingP0Unacked } from './oncall.ts';

/**
 * 异步作业（CS-013：pg-boss，同库，不引入 Redis）：
 * - channel.inbound：渠道 Webhook 先 ack 再处理（微信 5 秒窗口）
 * - channel.deliver：出站投递，可重试失败按退避重试，不可重试失败由 deliverMessage 如实写回
 * - knowledge.embed：发布/导入后补齐向量
 * - oncall.watch：P0 未确认 15 分钟升级下一跳
 * PGlite（本机/测试）用 fromPglite 共享同一实例；生产用 PostgreSQL 连接串。
 */
export const QUEUES = { inbound: 'channel.inbound', deliver: 'channel.deliver', embed: 'knowledge.embed', alert: 'oncall.watch' } as const;

interface DeliverPayload {
  conversationId: string;
  messageId: string;
}
interface EmbedPayload {
  /** null = 补齐所有缺失块 */
  docId: string | null;
}
interface AlertPayload {
  taskId: string;
}

let boss: PgBoss | null = null;
let backend: 'pg' | 'pglite' | 'none' = 'none';

export function jobsStatus() {
  return { started: !!boss, backend, queues: Object.values(QUEUES) };
}

export async function startJobs(opts: { pollingIntervalSeconds?: number } = {}): Promise<void> {
  if (boss) return;
  const handle = driverHandle();
  const b = handle.kind === 'pglite'
    ? new PgBoss({ db: fromPglite(handle.pglite), backend: 'pglite', supervise: true, schedule: false })
    : new PgBoss({ connectionString: handle.connectionString, schema: 'pgboss', supervise: true, schedule: false, max: 3 });
  b.on('error', (e) => console.error('[jobs]', (e as Error).message));
  await b.start();
  await b.createQueue(QUEUES.inbound, { retryLimit: 3, retryDelay: 5, retryBackoff: true, expireInSeconds: 120 });
  await b.createQueue(QUEUES.deliver, { retryLimit: 5, retryDelay: 5, retryBackoff: true, expireInSeconds: 60 });
  await b.createQueue(QUEUES.embed, { retryLimit: 3, retryDelay: 10, retryBackoff: true, expireInSeconds: 300 });
  await b.createQueue(QUEUES.alert, { retryLimit: 2, retryDelay: 60, retryBackoff: true, expireInSeconds: 1800 });
  const pollingIntervalSeconds = opts.pollingIntervalSeconds ?? 1;

  await b.work<AlertPayload>(QUEUES.alert, { pollingIntervalSeconds, batchSize: 5 }, async ([job]) => {
    const r = await escalateIfUnacked(job.data.taskId);
    if (r.sent && !r.task.alert?.ackAt) await enqueueOncallWatch(job.data.taskId, 900);
    return { sent: r.sent, reason: r.reason };
  });

  await b.work<EmbedPayload>(QUEUES.embed, { pollingIntervalSeconds, batchSize: 1 }, async ([job]) => {
    const n = await embedDoc(job.data.docId);
    return { embedded: n };
  });

  await b.work<InboundMessage>(QUEUES.inbound, { pollingIntervalSeconds, batchSize: 5, perJobResults: true }, async (jobs) => {
    return Promise.all(
      jobs.map(async (job) => {
        try {
          const r = await ingestInbound(job.data);
          if (r.conversationId && r.replyMessageId) await enqueueDeliver(r.conversationId, r.replyMessageId);
          return { id: job.id, status: 'completed' as const, output: r };
        } catch (e) {
          return { id: job.id, status: 'failed' as const, output: { error: (e as Error).message } };
        }
      }),
    );
  });

  await b.work<DeliverPayload>(QUEUES.deliver, { pollingIntervalSeconds, batchSize: 5, perJobResults: true }, async (jobs) => {
    return Promise.all(
      jobs.map(async (job) => {
        const r = await deliverMessage(job.data.conversationId, job.data.messageId);
        // 可重试失败（上游不可用/限流）→ 失败以触发 pg-boss 重试；其余（成功 / 不可重试 / skipped）→ 完成
        if (!r.ok && r.retryable) return { id: job.id, status: 'failed' as const, output: { kind: r.kind, message: r.message } };
        return { id: job.id, status: 'completed' as const, output: r };
      }),
    );
  });

  boss = b;
  backend = handle.kind;
  for (const t of await pendingP0Unacked()) await enqueueOncallWatch(t.id, 60);
}

export async function stopJobs(): Promise<void> {
  if (!boss) return;
  const b = boss;
  boss = null;
  backend = 'none';
  await b.stop({ graceful: true, timeout: 5000 }).catch(() => undefined);
}

export async function enqueueInbound(msg: InboundMessage): Promise<string | null> {
  if (!boss) {
    // 队列未启动（如单测只测编排）：直接同步处理，保证不丢消息
    const r = await ingestInbound(msg);
    if (r.conversationId && r.replyMessageId) await deliverMessage(r.conversationId, r.replyMessageId);
    return null;
  }
  return boss.send(QUEUES.inbound, msg, { singletonKey: `${msg.channel}:${msg.externalMsgId}`, singletonSeconds: 60 });
}

export async function enqueueDeliver(conversationId: string, messageId: string, opts: { retryDelay?: number; retryLimit?: number } = {}): Promise<string | null> {
  if (!boss) {
    await deliverMessage(conversationId, messageId);
    return null;
  }
  return boss.send(QUEUES.deliver, { conversationId, messageId } satisfies DeliverPayload, { retryLimit: opts.retryLimit ?? 5, retryDelay: opts.retryDelay ?? 5, retryBackoff: true, singletonKey: messageId, singletonSeconds: 5 });
}

export async function jobById(queue: string, id: string) {
  return boss ? boss.getJobById(queue, id) : null;
}

/** P0 未确认守望：默认 15 分钟后检查升级链；队列未启动时由调用方同步 escalate */
export async function enqueueOncallWatch(taskId: string, delaySeconds = 900): Promise<string | null> {
  if (!boss) return null;
  return boss.send(QUEUES.alert, { taskId } satisfies AlertPayload, { startAfter: delaySeconds, expireInSeconds: delaySeconds + 180, singletonKey: `p0:${taskId}`, singletonSeconds: Math.max(30, delaySeconds) });
}

/** 知识向量化：发布 / 重切块 / 导入后调用；队列未启动时同步执行 */
export async function enqueueEmbed(docId: string | null): Promise<string | null> {
  if (!boss) {
    await embedDoc(docId);
    return null;
  }
  return boss.send(QUEUES.embed, { docId } satisfies EmbedPayload, { singletonKey: `embed:${docId ?? '*'}`, singletonSeconds: 5, retryLimit: 3, retryDelay: 10, retryBackoff: true });
}
