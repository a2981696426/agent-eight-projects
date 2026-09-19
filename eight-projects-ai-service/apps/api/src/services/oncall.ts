import type { HandoffTask } from '@eight/shared';
import { J, nowIso, openDb } from '../db.ts';
import { calendarFromEnv, computeWindow, loadTask, rowToTask } from './handoff.ts';

/**
 * P0 轮值告警（CS-008H / ADR-0035）：
 * - 不配 7×24 在线坐席；P0 必须投递轮值并沿升级链持续通知
 * - **只有取得投递回执后**才能对访客说「已优先通知专人」
 * - 15 自然分钟未确认 → 下一跳；花名册走完仍记录失败，不得静默
 */
export const visitorP0Sentence = (delivered: boolean) => (delivered ? '已优先通知专人处理，专人会尽快联系您' : '已升级处理，专人会尽快联系您');

export interface OncallHop {
  at: string;
  target: string;
  ok: boolean;
  receipt: string | null;
  error?: string;
}
export interface OncallTransport {
  readonly id: string;
  send(target: string, text: string): Promise<{ ok: boolean; receipt: string | null; error?: string }>;
}

const db = () => openDb();

export function rosterFromEnv(): string[] {
  return (process.env.ONCALL_ROSTER ?? '')
    .split(/[,，;；]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 当天当值 = 花名册按本地日期轮转；升级链 = 当值起向后环形排列 */
export function currentOncall(now = new Date()): { name: string; chain: string[] } {
  const roster = rosterFromEnv();
  if (!roster.length) throw new Error('ONCALL_ROSTER 花名册为空，无法投递 P0 告警');
  const dayIndex = Math.floor(now.getTime() / 86_400_000);
  const start = ((dayIndex % roster.length) + roster.length) % roster.length;
  const chain = [...roster.slice(start), ...roster.slice(0, start)];
  return { name: chain[0], chain };
}

export class MockOncall implements OncallTransport {
  readonly id = 'mock';
  sent: { target: string; text: string }[] = [];
  failNext = 0;
  async send(target: string, text: string) {
    if (this.failNext > 0) {
      this.failNext--;
      return { ok: false, receipt: null, error: '模拟投递失败' };
    }
    this.sent.push({ target, text });
    return { ok: true, receipt: `mock-${this.sent.length}` };
  }
}

export class WecomWebhook implements OncallTransport {
  readonly id = 'wecom';
  constructor(
    readonly webhookUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  async send(target: string, text: string) {
    const body = { msgtype: 'markdown', markdown: { content: `**【P0 轮值告警】** 请 **${target}** 确认\n${text}` } };
    const res = await this.fetchImpl(this.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    const raw = await res.text();
    let errcode = res.ok ? 0 : res.status;
    try {
      errcode = Number((JSON.parse(raw) as { errcode?: number }).errcode ?? errcode);
    } catch {
      /* 非 JSON 以 HTTP 状态为准 */
    }
    if (!res.ok || errcode !== 0) return { ok: false, receipt: null, error: `wecom HTTP ${res.status} errcode=${errcode} ${raw.slice(0, 160)}` };
    return { ok: true, receipt: `wecom-${Date.now()}` };
  }
}

let cached: OncallTransport | null | undefined;
export function oncallFromEnv(): OncallTransport | null {
  if (cached !== undefined) return cached;
  const mode = (process.env.ONCALL_MODE ?? 'off').toLowerCase();
  if (mode === 'off') cached = null;
  else if (mode === 'mock') cached = new MockOncall();
  else if (mode === 'wecom') {
    const url = process.env.ONCALL_WEBHOOK ?? '';
    cached = url ? new WecomWebhook(url) : null;
    if (!url) console.warn('[oncall] ONCALL_MODE=wecom 但缺少 ONCALL_WEBHOOK，告警通道关闭');
  } else cached = new MockOncall();
  return cached;
}
export function resetOncallCache() {
  cached = undefined;
}

function persistAlert(task: HandoffTask) {
  return db().run('UPDATE handoff_tasks SET alert=?, window_text=?, history=? WHERE id=?', J.str(task.alert), task.windowText, J.str(task.history), task.id);
}

function composeText(task: HandoffTask, hop: number, total: number) {
  return [
    `任务 ${task.id} · 渠道 ${task.channel} · 会话 ${task.conversationId}`,
    `原因：${task.reason}`,
    `确认时限：15 自然分钟（第 ${hop + 1}/${total} 跳）`,
    `确认：POST /api/oncall/alerts/${task.id}/ack`,
  ].join('\n');
}

/** 向升级链的下一跳投递；成功才写 deliveredAt 并改对外时窗文案 */
export async function raiseP0Alert(taskId: string): Promise<{ delivered: boolean; task: HandoffTask }> {
  const task = await loadTask(taskId);
  if (!task) throw Object.assign(new Error('接续任务不存在'), { status: 404 });
  if (task.priority !== 'P0') return { delivered: false, task };
  const transport = oncallFromEnv();
  let chain: string[] = [];
  try {
    chain = currentOncall().chain;
  } catch (e) {
    const hops = [...(task.alert?.hops ?? []), { at: nowIso(), target: '（花名册为空）', ok: false, receipt: null, error: (e as Error).message }];
    task.alert = { deliveredAt: null, ackAt: task.alert?.ackAt ?? null, ackBy: task.alert?.ackBy ?? null, currentHop: task.alert?.currentHop ?? 0, hops };
    task.history = [...task.history, { at: nowIso(), by: '系统', action: 'P0 告警未投递', note: (e as Error).message }];
    const win = computeWindow('P0', new Date(task.createdAt), calendarFromEnv(), false);
    task.windowText = win.text;
    await persistAlert(task);
    return { delivered: false, task: (await loadTask(taskId))! };
  }
  const hop = task.alert?.currentHop ?? 0;
  const target = chain[Math.min(hop, chain.length - 1)];
  const hops = [...(task.alert?.hops ?? [])];
  if (!transport) {
    hops.push({ at: nowIso(), target, ok: false, receipt: null, error: '告警通道未配置（ONCALL_MODE=off）' });
    task.alert = { deliveredAt: null, ackAt: task.alert?.ackAt ?? null, ackBy: task.alert?.ackBy ?? null, currentHop: hop, hops };
    task.history = [...task.history, { at: nowIso(), by: '系统', action: 'P0 告警未投递', note: '通道关闭，不得对访客声称已通知专人' }];
    const win = computeWindow('P0', new Date(task.createdAt), calendarFromEnv(), false);
    task.windowText = win.text;
    await persistAlert(task);
    return { delivered: false, task };
  }
  const sent = await transport.send(target, composeText(task, hop, chain.length));
  hops.push({ at: nowIso(), target, ok: sent.ok, receipt: sent.receipt, error: sent.error });
  const delivered = sent.ok;
  task.alert = {
    deliveredAt: delivered ? nowIso() : task.alert?.deliveredAt ?? null,
    ackAt: task.alert?.ackAt ?? null,
    ackBy: task.alert?.ackBy ?? null,
    currentHop: hop,
    hops,
  };
  task.history = [...task.history, { at: nowIso(), by: '系统', action: delivered ? `P0 告警已投递 ${target}` : `P0 告警投递失败 ${target}`, note: sent.receipt ?? sent.error ?? '' }];
  const win = computeWindow('P0', new Date(task.createdAt), calendarFromEnv(), !!task.alert.deliveredAt);
  task.windowText = win.text;
  await persistAlert(task);
  return { delivered, task: (await loadTask(taskId))! };
}

export async function escalateIfUnacked(taskId: string): Promise<{ sent: boolean; reason?: string; task: HandoffTask }> {
  const task = await loadTask(taskId);
  if (!task) throw Object.assign(new Error('接续任务不存在'), { status: 404 });
  if (task.alert?.ackAt) return { sent: false, reason: '已确认（acked）', task };
  if (task.status !== 'pending') return { sent: false, reason: `任务状态 ${task.status}`, task };
  let chain: string[] = [];
  try {
    chain = currentOncall().chain;
  } catch (e) {
    return { sent: false, reason: (e as Error).message, task };
  }
  const nextHop = (task.alert?.currentHop ?? 0) + 1;
  if (nextHop >= chain.length) {
    task.history = [...task.history, { at: nowIso(), by: '系统', action: 'P0 升级链已走完仍未确认', note: '不得静默；继续按同一名单循环需人工介入' }];
    await persistAlert(task);
    return { sent: false, reason: '升级链已尽', task };
  }
  task.alert = { ...(task.alert ?? { deliveredAt: null, ackAt: null }), currentHop: nextHop, hops: task.alert?.hops ?? [] };
  await persistAlert(task);
  const r = await raiseP0Alert(taskId);
  return { sent: true, task: r.task };
}

export async function ackAlert(taskId: string, actor: string): Promise<HandoffTask | null> {
  const task = await loadTask(taskId);
  if (!task) return null;
  task.alert = { ...(task.alert ?? { deliveredAt: null, ackAt: null, hops: [] }), ackAt: nowIso(), ackBy: actor };
  task.history = [...task.history, { at: nowIso(), by: actor, action: '确认 P0 告警', note: '开始值守，不自动降级' }];
  await persistAlert(task);
  return loadTask(taskId);
}

export async function pendingP0Unacked(): Promise<HandoffTask[]> {
  const rows = await db().all("SELECT * FROM handoff_tasks WHERE priority='P0' AND status='pending'");
  return rows.map(rowToTask).filter((t) => !t.alert?.ackAt);
}

/** 执行链 / 坐席转接后调用：投递、有回执才改访客气泡、入队 15 分钟守望 */
export async function afterP0Handoff(taskId: string, opts: { visitorMessageId?: string | null } = {}) {
  const r = await raiseP0Alert(taskId);
  if (r.delivered && opts.visitorMessageId) {
    const row = await db().get<{ text: string }>('SELECT text FROM messages WHERE id=?', opts.visitorMessageId);
    if (row?.text.includes(visitorP0Sentence(false))) {
      await db().run('UPDATE messages SET text=? WHERE id=?', row.text.replace(visitorP0Sentence(false), visitorP0Sentence(true)), opts.visitorMessageId);
    }
  }
  const { enqueueOncallWatch } = await import('./jobs.ts');
  await enqueueOncallWatch(taskId, r.delivered ? 900 : 60);
  return r;
}

export async function oncallStatus() {
  const mode = (process.env.ONCALL_MODE ?? 'off').toLowerCase();
  let roster: string[] = [];
  let duty: string | null = null;
  try {
    roster = rosterFromEnv();
    duty = roster.length ? currentOncall().name : null;
  } catch {
    duty = null;
  }
  const pending = await pendingP0Unacked();
  return { mode, configured: !!oncallFromEnv() && roster.length > 0, duty, roster, pending: pending.map((t) => ({ id: t.id, conversationId: t.conversationId, deliveredAt: t.alert?.deliveredAt ?? null, hop: t.alert?.currentHop ?? 0, dueAt: t.dueAt })) };
}
