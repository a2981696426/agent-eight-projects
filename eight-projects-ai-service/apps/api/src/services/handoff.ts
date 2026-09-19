import type { HandoffProgress, HandoffTask, HistoryEntry, Priority } from '@eight/shared';
import { J, nowIso, openDb, uid } from '../db.ts';

/**
 * 人工接续任务（CS-008E/G/I）：
 * - 工作日历 + 优先级档位 → 预计人工响应时窗（只表示预计开始接续，不是完成承诺）
 * - 同一会话同一时刻只有一个活动任务；重复触发追加进度、优先级只升不降、沿用最早创建时间（CS-008F）
 * - 认领 = 接管会话（单一响应者）
 * 时间计算使用服务器本地时区，生产容器需设置 TZ=Asia/Shanghai。
 */

export interface WorkCalendar {
  /** 每日开始/结束（分钟，本地时间） */
  startMin: number;
  endMin: number;
  /** 工作日：0=周日 … 6=周六 */
  days: number[];
  /** 假日 YYYY-MM-DD（本地日期） */
  holidays: Set<string>;
}

const parseHm = (s: string, fallback: number) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : fallback;
};

export function calendarFromEnv(): WorkCalendar {
  const [start = '09:00', end = '18:00'] = (process.env.WORK_HOURS ?? '09:00-18:00').split('-');
  const days = (process.env.WORK_DAYS ?? '1,2,3,4,5').split(',').map((d) => Number(d.trim())).filter((d) => d >= 0 && d <= 6);
  const holidays = new Set((process.env.HOLIDAYS ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  return { startMin: parseHm(start, 9 * 60), endMin: parseHm(end, 18 * 60), days: days.length ? days : [1, 2, 3, 4, 5], holidays };
}

const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const minutesOfDay = (d: Date) => d.getHours() * 60 + d.getMinutes();
const isWorkDay = (d: Date, cal: WorkCalendar) => cal.days.includes(d.getDay()) && !cal.holidays.has(localDate(d));
const atMinutes = (d: Date, min: number) => {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  x.setMinutes(min);
  return x;
};

export function isWorkTime(d: Date, cal: WorkCalendar): boolean {
  const m = minutesOfDay(d);
  return isWorkDay(d, cal) && m >= cal.startMin && m < cal.endMin;
}

/** d 在工作时段内则原样返回；否则返回下一个工作时段的开始 */
export function nextWorkStart(d: Date, cal: WorkCalendar): Date {
  if (isWorkTime(d, cal)) return new Date(d);
  let cur = new Date(d);
  // 当天还未开始且是工作日 → 当天开始
  if (isWorkDay(cur, cal) && minutesOfDay(cur) < cal.startMin) return atMinutes(cur, cal.startMin);
  // 否则从次日起找第一个工作日
  for (let i = 0; i < 366; i++) {
    cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1, 0, 0, 0, 0);
    if (isWorkDay(cur, cal)) return atMinutes(cur, cal.startMin);
  }
  throw new Error('工作日历无有效工作日');
}

/** 按工作时段累加工时，跨日跳到下一工作日开始 */
export function addWorkHours(d: Date, hours: number, cal: WorkCalendar): Date {
  let remaining = Math.round(hours * 60);
  let cur = nextWorkStart(d, cal);
  while (remaining > 0) {
    const leftToday = cal.endMin - minutesOfDay(cur);
    if (remaining <= leftToday) {
      cur = new Date(cur.getTime() + remaining * 60_000);
      remaining = 0;
    } else {
      remaining -= leftToday;
      cur = nextWorkStart(new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1, 0, 0, 0, 0), cal);
    }
  }
  return cur;
}

/** 响应时限档位（CS-008I）：P0 15 自然分钟；P1 2 工作小时；P2 1 个工作日（按一天工时折算） */
export function computeWindow(priority: Priority, now: Date, cal: WorkCalendar, alertDelivered = false): { dueAt: string; text: string } {
  if (priority === 'P0') {
    return { dueAt: new Date(now.getTime() + 15 * 60_000).toISOString(), text: alertDelivered ? '已优先通知专人处理，专人会尽快联系您' : '已升级处理，专人会尽快联系您' };
  }
  if (priority === 'P1') {
    const due = addWorkHours(now, 2, cal);
    return { dueAt: due.toISOString(), text: isWorkTime(now, cal) ? '预计 2 个工作小时内开始接续' : '人工上线后优先处理，预计 2 个工作小时内开始接续' };
  }
  const dayHours = (cal.endMin - cal.startMin) / 60;
  return { dueAt: addWorkHours(now, dayHours, cal).toISOString(), text: '预计 1 个工作日内开始处理' };
}

export const windowSentence = (p: Priority, now = new Date(), alertDelivered = false) => computeWindow(p, now, calendarFromEnv(), alertDelivered).text;

/* ───────────── 任务生命周期 ───────────── */
const db = () => openDb();
const PRIORITY_RANK: Record<Priority, number> = { P0: 0, P1: 1, P2: 2 };
const higher = (a: Priority, b: Priority): Priority => (PRIORITY_RANK[a] <= PRIORITY_RANK[b] ? a : b);

export function rowToTask(r: Record<string, unknown>): HandoffTask {
  return {
    id: String(r.id),
    conversationId: String(r.conversation_id),
    caseId: (r.case_id as string) ?? null,
    channel: String(r.channel ?? 'web'),
    priority: r.priority as Priority,
    status: r.status as HandoffTask['status'],
    reason: String(r.reason ?? ''),
    progress: J.parse<HandoffProgress>(r.progress, { doneStages: [], evidence: [], missing: [], candidate: null, failure: null, nextAction: '' }),
    traceId: (r.trace_id as string) ?? null,
    windowText: String(r.window_text ?? ''),
    dueAt: String(r.due_at),
    createdAt: String(r.created_at),
    claimedBy: (r.claimed_by as string) ?? null,
    claimedAt: (r.claimed_at as string) ?? null,
    doneAt: (r.done_at as string) ?? null,
    alert: J.parse(r.alert, null),
    history: J.parse<HistoryEntry[]>(r.history, []),
  };
}

