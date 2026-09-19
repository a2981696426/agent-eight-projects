import { createHash } from 'node:crypto';
import type { Message, Trace } from '@eight/shared';
import { containsMedicalAdvice } from '@eight/agent-core';
import { J, openDb } from '../db.ts';
import { parseCsv } from '../services/knowledge-import.ts';
import { embeddingProvider, knowledgeIndex, loadAgent, runStandalone } from '../services/chain.ts';
import { activeWhitelist } from '../services/whitelist.ts';
import { calendarFromEnv, isWorkTime } from '../services/handoff.ts';
import { scrubForEmbedding } from '../services/embeddings.ts';
import { env } from '../env.ts';

/**
 * L1 历史分层回放（CS-009B 第 1 级；口径见 docs/eval/L0-MEASUREMENT-CONTRACT.md）。
 * 把云商导出的历史会话按访客轮次逐轮送入执行链：每一轮只看到**决策时点之前的原始对话**（访客 + 当时的机器人/坐席），
 * 不把本系统生成的回复混入上下文；输出逐轮记录、规则护栏扫描、两阶段盲审表与分层报告。
 * 它只建立"固定案例上的建议质量 / 护栏覆盖"基线，不测量人工节时或真实自主解决（L0 §7）。
 */
export interface ReplayTurn {
  at?: string;
  role: 'visitor' | 'bot' | 'agent' | 'system';
  text: string;
}
export interface ReplayConversation {
  id: string;
  channel: string;
  startedAt?: string;
  turns: ReplayTurn[];
  meta: { product?: string; category?: string; handoff: boolean; satisfaction: number | null; tags: string[] };
}

/* ───────────── 输入解析 ───────────── */
const ROLE_MAP: Record<string, ReplayTurn['role']> = {
  访客: 'visitor', 用户: 'visitor', 客户: 'visitor', visitor: 'visitor', user: 'visitor', customer: 'visitor', in: 'visitor', 接收: 'visitor',
  机器人: 'bot', 云商机器人: 'bot', bot: 'bot', robot: 'bot', ai: 'bot',
  客服: 'agent', 坐席: 'agent', 人工: 'agent', agent: 'agent', staff: 'agent', out: 'agent', 发送: 'agent',
  系统: 'system', system: 'system',
};
const COL: Record<string, string> = {
  会话id: 'session', 会话编号: 'session', 会话: 'session', session_id: 'session', sessionid: 'session', conversation_id: 'session', conversationid: 'session', 会话ID: 'session',
  时间: 'at', 消息时间: 'at', 发送时间: 'at', time: 'at', at: 'at', timestamp: 'at', created_at: 'at',
  发送方: 'role', 消息方向: 'role', 角色: 'role', 方向: 'role', role: 'role', sender: 'role', direction: 'role', from: 'role',
  内容: 'text', 消息内容: 'text', 消息: 'text', text: 'text', content: 'text', message: 'text',
  渠道: 'channel', 来源渠道: 'channel', 来源: 'channel', channel: 'channel', source: 'channel',
  分类: 'category', 问题分类: 'category', category: 'category',
  产品: 'product', 商品: 'product', product: 'product',
  满意度: 'satisfaction', 评价: 'satisfaction', satisfaction: 'satisfaction',
  标签: 'tags', tags: 'tags',
};
const CHANNEL_MAP: Record<string, string> = { 官网: 'web', 网页: 'web', h5: 'web', web: 'web', 微信: 'wechat', 公众号: 'wechat', 小程序: 'wechat', wechat: 'wechat', app: 'app', 'app内': 'app', 应用: 'app' };
const normChannel = (v: string) => CHANNEL_MAP[v.trim().toLowerCase()] ?? CHANNEL_MAP[v.trim()] ?? (v.trim() || 'web');

