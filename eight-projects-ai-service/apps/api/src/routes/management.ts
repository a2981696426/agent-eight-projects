import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SCENARIO_PACKS } from '@eight/agent-core';
import type { Message, QualityResult, QualityRule, ReportResult, ReportSpec } from '@eight/shared';
import { J, nowIso, openDb, uid } from '../db.ts';
import { loadMessages, runStandalone } from '../services/chain.ts';
import { semanticQc, vocAsk, vocClassify } from '../services/aigc.ts';

const db = () => openDb();

/* ───────────── 智能质检 ───────────── */
function ruleCheck(rule: QualityRule, msgs: Message[]): { delta: number; evidence: string } | null {
  const staff = msgs.filter((m) => m.role === 'agent' || m.role === 'bot');
  const cfg = rule.config as Record<string, any>;
  switch (rule.kind) {
    case 'forbidden_word': {
      const hit = staff.find((m) => (cfg.words as string[]).some((w) => m.text.includes(w)));
      if (!hit) return null;
      const w = (cfg.words as string[]).find((x) => hit.text.includes(x))!;
      return { delta: rule.score, evidence: `「${w}」出现在：${hit.text.slice(0, 60)}` };
    }
    case 'required_word': {
      const first = staff[0];
      if (!first) return null;
      const ok = (cfg.words as string[]).some((w) => first.text.includes(w));
      return ok ? { delta: rule.score, evidence: `首句包含问候：${first.text.slice(0, 40)}` } : { delta: -Math.abs(rule.score), evidence: `首句缺少问候：${first.text.slice(0, 40)}` };
    }
    case 'response_time': {
      const firstUser = msgs.find((m) => m.role === 'user');
      const firstStaff = staff.find((m) => firstUser && m.at > firstUser.at);
      if (!firstUser || !firstStaff) return null;
      const min = (new Date(firstStaff.at).getTime() - new Date(firstUser.at).getTime()) / 60000;
      return min > Number(cfg.maxMinutes) ? { delta: rule.score, evidence: `首次响应 ${min.toFixed(1)} 分钟 > ${cfg.maxMinutes}` } : null;
    }
    case 'turns': {
      const turns = msgs.filter((m) => m.role !== 'system').length;
      return turns > Number(cfg.maxTurns) ? { delta: rule.score, evidence: `会话 ${turns} 轮 > ${cfg.maxTurns}` } : null;
    }
    default:
      return null;
  }
}

