import type { Channel, DeliveryInfo, InboundMessage, SendFailure, SendResult } from '@eight/shared';
import { J, nowIso, openDb, uid } from '../db.ts';
import { appendMessage, runForConversation } from './chain.ts';

export type { InboundMessage, SendFailure, SendResult } from '@eight/shared';

/**
 * 渠道消息通道 / 渠道适配器（词汇表）：
 * - 适配器只做协议、授权、限流、会话与错误语义；不拥有意图、知识、规则或回复决策
 * - 入站按 (channel, externalMsgId) 幂等；外部身份映射到演示客户档案，不与 UMS/佩戴用户合并（CS-006A）
 * - 同一会话回合只有一个活动响应者：机器人接待走执行链，人工接待只落库
 * - 投递结果如实写回 messages.meta.delivery，不伪造送达
 */
export interface ChannelAdapter {
  readonly channel: Channel;
  readonly capabilities: { asyncReply: boolean; media: boolean; windowHours: number | null };
  send(externalUserId: string, text: string): Promise<SendResult>;
  health(): Promise<{ ok: boolean; mode: string }>;
}

export const channels = new Map<Channel, ChannelAdapter>();
export function registerChannel(adapter: ChannelAdapter) {
  channels.set(adapter.channel, adapter);
}

const db = () => openDb();
const CHANNEL_LABEL: Record<string, string> = { wechat: '微信用户', app: 'App 用户', web: '网页访客', taobao: '淘宝买家', douyin: '抖音用户', jd: '京东买家' };
/** 24 小时内未结束的同渠道会话复用 */
const REUSE_WINDOW_MS = 24 * 3600e3;
export const WELCOME_TEXT = '您好，欢迎咨询欧态官方客服。可以直接描述问题（如订单号 + 物流 / 发票 / 退款），我会为您查询；需要人工时回复「转人工」。';

export async function resolveIdentity(channel: Channel, externalUserId: string, displayName?: string): Promise<{ customerId: string; created: boolean }> {
  const now = nowIso();
  const row = await db().get<{ customer_id: string }>('SELECT customer_id FROM channel_identities WHERE channel=? AND external_user_id=?', channel, externalUserId);
  if (row) {
    await db().run('UPDATE channel_identities SET last_seen_at=? WHERE channel=? AND external_user_id=?', now, channel, externalUserId);
    return { customerId: row.customer_id, created: false };
  }
  const customerId = uid('cust-');
  const name = displayName?.trim() || `${CHANNEL_LABEL[channel] ?? '访客'}${externalUserId.slice(-4)}`;
  await db().run('INSERT INTO customers VALUES (?,?,?,?,?,?,?)', customerId, name, '', 'normal', channel, J.str(['渠道接入']), `外部身份 ${channel}:${externalUserId}`);
  await db().run('INSERT INTO channel_identities VALUES (?,?,?,?,?,?) ON CONFLICT (channel, external_user_id) DO NOTHING', channel, externalUserId, customerId, displayName ?? null, now, now);
  return { customerId, created: true };
}

export async function externalUserOf(channel: Channel, customerId: string): Promise<string | null> {
  const row = await db().get<{ external_user_id: string }>('SELECT external_user_id FROM channel_identities WHERE channel=? AND customer_id=? ORDER BY last_seen_at DESC LIMIT 1', channel, customerId);
  return row?.external_user_id ?? null;
}