/** 长表 CSV（每行一条消息；中文/英文表头自动映射）→ 会话列表 */
export function parseReplayCsv(csv: string): ReplayConversation[] {
  const rows = parseCsv(csv);
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => COL[h.trim().toLowerCase()] ?? COL[h.trim()] ?? h.trim());
  const idx = (k: string) => headers.indexOf(k);
  const iS = idx('session');
  const iT = idx('text');
  const iR = idx('role');
  if (iS < 0 || iT < 0 || iR < 0) throw Object.assign(new Error('CSV 至少需要 会话ID / 发送方 / 内容 三列'), { status: 400 });
  const iAt = idx('at');
  const iCh = idx('channel');
  const iCat = idx('category');
  const iProd = idx('product');
  const iSat = idx('satisfaction');
  const iTags = idx('tags');
  const map = new Map<string, ReplayConversation>();
  for (const r of rows.slice(1)) {
    const sid = (r[iS] ?? '').trim();
    const text = (r[iT] ?? '').trim();
    if (!sid || !text) continue;
    const roleRaw = (r[iR] ?? '').trim();
    const role = ROLE_MAP[roleRaw.toLowerCase()] ?? ROLE_MAP[roleRaw] ?? (/客服|坐席|人工/.test(roleRaw) ? 'agent' : /机器|bot/i.test(roleRaw) ? 'bot' : 'visitor');
    let c = map.get(sid);
    if (!c) {
      c = { id: sid, channel: iCh >= 0 ? normChannel(r[iCh] ?? '') : 'web', turns: [], meta: { handoff: false, satisfaction: null, tags: [] } };
      map.set(sid, c);
    }
    if (iCat >= 0 && r[iCat]) c.meta.category = r[iCat].trim();
    if (iProd >= 0 && r[iProd]) c.meta.product = r[iProd].trim();
    if (iSat >= 0 && r[iSat] && !Number.isNaN(Number(r[iSat]))) c.meta.satisfaction = Number(r[iSat]);
    if (iTags >= 0 && r[iTags]) c.meta.tags = [...new Set([...c.meta.tags, ...r[iTags].split(/[|,;，；\s]+/).filter(Boolean)])];
    c.turns.push({ at: iAt >= 0 ? (r[iAt] ?? '').trim() || undefined : undefined, role, text });
  }
  const out = [...map.values()];
  for (const c of out) {
    c.turns.sort((a, b) => (a.at && b.at ? (a.at < b.at ? -1 : a.at > b.at ? 1 : 0) : 0));
    c.startedAt = c.turns.find((t) => t.at)?.at;
    // 云商期是否转过人工：出现坐席消息，或系统消息含"转人工/人工客服"
    c.meta.handoff = c.turns.some((t) => t.role === 'agent') || c.turns.some((t) => t.role === 'system' && /转人工|人工客服|转接/.test(t.text));
  }
  return out;
}

export function parseReplayJson(json: string): ReplayConversation[] {
  const data = JSON.parse(json) as unknown;
  const arr = Array.isArray(data) ? data : (data as { conversations?: unknown[] })?.conversations;
  if (!Array.isArray(arr)) throw Object.assign(new Error('JSON 需为会话数组或 { conversations: [...] }'), { status: 400 });
  return arr.map((x, i) => {
    const c = x as Partial<ReplayConversation> & { messages?: ReplayTurn[] };
    const turns = (c.turns ?? c.messages ?? []).map((t) => ({ at: t.at, role: (ROLE_MAP[String(t.role).toLowerCase()] ?? 'visitor') as ReplayTurn['role'], text: String(t.text ?? '') })).filter((t) => t.text);
    return { id: String(c.id ?? `c-${i + 1}`), channel: normChannel(String(c.channel ?? 'web')), startedAt: c.startedAt ?? turns.find((t) => t.at)?.at, turns, meta: { product: c.meta?.product, category: c.meta?.category, handoff: c.meta?.handoff ?? turns.some((t) => t.role === 'agent'), satisfaction: c.meta?.satisfaction ?? null, tags: c.meta?.tags ?? [] } };
  });
}