export async function managementRoutes(app: FastifyInstance) {
  app.get('/api/quality/rules', async () => (await db().all<{ doc: string }>('SELECT doc FROM quality_rules')).map((r) => J.parse<QualityRule>(r.doc, null as unknown as QualityRule)));
  app.put('/api/quality/rules/:id', async (req) => {
    const { id } = req.params as { id: string };
    const b = z.object({ name: z.string().min(1), kind: z.enum(['forbidden_word', 'required_word', 'response_time', 'turns', 'sentiment', 'semantic']), config: z.record(z.string(), z.unknown()), score: z.number(), enabled: z.boolean() }).parse(req.body);
    const rule: QualityRule = { id, ...b };
    await db().run('INSERT INTO quality_rules VALUES (?,?) ON CONFLICT (id) DO UPDATE SET doc=EXCLUDED.doc', id, J.str(rule));
    return rule;
  });
  app.post('/api/quality/run', async (req) => {
    const b = z.object({ conversationIds: z.array(z.string()).optional(), semantic: z.boolean().default(false), limit: z.number().int().min(1).max(50).default(20) }).parse(req.body ?? {});
    const rules = (await db().all<{ doc: string }>('SELECT doc FROM quality_rules')).map((r) => J.parse<QualityRule>(r.doc, null as unknown as QualityRule)).filter((r) => r.enabled);
    const ids = b.conversationIds ?? (await db().all<{ id: string }>('SELECT id FROM conversations ORDER BY last_message_at DESC LIMIT ?', b.limit)).map((r) => r.id);
    const results: QualityResult[] = [];
    for (const cid of ids) {
      const msgs = await loadMessages(cid);
      if (!msgs.some((m) => m.role === 'agent' || m.role === 'bot')) continue;
      const conv = await db().get<{ assignee: string | null; controller: string }>('SELECT assignee, controller FROM conversations WHERE id=?', cid);
      let score = 100;
      const hits: QualityResult['hits'] = [];
      for (const r of rules) {
        if (r.kind === 'semantic') continue;
        const h = ruleCheck(r, msgs);
        if (h) {
          score += h.delta;
          hits.push({ ruleId: r.id, ruleName: r.name, delta: h.delta, evidence: h.evidence });
        }
      }
      let semantic: QualityResult['semantic'] = null;
      if (b.semantic && rules.some((r) => r.kind === 'semantic')) {
        try {
          const s = await semanticQc(cid);
          const avg = (s.scores.empathy + s.scores.completeness + s.scores.accuracy + s.scores.compliance) / 4;
          score = Math.round(score * 0.6 + avg * 10 * 0.4);
          semantic = { summary: s.summary, issues: s.issues, tone: s.tone };
          hits.push({ ruleId: 'qr-semantic', ruleName: '大模型语义质检', delta: Math.round(avg * 10 - 100) , evidence: `同理心${s.scores.empathy}/完整${s.scores.completeness}/准确${s.scores.accuracy}/合规${s.scores.compliance}` });
        } catch (e) {
          hits.push({ ruleId: 'qr-semantic', ruleName: '大模型语义质检', delta: 0, evidence: `失败：${(e as Error).message}` });
        }
      }
      const res: QualityResult = { id: uid('qc-'), conversationId: cid, agent: conv?.assignee ?? (conv?.controller === 'bot' ? '机器人' : null), score: Math.max(0, Math.min(100, score)), hits, semantic, createdAt: nowIso(), reviewedBy: null, reviewNote: null };
      await db().run('INSERT INTO quality_results VALUES (?,?,?,?,?,?,?,?)', res.id, cid, res.agent, res.score, J.str(res), res.createdAt, null, null);
      results.push(res);
    }
    return { count: results.length, results };
  });
  app.get('/api/quality/results', async () => (await db().all<{ doc: string; reviewed_by: string | null; review_note: string | null }>('SELECT doc, reviewed_by, review_note FROM quality_results ORDER BY created_at DESC LIMIT 200')).map((r) => ({ ...J.parse<QualityResult>(r.doc, null as unknown as QualityResult), reviewedBy: r.reviewed_by, reviewNote: r.review_note })));
  app.patch('/api/quality/results/:id', async (req) => {
    const { id } = req.params as { id: string };
    const b = z.object({ reviewedBy: z.string().min(1), reviewNote: z.string().max(500).default(''), score: z.number().min(0).max(100).optional() }).parse(req.body);
    await db().run('UPDATE quality_results SET reviewed_by=?, review_note=?, score=COALESCE(?, score) WHERE id=?', b.reviewedBy, b.reviewNote, b.score ?? null, id);
    return { ok: true };
  });
  app.get('/api/quality/report', async () => {
    const byAgent = await db().all<{ agent: string; n: number; avg: number; reviewed: number }>(`SELECT COALESCE(agent, '未分配') agent, COUNT(*) n, ROUND(AVG(score)::numeric,1) avg, SUM(CASE WHEN reviewed_by IS NOT NULL THEN 1 ELSE 0 END) reviewed FROM quality_results GROUP BY agent ORDER BY avg DESC`);
    const all = (await db().all<{ doc: string }>('SELECT doc FROM quality_results')).map((r) => J.parse<QualityResult>(r.doc, null as unknown as QualityResult));
    const ruleHits: Record<string, { name: string; n: number; total: number }> = {};
    for (const r of all) for (const h of r.hits) {
      ruleHits[h.ruleId] ??= { name: h.ruleName, n: 0, total: 0 };
      ruleHits[h.ruleId].n++;
      ruleHits[h.ruleId].total += h.delta;
    }
    const dist = [0, 0, 0, 0, 0];
    for (const r of all) dist[Math.min(4, Math.floor(r.score / 20))]++;
    return { total: all.length, avg: all.length ? Number((all.reduce((n, r) => n + r.score, 0) / all.length).toFixed(1)) : 0, byAgent, ruleHits: Object.entries(ruleHits).map(([id, v]) => ({ id, ...v })), distribution: ['0-19', '20-39', '40-59', '60-79', '80-100'].map((k, i) => ({ range: k, n: dist[i] })), humanReviewed: all.filter((r) => r.reviewedBy).length };
  });

  /* ───────────── 自定义报表 ───────────── */
  const DIMENSIONS: Record<ReportSpec['dataset'], Record<string, string>> = {
    conversations: { channel: '渠道', scenario: '场景', status: '状态', controller: '接待方', day: '日期', assignee: '坐席' },
    tickets: { type: '类型', status: '状态', priority: '优先级', assignee: '处理人', day: '日期', source: '来源' },
    traces: { scenario: '场景', decision: '决策', risk_level: '风险等级', day: '日期', status: '执行状态' },
    quality: { agent: '坐席', day: '日期' },
  };
  const METRICS: Record<ReportSpec['dataset'], Record<string, { label: string; sql: string }>> = {
    conversations: { count: { label: '会话数', sql: 'COUNT(*)' }, satisfaction: { label: '平均满意度', sql: 'ROUND(AVG(satisfaction),2)' }, bot_ratio: { label: '机器人接待占比', sql: "ROUND(AVG(CASE WHEN controller='bot' THEN 1.0 ELSE 0 END),3)" } },
    tickets: { count: { label: '工单数', sql: 'COUNT(*)' }, resolved_ratio: { label: '解决率', sql: "ROUND(AVG(CASE WHEN status IN ('resolved','closed') THEN 1.0 ELSE 0 END),3)" } },
    traces: { count: { label: '执行次数', sql: 'COUNT(*)' }, avg_ms: { label: '平均耗时(ms)', sql: 'ROUND(AVG(duration_ms))' }, auto_ratio: { label: '自主回复率', sql: "ROUND(AVG(CASE WHEN decision='auto_reply' THEN 1.0 ELSE 0 END),3)" } },
    quality: { count: { label: '质检数', sql: 'COUNT(*)' }, avg_score: { label: '平均分', sql: 'ROUND(AVG(score)::numeric,1)' } },
  };
  const DATE_COL: Record<ReportSpec['dataset'], string> = { conversations: 'created_at', tickets: 'created_at', traces: 'created_at', quality: 'created_at' };
  const TABLE: Record<ReportSpec['dataset'], string> = { conversations: 'conversations', tickets: 'tickets', traces: 'traces', quality: 'quality_results' };

  app.get('/api/reports/options', async () => ({ datasets: Object.keys(DIMENSIONS).map((d) => ({ id: d, dimensions: Object.entries(DIMENSIONS[d as ReportSpec['dataset']]).map(([k, v]) => ({ id: k, label: v })), metrics: Object.entries(METRICS[d as ReportSpec['dataset']]).map(([k, v]) => ({ id: k, label: v.label })) })), saved: (await db().all('SELECT * FROM saved_reports ORDER BY created_at DESC')).map((r) => ({ ...r, spec: J.parse(r.spec, null) })) }));
  app.post('/api/reports/run', async (req, reply) => {
    const spec = z.object({ dataset: z.enum(['conversations', 'tickets', 'traces', 'quality']), dimension: z.string(), metric: z.string(), dateFrom: z.string().optional(), dateTo: z.string().optional() }).parse(req.body);
    const dims = DIMENSIONS[spec.dataset];
    const met = METRICS[spec.dataset][spec.metric];
    if (!dims[spec.dimension] || !met) return reply.code(400).send({ error: '维度或指标无效' });
    const dateCol = DATE_COL[spec.dataset];
    const dimSql = spec.dimension === 'day' ? `substr(${dateCol},1,10)` : `COALESCE(${spec.dimension},'（空）')`;
    const where: string[] = [];
    const params: string[] = [];
    if (spec.dateFrom) {
      where.push(`${dateCol} >= ?`);
      params.push(spec.dateFrom);
    }
    if (spec.dateTo) {
      where.push(`${dateCol} <= ?`);
      params.push(`${spec.dateTo}T23:59:59`);
    }
    // Postgres 允许按输出列别名分组；用 dim_key/metric_value 避免与保留字/函数名混淆
    const rows = await db().all<{ dim_key: string; metric_value: number; n: number }>(`SELECT ${dimSql} dim_key, ${met.sql} metric_value, COUNT(*) n FROM ${TABLE[spec.dataset]} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} GROUP BY dim_key ORDER BY metric_value DESC`, ...params);
    const result: ReportResult = { spec, columns: [dims[spec.dimension], met.label, '样本数'], rows: rows.map((r) => ({ key: String(r.dim_key), value: Number(r.metric_value ?? 0), extra: { n: r.n } })), generatedAt: nowIso() };
    return result;
  });
  app.post('/api/reports/saved', async (req) => {
    const b = z.object({ name: z.string().min(1).max(60), spec: z.record(z.string(), z.unknown()) }).parse(req.body);
    const id = uid('rp-');
    await db().run('INSERT INTO saved_reports VALUES (?,?,?,?)', id, b.name, J.str(b.spec), nowIso());
    return { id };
  });
  app.delete('/api/reports/saved/:id', async (req) => {
    await db().run('DELETE FROM saved_reports WHERE id=?', (req.params as { id: string }).id);
    return { ok: true };
  });

  /* ───────────── 数据大屏 ───────────── */
  app.get('/api/dashboard', async () => {
    const today = nowIso().slice(0, 10);
    const d = db();
    const n = async (sql: string, ...p: (string | number)[]) => (await d.get<{ n: number }>(sql, ...p))?.n ?? 0;
    const traces = await d.all<{ decision: string; n: number }>('SELECT decision, COUNT(*) n FROM traces GROUP BY decision');
    const risks = await d.all<{ risk_level: string; n: number }>('SELECT risk_level, COUNT(*) n FROM traces WHERE risk_level IS NOT NULL GROUP BY risk_level ORDER BY risk_level');
    const scenarios = await d.all<{ scenario: string; n: number }>(`SELECT COALESCE(scenario,'general') scenario, COUNT(*) n FROM traces GROUP BY scenario ORDER BY n DESC`);
    const hourly = await d.all<{ h: string; n: number }>("SELECT substr(at,12,2) h, COUNT(*) n FROM messages WHERE role='user' GROUP BY h ORDER BY h");
    const channels = await d.all<{ channel: string; n: number }>('SELECT channel, COUNT(*) n FROM conversations GROUP BY channel ORDER BY n DESC');
    const agents = await d.all<{ assignee: string; n: number; sat: number }>('SELECT assignee, COUNT(*) n, ROUND(AVG(satisfaction),2) sat FROM conversations WHERE assignee IS NOT NULL GROUP BY assignee ORDER BY n DESC');
    const totalTraces = traces.reduce((s, t) => s + t.n, 0);
    const auto = traces.find((t) => t.decision === 'auto_reply')?.n ?? 0;
    const avgMs = (await d.get<{ v: number }>('SELECT ROUND(AVG(duration_ms)) v FROM traces'))?.v ?? 0;
    const tokens = (await d.all<{ doc: string }>('SELECT doc FROM traces ORDER BY created_at DESC LIMIT 200')).reduce((s, r) => {
      const t = J.parse<{ usage?: { promptTokens: number; completionTokens: number } }>(r.doc, {});
      return s + (t.usage?.promptTokens ?? 0) + (t.usage?.completionTokens ?? 0);
    }, 0);
    return {
      generatedAt: nowIso(),
      kpis: {
        conversationsTotal: await n('SELECT COUNT(*) n FROM conversations'),
        conversationsToday: await n('SELECT COUNT(*) n FROM conversations WHERE substr(created_at,1,10)=?', today),
        waitingHuman: await n("SELECT COUNT(*) n FROM conversations WHERE status='waiting_human'"),
        openTickets: await n("SELECT COUNT(*) n FROM tickets WHERE status NOT IN ('resolved','closed')"),
        overdueTickets: await n("SELECT COUNT(*) n FROM tickets WHERE status NOT IN ('resolved','closed') AND sla_due_at < ?", nowIso()),
        autoReplyRate: totalTraces ? Number((auto / totalTraces).toFixed(3)) : 0,
        avgChainMs: avgMs,
        avgSatisfaction: (await d.get<{ v: number }>('SELECT ROUND(AVG(satisfaction),2) v FROM conversations WHERE satisfaction IS NOT NULL'))?.v ?? 0,
        qualityAvg: (await d.get<{ v: number }>('SELECT ROUND(AVG(score)::numeric,1) v FROM quality_results'))?.v ?? 0,
        tokensRecent: tokens,
        knowledgePublished: await n("SELECT COUNT(*) n FROM knowledge_docs WHERE status='published'"),
        botOnline: 1,
        agentsOnline: agents.length,
      },
      decisions: traces,
      risks,
      scenarios: scenarios.map((s) => ({ ...s, name: SCENARIO_PACKS.find((p) => p.id === s.scenario)?.name ?? s.scenario })),
      hourly,
      channels,
      agents,
      recentTraces: await d.all('SELECT id, conversation_id, created_at, scenario, intent, decision, risk_level, duration_ms FROM traces ORDER BY created_at DESC LIMIT 8'),
      queue: await d.all(`SELECT id, title, priority, last_message_at, channel FROM conversations WHERE status='waiting_human' ORDER BY CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 ELSE 2 END, last_message_at ASC LIMIT 8`),
    };
  });

  /* ───────────── 客户之声 ───────────── */
  app.post('/api/voc/analyze', async (req) => {
    const b = z.object({ limit: z.number().int().min(1).max(120).default(60) }).parse(req.body ?? {});
    const pending = await db().all<{ id: string; conversation_id: string; text: string }>("SELECT m.id, m.conversation_id, m.text FROM messages m LEFT JOIN voc_items v ON v.message_id=m.id WHERE m.role='user' AND v.id IS NULL AND length(m.text) >= 4 ORDER BY m.at DESC LIMIT ?", b.limit);
    if (!pending.length) return { analyzed: 0, total: await db().count('voc_items') };
    let analyzed = 0;
    for (let i = 0; i < pending.length; i += 20) {
      const batch = pending.slice(i, i + 20);
      const items = await vocClassify(batch.map((p) => ({ messageId: p.id, text: p.text })));
      const byId = new Map(items.map((x) => [x.messageId, x]));
      for (const p of batch) {
        const x = byId.get(p.id);
        if (!x) continue;
        await db().run('INSERT INTO voc_items VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (message_id) DO NOTHING', uid('voc-'), p.conversation_id, p.id, p.text, x.topic, x.sentiment, J.str(x.keywords), nowIso());
        analyzed++;
      }
    }
    return { analyzed, total: await db().count('voc_items') };
  });
  app.get('/api/voc/overview', async () => {
    const d = db();
    const topics = await d.all<{ topic: string; n: number; neg: number }>("SELECT topic, COUNT(*) n, SUM(CASE WHEN sentiment='negative' THEN 1 ELSE 0 END) neg FROM voc_items GROUP BY topic ORDER BY n DESC");
    const sentiment = await d.all<{ sentiment: string; n: number }>('SELECT sentiment, COUNT(*) n FROM voc_items GROUP BY sentiment');
    const kw: Record<string, number> = {};
    for (const r of await d.all<{ keywords: string }>('SELECT keywords FROM voc_items')) for (const k of J.parse<string[]>(r.keywords, [])) kw[k] = (kw[k] ?? 0) + 1;
    // day 在 Postgres 中不能作裸别名（时间单位关键字），用 AS + 显式分组表达式
    const trend = await d.all<{ day: string; n: number; neg: number }>("SELECT substr(created_at,1,10) AS day, COUNT(*) n, SUM(CASE WHEN sentiment='negative' THEN 1 ELSE 0 END) neg FROM voc_items GROUP BY substr(created_at,1,10) ORDER BY substr(created_at,1,10)");
    const pending = (await d.get<{ n: number }>("SELECT COUNT(*) n FROM messages m LEFT JOIN voc_items v ON v.message_id=m.id WHERE m.role='user' AND v.id IS NULL AND length(m.text) >= 4"))?.n ?? 0;
    return { total: await d.count('voc_items'), pending, topics, sentiment, keywords: Object.entries(kw).map(([k, n]) => ({ k, n })).sort((a, b) => b.n - a.n).slice(0, 40), trend, alerts: topics.filter((t) => t.n >= 2 && t.neg / t.n >= 0.5).map((t) => ({ topic: t.topic, negativeRatio: Number((t.neg / t.n).toFixed(2)), n: t.n })) };
  });
  app.get('/api/voc/items', async (req) => {
    const q = req.query as Record<string, string>;
    const where: string[] = [];
    const params: string[] = [];
    if (q.topic) {
      where.push('topic=?');
      params.push(q.topic);
    }
    if (q.sentiment) {
      where.push('sentiment=?');
      params.push(q.sentiment);
    }
    return (await db().all(`SELECT * FROM voc_items ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT 200`, ...params)).map((r) => ({ ...r, keywords: J.parse(r.keywords, []) }));
  });
  app.post('/api/voc/ask', async (req) => {
    const b = z.object({ question: z.string().min(2).max(300) }).parse(req.body);
    const d = db();
    const stats = { topics: await d.all(`SELECT topic, COUNT(*) n, SUM(CASE WHEN sentiment='negative' THEN 1 ELSE 0 END) neg FROM voc_items GROUP BY topic ORDER BY n DESC`), sentiment: await d.all('SELECT sentiment, COUNT(*) n FROM voc_items GROUP BY sentiment'), total: await d.count('voc_items') };
    // 关键词：问题中出现的主题名 + 中文二元组，任一命中原声或主题即入选样本；无命中时退回最近样本
    const all = await d.all<{ text: string; topic: string; sentiment: string }>('SELECT text, topic, sentiment FROM voc_items ORDER BY created_at DESC LIMIT 200');
    const topicsInQ = [...new Set(all.map((s) => s.topic))].filter((t) => b.question.includes(t) || t.split('').some((ch) => b.question.includes(ch) && t.length <= 4 && b.question.includes(t.slice(0, 2))));
    const han = b.question.replace(/[^\u4e00-\u9fff]/g, '');
    const bigrams = new Set<string>();
    for (let i = 0; i < han.length - 1; i++) bigrams.add(han.slice(i, i + 2));
    const STOP = new Set(['用户', '客户', '什么', '哪些', '是什', '么样', '怎么', '如何', '最不', '不满', '满意', '意的', '的是', '主要', '诉求', '对于', '关于', '一下']);
    const kws = [...topicsInQ, ...[...bigrams].filter((k) => !STOP.has(k))];
    const matched = all.filter((s) => kws.some((k) => s.text.includes(k) || s.topic.includes(k)));
    const chosen = (matched.length ? matched : all).slice(0, 25);
    const samples = chosen.map((s) => `[${s.topic}/${s.sentiment}] ${s.text}`);
    const r = await vocAsk(b.question, stats, samples);
    return { ...r, sampleCount: chosen.length, matchedByKeyword: matched.length, stats };
  });

  /* ───────────── 售后数字员工 ───────────── */
  app.get('/api/employees', async () => {
    const packs = SCENARIO_PACKS.filter((p) => ['logistics', 'invoice', 'refund_price_diff'].includes(p.id));
    return Promise.all(
      packs.map(async (p) => {
        const runs = await db().all<{ decision: string; risk_level: string; n: number }>('SELECT decision, risk_level, COUNT(*) n FROM employee_runs WHERE employee=? GROUP BY decision, risk_level', p.id);
        const total = runs.reduce((s, r) => s + r.n, 0);
        return { ...p, stats: { total, auto: runs.filter((r) => r.decision === 'auto_reply').reduce((s, r) => s + r.n, 0), humanConfirm: runs.filter((r) => r.decision === 'human_confirm').reduce((s, r) => s + r.n, 0), escalate: runs.filter((r) => r.decision === 'escalate').reduce((s, r) => s + r.n, 0) } };
      }),
    );
  });
  app.get('/api/employees/:id/runs', async (req) => await db().all('SELECT * FROM employee_runs WHERE employee=? ORDER BY created_at DESC LIMIT 50', (req.params as { id: string }).id));
  app.post('/api/employees/:id/run', async (req) => {
    const { id } = req.params as { id: string };
    const b = z.object({ text: z.string().min(1).max(2000), customerId: z.string().nullable().default(null) }).parse(req.body);
    const t = await runStandalone(b.text, { customerId: b.customerId });
    await db().run('INSERT INTO employee_runs VALUES (?,?,?,?,?,?,?,?)', uid('er-'), id, t.id, t.conversationId, t.createdAt, t.autonomy?.decision ?? null, t.risk?.level ?? null, `沙箱试跑：${t.intent ?? ''}`);
    return { trace: t, matchedEmployee: t.scenario === id };
  });
}