export async function findOrCreateConversation(channel: Channel, customerId: string, title: string): Promise<string> {
  const since = new Date(Date.now() - REUSE_WINDOW_MS).toISOString();
  const open = await db().get<{ id: string }>("SELECT id FROM conversations WHERE channel=? AND customer_id=? AND status <> 'closed' AND last_message_at >= ? ORDER BY last_message_at DESC LIMIT 1", channel, customerId, since);
  if (open) return open.id;
  const id = uid('conv-');
  const now = nowIso();
  await db().run('INSERT INTO conversations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id, title.slice(0, 60) || '渠道咨询', channel, customerId, 'open', 'bot', null, null, null, now, now, null, 'agent-cs-main', null);
  return id;
}

export interface IngestResult {
  conversationId: string | null;
  deduped: boolean;
  /** 需要经渠道投递的机器人回复消息 id（人工接待或去重时为 null） */
  replyMessageId: string | null;
}

/** 入站编排：幂等 → 身份 → 会话 → 机器人接待走执行链 / 人工接待只落库 */
export async function ingestInbound(msg: InboundMessage): Promise<IngestResult> {
  const dedupe = await db().run('INSERT INTO channel_messages VALUES (?,?,?,?,?) ON CONFLICT (channel, external_msg_id) DO NOTHING', msg.channel, msg.externalMsgId, null, null, msg.receivedAt);
  if (dedupe.changes === 0) {
    const prev = await db().get<{ conversation_id: string | null }>('SELECT conversation_id FROM channel_messages WHERE channel=? AND external_msg_id=?', msg.channel, msg.externalMsgId);
    return { conversationId: prev?.conversation_id ?? null, deduped: true, replyMessageId: null };
  }
  const { customerId } = await resolveIdentity(msg.channel, msg.externalUserId, msg.displayName);
  const text = msg.kind === 'image' ? `[图片]${msg.text ? ` ${msg.text}` : ''}` : msg.text;
  const conversationId = await findOrCreateConversation(msg.channel, customerId, msg.kind === 'event' ? '渠道关注' : text);

  if (msg.kind === 'event') {
    const bot = await appendMessage(conversationId, 'bot', WELCOME_TEXT, { meta: { kind: 'welcome', event: msg.text } });
    await db().run('UPDATE channel_messages SET conversation_id=?, message_id=? WHERE channel=? AND external_msg_id=?', conversationId, bot.id, msg.channel, msg.externalMsgId);
    return { conversationId, deduped: false, replyMessageId: bot.id };
  }

  const conv = await db().get<{ controller: string; status: string }>('SELECT controller, status FROM conversations WHERE id=?', conversationId);
  if (conv?.controller !== 'bot') {
    // 人工接待：只落库，由坐席回复（经同一出站队列投递）
    const m = await appendMessage(conversationId, 'user', text, { meta: { channel: msg.channel, externalMsgId: msg.externalMsgId, attachments: msg.attachments } });
    await db().run("UPDATE conversations SET status=CASE WHEN status='closed' THEN 'open' ELSE status END WHERE id=?", conversationId);
    await db().run('UPDATE channel_messages SET conversation_id=?, message_id=? WHERE channel=? AND external_msg_id=?', conversationId, m.id, msg.channel, msg.externalMsgId);
    return { conversationId, deduped: false, replyMessageId: null };
  }

  const r = await runForConversation(conversationId, text, { mode: 'bot' });
  if (r.userMessage) {
    await db().run('UPDATE messages SET meta=? WHERE id=?', J.str({ ...(r.userMessage.meta ?? {}), channel: msg.channel, externalMsgId: msg.externalMsgId, attachments: msg.attachments }), r.userMessage.id);
    await db().run('UPDATE channel_messages SET conversation_id=?, message_id=? WHERE channel=? AND external_msg_id=?', conversationId, r.userMessage.id, msg.channel, msg.externalMsgId);
  }
  return { conversationId, deduped: false, replyMessageId: r.botMessage?.id ?? null };
}

async function writeDelivery(messageId: string, info: DeliveryInfo) {
  const row = await db().get<{ meta: string }>('SELECT meta FROM messages WHERE id=?', messageId);
  const meta = J.parse<Record<string, unknown>>(row?.meta, {});
  await db().run('UPDATE messages SET meta=? WHERE id=?', J.str({ ...meta, delivery: info }), messageId);
}

/** 出站投递：无适配器（如 web 访客端自行轮询）或无外部身份 → skipped；结果如实写回 */
export async function deliverMessage(conversationId: string, messageId: string): Promise<SendResult & { skipped?: boolean }> {
  const conv = await db().get<{ channel: Channel; customer_id: string }>('SELECT channel, customer_id FROM conversations WHERE id=?', conversationId);
  const msg = await db().get<{ text: string; role: string }>('SELECT text, role FROM messages WHERE id=?', messageId);
  if (!conv || !msg) return { ok: false, kind: 'rejected', message: '会话或消息不存在', retryable: false };
  const adapter = channels.get(conv.channel);
  const to = adapter ? await externalUserOf(conv.channel, conv.customer_id) : null;
  if (!adapter || !to) {
    await writeDelivery(messageId, { status: 'skipped', at: nowIso(), channel: conv.channel });
    return { ok: true, externalMsgId: null, skipped: true };
  }
  const r = await adapter.send(to, msg.text);
  if (r.ok) {
    await writeDelivery(messageId, { status: 'sent', at: nowIso(), channel: conv.channel, externalMsgId: r.externalMsgId });
    return r;
  }
  if (!r.retryable) {
    await writeDelivery(messageId, { status: 'failed', at: nowIso(), channel: conv.channel, error: r.message, kind: r.kind });
    const hint = r.kind === 'window_expired' ? '渠道发送失败：超出 48 小时互动窗口，需等待用户再次发消息后才能送达' : `渠道发送失败：${r.message}`;
    await appendMessage(conversationId, 'system', `【${hint}】`, { meta: { internal: true, delivery: r.kind, messageId } });
  } else {
    await writeDelivery(messageId, { status: 'queued', at: nowIso(), channel: conv.channel, error: r.message, kind: r.kind });
  }
  return r;
}

export async function channelStatus() {
  const out: Record<string, { ok: boolean; mode: string; capabilities: ChannelAdapter['capabilities'] }> = {};
  for (const [k, a] of channels) out[k] = { ...(await a.health()), capabilities: a.capabilities };
  return out;
}