/* ───────────── 逐轮回放 ───────────── */
export interface ReplayTurnRecord {
  caseId: string;
  turn: number;
  channel: string;
  at: string | null;
  workTime: boolean | null;
  visitorText: string;
  priorContext: string;
  originalResponder: 'bot' | 'agent' | 'none';
  originalReply: string | null;
  scenario: string;
  intent: string;
  decision: string;
  priority: string | null;
  risk: string;
  flags: string[];
  whitelistVersion: string | null;
  proposedAction: string;
  replyKind: string;
  replyText: string;
  candidate: string;
  retrievalConfidence: number;
  evidenceCompleteness: number;
  evidenceSources: string[];
  degraded: boolean;
  durationMs: number;
  llmCalls: number;
  guard: { medicalAdvice: boolean; commitment: boolean; unsupportedAmount: boolean; invalidCitation: boolean };
  reconstructable: boolean;
  traceId: string;
}

const scrub = (s: string) => scrubForEmbedding(s);

export async function replayConversation(conv: ReplayConversation, opts: { limitTurns?: number } = {}): Promise<ReplayTurnRecord[]> {
  const records: ReplayTurnRecord[] = [];
  const messages: Message[] = [];
  let history: { slots: Record<string, string>; scenario: string | null } = { slots: {}, scenario: null };
  let turnNo = 0;
  const convId = `replay-${conv.id}`;
  for (let i = 0; i < conv.turns.length; i++) {
    const t = conv.turns[i];
    if (t.role !== 'visitor') {
      messages.push({ id: `${convId}-${i}`, conversationId: convId, role: t.role === 'system' ? 'system' : 'agent', text: t.text, at: t.at ?? new Date().toISOString(), traceId: null, meta: { replay: 'original', originalRole: t.role } });
      continue;
    }
    turnNo++;
    if (opts.limitTurns && turnNo > opts.limitTurns) break;
    const at = t.at ? new Date(t.at.replace(' ', 'T')) : null;
    const validAt = at && !Number.isNaN(at.getTime()) ? at : null;
    const trace: Trace = await runStandalone(t.text, { channel: conv.channel, messages: [...messages], history, conversationId: convId, persist: false, at: validAt ?? undefined });
    // 原始应答：这条访客消息之后、下一条访客消息之前的第一条非访客消息
    const next = conv.turns.slice(i + 1).find((x) => x.role !== 'visitor' && x.role !== 'system');
    const nextVisitorIdx = conv.turns.slice(i + 1).findIndex((x) => x.role === 'visitor');
    const nextIdx = next ? conv.turns.indexOf(next, i + 1) : -1;
    const originalReply = next && (nextVisitorIdx < 0 || nextIdx - (i + 1) < nextVisitorIdx) ? next : null;
    const risk = trace.risk;
    const reply = trace.reply;
    const evidence = trace.evidence ?? [];
    const rec: ReplayTurnRecord = {
      caseId: conv.id,
      turn: turnNo,
      channel: conv.channel,
      at: validAt ? validAt.toISOString() : null,
      workTime: validAt ? isWorkTime(validAt, calendarFromEnv()) : null,
      visitorText: scrub(t.text),
      priorContext: messages.slice(-6).map((m) => `${m.role === 'user' ? '访客' : (m.meta as { originalRole?: string })?.originalRole === 'bot' ? '机器人' : '客服'}：${scrub(m.text)}`).join('\n'),
      originalResponder: originalReply ? (originalReply.role as 'bot' | 'agent') : 'none',
      originalReply: originalReply ? scrub(originalReply.text) : null,
      scenario: trace.scenario ?? 'general',
      intent: trace.intent ?? '',
      decision: trace.autonomy?.decision ?? 'escalate',
      priority: trace.autonomy?.priority ?? null,
      risk: risk?.level ?? 'L3',
      flags: risk?.flags ?? [],
      whitelistVersion: trace.autonomy?.whitelistVersion ?? null,
      proposedAction: trace.reasoning?.proposedAction.type ?? 'unknown',
      replyKind: reply?.kind ?? 'none',
      replyText: reply?.text ?? '',
      candidate: reply?.candidate ?? '',
      retrievalConfidence: risk?.signals.retrievalConfidence ?? 0,
      evidenceCompleteness: risk?.signals.evidenceCompleteness ?? 0,
      evidenceSources: [...new Set(evidence.filter((e) => e.ok).map((e) => String((e.data as { source?: string })?.source ?? 'local')))],
      degraded: !!trace.degraded,
      durationMs: trace.totalDurationMs,
      llmCalls: trace.usage.calls,
      guard: {
        medicalAdvice: containsMedicalAdvice(reply?.text ?? '').advice || containsMedicalAdvice(reply?.candidate ?? '').advice,
        commitment: (risk?.flags ?? []).includes('commitment_language'),
        unsupportedAmount: (risk?.flags ?? []).includes('unsupported_amount'),
        invalidCitation: (risk?.flags ?? []).includes('invalid_citation'),
      },
      // 可重建：需要订单证据的场景拿到了订单号（或场景不依赖业务证据）
      reconstructable: !['logistics', 'invoice', 'refund_price_diff'].includes(trace.scenario ?? '') || trace.slots.some((s) => s.key === 'orderId' && !!s.value),
      traceId: trace.id,
    };
    records.push(rec);
    // 访客消息进入后续上下文；槽位沿用（订单号等）
    messages.push({ id: `${convId}-${i}`, conversationId: convId, role: 'user', text: t.text, at: t.at ?? new Date().toISOString(), traceId: trace.id, meta: null });
    history = { slots: Object.fromEntries(trace.slots.filter((s) => s.value && s.source !== 'missing').map((s) => [s.key, s.value!])), scenario: trace.scenario };
  }
  return records;
}