export async function loadTask(id: string): Promise<HandoffTask | null> {
  const r = await db().get('SELECT * FROM handoff_tasks WHERE id=?', id);
  return r ? rowToTask(r) : null;
}

export async function activeTask(conversationId: string): Promise<HandoffTask | null> {
  const r = await db().get("SELECT * FROM handoff_tasks WHERE conversation_id=? AND status IN ('pending','claimed') ORDER BY created_at ASC LIMIT 1", conversationId);
  return r ? rowToTask(r) : null;
}

export interface EnsureTaskInput {
  conversationId: string;
  channel: string;
  priority: Priority;
  reason: string;
  progress: HandoffProgress;
  traceId: string | null;
}

/** 创建或追加人工接续任务：同会话只保留一个活动任务 */
export async function ensureHandoffTask(input: EnsureTaskInput): Promise<{ task: HandoffTask; created: boolean }> {
  const now = nowIso();
  const existing = await activeTask(input.conversationId);
  if (existing) {
    const priority = higher(existing.priority, input.priority);
    const bumped = priority !== existing.priority;
    // 优先级提升时按新档位重算时窗，但不重置等待起点（created_at 不变）
    const win = bumped ? computeWindow(priority, new Date(existing.createdAt), calendarFromEnv()) : { dueAt: existing.dueAt, text: existing.windowText };
    const history: HistoryEntry[] = [...existing.history, { at: now, by: '执行链', action: bumped ? `再次触发转人工，优先级 ${existing.priority} → ${priority}` : '再次触发转人工，追加进度', note: input.reason }];
    await db().run('UPDATE handoff_tasks SET priority=?, reason=?, progress=?, trace_id=?, window_text=?, due_at=?, history=? WHERE id=?', priority, input.reason, J.str(input.progress), input.traceId, win.text, win.dueAt, J.str(history), existing.id);
    return { task: (await loadTask(existing.id))!, created: false };
  }
  const id = uid('HT-');
  const win = computeWindow(input.priority, new Date(now), calendarFromEnv());
  const history: HistoryEntry[] = [{ at: now, by: '执行链', action: '创建人工接续任务', note: input.reason }];
  await db().run(
    'INSERT INTO handoff_tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    id, input.conversationId, null, input.channel, input.priority, 'pending', input.reason, J.str(input.progress), input.traceId, win.text, win.dueAt, now, null, null, null, null, J.str(history),
  );
  return { task: (await loadTask(id))!, created: true };
}

/** 认领 = 接管会话：单一响应者约束 */
export async function claimTask(id: string, actor: string): Promise<HandoffTask> {
  const t = await loadTask(id);
  if (!t) throw Object.assign(new Error('接续任务不存在'), { status: 404 });
  if (t.status !== 'pending') throw Object.assign(new Error(`任务当前状态 ${t.status}，不能认领`), { status: 409 });
  const now = nowIso();
  const history: HistoryEntry[] = [...t.history, { at: now, by: actor, action: '认领并接管会话' }];
  await db().run("UPDATE handoff_tasks SET status='claimed', claimed_by=?, claimed_at=?, history=? WHERE id=?", actor, now, J.str(history), id);
  await db().run("UPDATE conversations SET controller='human', status='open', assignee=? WHERE id=?", actor, t.conversationId);
  return (await loadTask(id))!;
}

export async function finishTask(id: string, actor: string, note: string): Promise<HandoffTask> {
  const t = await loadTask(id);
  if (!t) throw Object.assign(new Error('接续任务不存在'), { status: 404 });
  if (t.status === 'done' || t.status === 'cancelled') return t;
  const now = nowIso();
  const history: HistoryEntry[] = [...t.history, { at: now, by: actor, action: '完成接续', note: note || undefined }];
  await db().run("UPDATE handoff_tasks SET status='done', done_at=?, history=? WHERE id=?", now, J.str(history), id);
  return (await loadTask(id))!;
}

/** 会话结束/转回机器人等场景：取消该会话的活动任务 */
export async function cancelActiveTasks(conversationId: string, actor: string, note: string): Promise<number> {
  const rows = await db().all<{ id: string; history: string }>("SELECT id, history FROM handoff_tasks WHERE conversation_id=? AND status IN ('pending','claimed')", conversationId);
  const now = nowIso();
  for (const r of rows) {
    const history = [...J.parse<HistoryEntry[]>(r.history, []), { at: now, by: actor, action: '取消接续任务', note }];
    await db().run("UPDATE handoff_tasks SET status='cancelled', done_at=?, history=? WHERE id=?", now, J.str(history), r.id);
  }
  return rows.length;
}

/** 认领活动任务（若存在）——坐席直接在工作台接管会话时调用 */
export async function claimActiveTask(conversationId: string, actor: string): Promise<HandoffTask | null> {
  const t = await activeTask(conversationId);
  if (!t || t.status !== 'pending') return t;
  return claimTask(t.id, actor);
}

/** 追加任务历史（如 DMS 关联、拆子案件） */
export async function appendTaskHistory(id: string, entry: HistoryEntry, patch: { caseId?: string | null } = {}) {
  const t = await loadTask(id);
  if (!t) return null;
  const history = [...t.history, entry];
  await db().run('UPDATE handoff_tasks SET history=?, case_id=COALESCE(?, case_id) WHERE id=?', J.str(history), patch.caseId ?? null, id);
  return loadTask(id);
}