/* ───────────── 人工校验标签（两阶段盲审第二阶段产出） ───────────── */
export interface ReplayLabel {
  caseId: string;
  turn: number;
  factsOk: '是' | '否' | '不可判定';
  categoryOk: '是' | '否' | '不可判定';
  eligibilityOk: '是' | '否' | '不可判定';
  nextStepOk: '是' | '否' | '不可判定';
  postHocEvidence: boolean;
  guardEvent: string;
  reviewer: string;
}
const tri = (v: string): '是' | '否' | '不可判定' => (/^(是|y|yes|true|1|ok)$/i.test(v.trim()) ? '是' : /^(否|n|no|false|0)$/i.test(v.trim()) ? '否' : '不可判定');
export function parseLabelsCsv(csv: string): ReplayLabel[] {
  const rows = parseCsv(csv);
  if (rows.length < 2) return [];
  const h = rows[0].map((x) => x.trim().toLowerCase());
  const col = (names: string[]) => h.findIndex((x) => names.includes(x));
  const iC = col(['case_id', 'caseid', '案例id', '会话id']);
  const iT = col(['turn', '轮次']);
  const iF = col(['facts_ok', '关键事实']);
  const iCat = col(['category_ok', '问题分类']);
  const iE = col(['eligibility_ok', '资格建议']);
  const iN = col(['next_step_ok', '下一步']);
  const iP = col(['post_hoc_evidence', '后获证据']);
  const iG = col(['guard_event', '护栏事件']);
  const iR = col(['reviewer', '复核人']);
  if (iC < 0 || iT < 0) throw Object.assign(new Error('标签 CSV 需要 case_id / turn 列'), { status: 400 });
  return rows.slice(1).filter((r) => r[iC]?.trim()).map((r) => ({
    caseId: r[iC].trim(),
    turn: Number(r[iT]),
    factsOk: iF >= 0 ? tri(r[iF] ?? '') : '不可判定',
    categoryOk: iCat >= 0 ? tri(r[iCat] ?? '') : '不可判定',
    eligibilityOk: iE >= 0 ? tri(r[iE] ?? '') : '不可判定',
    nextStepOk: iN >= 0 ? tri(r[iN] ?? '') : '不可判定',
    postHocEvidence: iP >= 0 ? /^(是|y|yes|true|1)$/i.test((r[iP] ?? '').trim()) : false,
    guardEvent: iG >= 0 ? (r[iG] ?? '').trim() : '',
    reviewer: iR >= 0 ? (r[iR] ?? '').trim() : '',
  }));
}

/* ───────────── 盲审表 ───────────── */
const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (headers: string[], rows: unknown[][]) => [headers, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');

/** 第一阶段：只含决策时点信息 + 待填的应有分类/证据状态/处理路径 */
export function blindStage1Csv(records: ReplayTurnRecord[]) {
  return toCsv(
    ['case_id', 'turn', 'channel', 'at', 'prior_context', 'visitor_text', 'known_facts', 'should_category', 'evidence_status', 'should_path', 'reviewer'],
    records.map((r) => [r.caseId, r.turn, r.channel, r.at ?? '', r.priorContext, r.visitorText, r.evidenceSources.length ? `已取得业务证据（${r.evidenceSources.join('/')}）` : r.reconstructable ? '不依赖业务证据' : '缺订单号，无法取证', '', '', '', '']),
  );
}
/** 第二阶段：解盲后评 Agent 差异；四字段 + 后获证据 + 护栏事件 */
export function blindStage2Csv(records: ReplayTurnRecord[]) {
  return toCsv(
    ['case_id', 'turn', 'agent_scenario', 'agent_decision', 'agent_risk', 'agent_reply', 'agent_candidate', 'original_responder', 'original_reply', 'facts_ok', 'category_ok', 'eligibility_ok', 'next_step_ok', 'post_hoc_evidence', 'guard_event', 'reviewer'],
    records.map((r) => [r.caseId, r.turn, r.scenario, r.decision, r.risk, r.replyText, r.candidate, r.originalResponder, r.originalReply ?? '', '', '', '', '', '', '', '']),
  );
}

/* ───────────── 报告 ───────────── */
export interface ReplayReport {
  generatedAt: string;
  versions: Record<string, string | number | null>;
  input: { conversations: number; visitorTurns: number; withTimestamps: number; withOrderId: number; reconstructable: number; reconstructRate: number; originalHandoffConversations: number };
  decisions: Record<string, number>;
  byChannel: Record<string, Record<string, number>>;
  byScenario: Record<string, Record<string, number>>;
  byRisk: Record<string, number>;
  byWorkTime: { work: Record<string, number>; off: Record<string, number>; unknown: Record<string, number> };
  guards: { medicalAdvice: number; commitment: number; unsupportedAmount: number; invalidCitation: number; degraded: number };
  comparison: { originalBotAnswered: number; ourAutoOnThose: number; originalHumanAnswered: number; ourNonAutoOnThose: number };
  latency: { avgMs: number; p95Ms: number; avgLlmCalls: number };
  usability: { status: '可判定' | '不可判定'; labeled: number; denominator: number; numerator: number; rate: number | null; postHoc: number; undecidable: number; bySlice: Record<string, { n: number; ok: number }> ; guardEvents: Record<string, number> };
}

const inc = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);
const inc2 = (m: Record<string, Record<string, number>>, a: string, b: string) => inc((m[a] ??= {}), b);

export async function knowledgeSnapshotHash(): Promise<string> {
  const rows = await openDb().all<{ id: string; version: number }>("SELECT id, version FROM knowledge_docs WHERE status='published' ORDER BY id");
  return createHash('sha1').update(rows.map((r) => `${r.id}@${r.version}`).join('|')).digest('hex').slice(0, 12);
}

export async function frozenVersions(): Promise<Record<string, string | number | null>> {
  const agent = await loadAgent();
  const [owned, platform] = await Promise.all([activeWhitelist('owned'), activeWhitelist('platform')]);
  return {
    agent: `${agent.id}@v${agent.version}`,
    whitelistOwned: owned ? `owned@${owned.version}` : null,
    whitelistPlatform: platform ? `platform@${platform.version}` : null,
    knowledgeSnapshot: await knowledgeSnapshotHash(),
    retrievalMode: knowledgeIndex().mode,
    embedding: embeddingProvider ? `${embeddingProvider.id}/${embeddingProvider.model}` : 'off',
    llm: env.llmMock ? 'MOCK（结果不代表真实模型）' : env.llm.modelFast === env.llm.modelReasoning ? env.llm.modelFast : env.llm.modelFast + ' / ' + env.llm.modelReasoning,
    workCalendar: `${process.env.WORK_HOURS ?? '09:00-18:00'} d${process.env.WORK_DAYS ?? '1-5'}`,
    codeVersion: process.env.APP_VERSION ?? process.env.GIT_COMMIT ?? 'dev',
  };
}

export function buildReport(records: ReplayTurnRecord[], convs: ReplayConversation[], labels: ReplayLabel[], versions: Record<string, string | number | null>): ReplayReport {
  const decisions: Record<string, number> = {};
  const byChannel: Record<string, Record<string, number>> = {};
  const byScenario: Record<string, Record<string, number>> = {};
  const byRisk: Record<string, number> = {};
  const byWorkTime = { work: {} as Record<string, number>, off: {} as Record<string, number>, unknown: {} as Record<string, number> };
  const guards = { medicalAdvice: 0, commitment: 0, unsupportedAmount: 0, invalidCitation: 0, degraded: 0 };
  const comparison = { originalBotAnswered: 0, ourAutoOnThose: 0, originalHumanAnswered: 0, ourNonAutoOnThose: 0 };
  const durations: number[] = [];
  let llmCalls = 0;
  for (const r of records) {
    inc(decisions, r.decision);
    inc2(byChannel, r.channel, r.decision);
    inc2(byScenario, r.scenario, r.decision);
    inc(byRisk, r.risk);
    inc(r.workTime === null ? byWorkTime.unknown : r.workTime ? byWorkTime.work : byWorkTime.off, r.decision);
    if (r.guard.medicalAdvice) guards.medicalAdvice++;
    if (r.guard.commitment) guards.commitment++;
    if (r.guard.unsupportedAmount) guards.unsupportedAmount++;
    if (r.guard.invalidCitation) guards.invalidCitation++;
    if (r.degraded) guards.degraded++;
    if (r.originalResponder === 'bot') {
      comparison.originalBotAnswered++;
      if (r.decision === 'auto_reply') comparison.ourAutoOnThose++;
    } else if (r.originalResponder === 'agent') {
      comparison.originalHumanAnswered++;
      if (r.decision !== 'auto_reply') comparison.ourNonAutoOnThose++;
    }
    durations.push(r.durationMs);
    llmCalls += r.llmCalls;
  }
  const sorted = [...durations].sort((a, b) => a - b);
  const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0;

  // 建议可用率（L0 §2.1）：分母 = 已形成建议（非 clarify）且四字段齐全；分子 = 四项均"是"且非后获证据
  const labelMap = new Map(labels.map((l) => [`${l.caseId}#${l.turn}`, l]));
  const usability: ReplayReport['usability'] = { status: '不可判定', labeled: 0, denominator: 0, numerator: 0, rate: null, postHoc: 0, undecidable: 0, bySlice: {}, guardEvents: {} };
  for (const r of records) {
    const l = labelMap.get(`${r.caseId}#${r.turn}`);
    if (!l) continue;
    usability.labeled++;
    if (l.guardEvent) inc(usability.guardEvents, l.guardEvent);
    if (r.proposedAction === 'clarify') continue;
    const fields = [l.factsOk, l.categoryOk, l.eligibilityOk, l.nextStepOk];
    if (fields.includes('不可判定')) {
      usability.undecidable++;
      continue;
    }
    if (l.postHocEvidence) {
      usability.postHoc++;
      continue;
    }
    usability.denominator++;
    const ok = fields.every((f) => f === '是');
    if (ok) usability.numerator++;
    for (const key of [`channel:${r.channel}`, `scenario:${r.scenario}`, `risk:${r.risk}`, `hours:${r.workTime === null ? 'unknown' : r.workTime ? 'work' : 'off'}`]) {
      const s = (usability.bySlice[key] ??= { n: 0, ok: 0 });
      s.n++;
      if (ok) s.ok++;
    }
  }
  if (usability.denominator > 0) {
    usability.status = '可判定';
    usability.rate = Number((usability.numerator / usability.denominator).toFixed(4));
  }

  const visitorTurns = records.length;
  return {
    generatedAt: new Date().toISOString(),
    versions,
    input: {
      conversations: convs.length,
      visitorTurns,
      withTimestamps: records.filter((r) => r.at).length,
      withOrderId: records.filter((r) => /\d{14,19}/.test(r.visitorText) || r.evidenceSources.length).length,
      reconstructable: records.filter((r) => r.reconstructable).length,
      reconstructRate: visitorTurns ? Number((records.filter((r) => r.reconstructable).length / visitorTurns).toFixed(4)) : 0,
      originalHandoffConversations: convs.filter((c) => c.meta.handoff).length,
    },
    decisions,
    byChannel,
    byScenario,
    byRisk,
    byWorkTime,
    guards,
    comparison,
    latency: { avgMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0, p95Ms: p95, avgLlmCalls: records.length ? Number((llmCalls / records.length).toFixed(2)) : 0 },
    usability,
  };
}

const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : '—');
const distLine = (m: Record<string, number>) => Object.entries(m).map(([k, v]) => `${k} ${v}`).join(' · ') || '—';

export function reportMarkdown(rep: ReplayReport, records: ReplayTurnRecord[], title = 'L1 历史分层回放报告'): string {
  const total = rep.input.visitorTurns;
  const lines: string[] = [];
  lines.push(`# ${title}`, '', `生成时间：${rep.generatedAt}`, '', '> 本报告只建立固定案例上的建议质量与护栏覆盖基线（CS-009B 第 1 级）；**不得**据此声称人工节时、客户复联改善或真实自主解决率（L0 §7）。', '');
  lines.push('## 版本冻结', '', '| 项 | 值 |', '|---|---|', ...Object.entries(rep.versions).map(([k, v]) => `| ${k} | ${v ?? '—'} |`), '');
  lines.push('## 输入审计', '', `| 会话 | 访客轮次 | 带时间戳 | 带订单号/取到证据 | 可重建 | 可重建率 | 云商期转人工会话 |`, '|---|---|---|---|---|---|---|', `| ${rep.input.conversations} | ${total} | ${rep.input.withTimestamps} | ${rep.input.withOrderId} | ${rep.input.reconstructable} | ${pct(rep.input.reconstructable, total)} | ${rep.input.originalHandoffConversations} |`, '');
  lines.push(rep.input.reconstructRate < 0.8 ? `> 可重建率 ${pct(rep.input.reconstructable, total)} 低于 80%：本次只能用于**发现案例**，不能作为基线（L0 §6）。` : `> 可重建率 ${pct(rep.input.reconstructable, total)} ≥ 80%，满足 L0 §6 的基线条件（阈值待签发冻结）。`, '');
  lines.push('## 自治决策分布', '', `- 总体：${distLine(rep.decisions)}`, `- 按渠道：${Object.entries(rep.byChannel).map(([c, m]) => `${c}（${distLine(m)}）`).join('；') || '—'}`, `- 按场景：${Object.entries(rep.byScenario).map(([c, m]) => `${c}（${distLine(m)}）`).join('；') || '—'}`, `- 按风险：${distLine(rep.byRisk)}`, `- 人工时段：${distLine(rep.byWorkTime.work)}；非人工时段：${distLine(rep.byWorkTime.off)}；时间未知：${distLine(rep.byWorkTime.unknown)}`, '');
  lines.push('## 护栏规则扫描（机器检出，需人工复核确认）', '', '| 医疗建议 | 越权承诺语言 | 无依据金额 | 无效引用 | 规则降级 |', '|---|---|---|---|---|', `| ${rep.guards.medicalAdvice} | ${rep.guards.commitment} | ${rep.guards.unsupportedAmount} | ${rep.guards.invalidCitation} | ${rep.guards.degraded} |`, '');
  lines.push('## 与云商期应答的描述性对照（不是因果）', '', `- 云商机器人应答的 ${rep.comparison.originalBotAnswered} 轮中，本系统自主回复 ${rep.comparison.ourAutoOnThose}（${pct(rep.comparison.ourAutoOnThose, rep.comparison.originalBotAnswered)}）`, `- 云商人工应答的 ${rep.comparison.originalHumanAnswered} 轮中，本系统同样交人工 ${rep.comparison.ourNonAutoOnThose}（${pct(rep.comparison.ourNonAutoOnThose, rep.comparison.originalHumanAnswered)}）`, '');
  lines.push('## 延迟与调用', '', `平均 ${rep.latency.avgMs} ms · p95 ${rep.latency.p95Ms} ms · 平均模型调用 ${rep.latency.avgLlmCalls} 次/轮`, '');
  lines.push('## 售后辅助建议可用率（L0 §2.1）', '');
  if (rep.usability.status === '不可判定') lines.push(`**不可判定**——已标注 ${rep.usability.labeled} 轮，形成建议且四字段齐全的 0 轮。请用 \`blind-stage1.csv\` → \`blind-stage2.csv\` 完成两阶段盲审后以 \`--labels\` 重跑。`, '');
  else {
    lines.push(`**${pct(rep.usability.numerator, rep.usability.denominator)}**（${rep.usability.numerator}/${rep.usability.denominator}；后获证据剔除 ${rep.usability.postHoc}，不可判定剔除 ${rep.usability.undecidable}，已标注 ${rep.usability.labeled}）`, '', '| 切片 | n | 可用 | 可用率 |', '|---|---|---|---|', ...Object.entries(rep.usability.bySlice).map(([k, s]) => `| ${k} | ${s.n} | ${s.ok} | ${pct(s.ok, s.n)} |`), '');
    if (Object.keys(rep.usability.guardEvents).length) lines.push(`人工标注护栏事件：${distLine(rep.usability.guardEvents)}`, '');
  }
  const flagged = records.filter((r) => r.guard.medicalAdvice || r.guard.commitment || r.guard.unsupportedAmount);
  if (flagged.length) lines.push('## 需优先复核的轮次', '', '| 案例 | 轮 | 场景 | 决策 | 命中 | 回复摘录 |', '|---|---|---|---|---|---|', ...flagged.slice(0, 30).map((r) => `| ${r.caseId} | ${r.turn} | ${r.scenario} | ${r.decision} | ${[r.guard.medicalAdvice && '医疗建议', r.guard.commitment && '承诺语言', r.guard.unsupportedAmount && '无依据金额'].filter(Boolean).join('/')} | ${r.replyText.slice(0, 60).replace(/\|/g, '/')}… |`), '');
  return lines.join('\n');
}

export const replayRecordsJson = (records: ReplayTurnRecord[]) => J.str(records);
