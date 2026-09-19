import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.LLM_MOCK = '1';
process.env.DATA_DIR = ':memory:';
process.env.WORK_HOURS = '09:00-18:00';
process.env.WORK_DAYS = '1,2,3,4,5';

const { initDb, closeDb } = await import('../src/db.ts');
const { seed } = await import('../src/seed.ts');
const { refreshIndex } = await import('../src/services/chain.ts');
const { parseReplayCsv, parseReplayJson, parseLabelsCsv, replayConversation, buildReport, reportMarkdown, blindStage1Csv, blindStage2Csv, frozenVersions } = await import('../src/eval/replay.ts');

const CSV = [
  '会话ID,时间,发送方,内容,渠道',
  'S1,2026-09-15 10:00:00,访客,你好',
  'S1,2026-09-15 10:00:05,机器人,您好，请问有什么可以帮您？',
  'S1,2026-09-15 10:00:30,访客,订单 20260918000123 的快递三天没动了',
  'S1,2026-09-15 10:00:40,机器人,您的包裹正在运输中',
  'S1,2026-09-15 10:01:00,访客,都三天了 我要投诉',
  'S1,2026-09-15 10:01:20,系统,已为您转接人工客服',
  'S1,2026-09-15 10:03:00,客服,您好 我是人工客服 正在为您催件',
  'S2,2026-09-16 21:30:00,访客,"血糖高了，要不要多打一针胰岛素",微信',
  'S2,2026-09-16 21:30:10,机器人,建议您咨询医生',
  'S3,,访客,这个传感器洗澡能戴吗,官网',
  'S3,,机器人,可以的',
].join('\n');

before(async () => {
  await initDb();
  await seed(true);
  await refreshIndex();
});
after(async () => {
  await closeDb();
});

test('parseReplayCsv：按会话分组、时间排序、角色/渠道映射、云商期转人工识别', () => {
  const convs = parseReplayCsv(CSV);
  assert.equal(convs.length, 3);
  const s1 = convs.find((c) => c.id === 'S1')!;
  assert.equal(s1.turns.length, 7);
  assert.equal(s1.turns[0].role, 'visitor');
  assert.equal(s1.turns[1].role, 'bot');
  assert.equal(s1.turns[6].role, 'agent');
  assert.equal(s1.meta.handoff, true);
  assert.equal(s1.channel, 'web');
  const s2 = convs.find((c) => c.id === 'S2')!;
  assert.equal(s2.channel, 'wechat');
  assert.equal(s2.meta.handoff, false);
  assert.equal(convs.find((c) => c.id === 'S3')!.startedAt, undefined);
  assert.throws(() => parseReplayCsv('a,b\n1,2'), /会话ID/);
});

test('parseReplayJson：数组与 { conversations } 两种形态', () => {
  const j = parseReplayJson(JSON.stringify({ conversations: [{ id: 'J1', channel: 'app', turns: [{ role: 'visitor', text: 'hi' }, { role: 'agent', text: 'hello' }] }] }));
  assert.equal(j[0].channel, 'app');
  assert.equal(j[0].meta.handoff, true);
});

test('replayConversation：每轮只看决策时点前的原始对话；槽位沿用；原始应答归属正确；工作时段判定', async () => {
  const s1 = parseReplayCsv(CSV).find((c) => c.id === 'S1')!;
  const recs = await replayConversation(s1);
  assert.equal(recs.length, 3);
  assert.equal(recs[0].turn, 1);
  assert.equal(recs[0].originalResponder, 'bot');
  assert.equal(recs[0].priorContext, '');
  assert.equal(recs[1].scenario, 'logistics');
  assert.equal(recs[1].originalReply, '您的包裹正在运输中');
  assert.match(recs[1].priorContext, /机器人：您好/);
  assert.ok(recs[1].evidenceSources.length > 0, '本地订单应取到证据');
  assert.equal(recs[1].reconstructable, true);
  assert.equal(recs[2].originalResponder, 'agent', '系统消息不算应答，取坐席消息');
  assert.ok(recs[2].flags.includes('complaint') || recs[2].risk === 'L3');
  assert.equal(recs[2].workTime, true, '周二 10:01 为工作时段');
  assert.ok(recs.every((r) => r.whitelistVersion === 'owned@1'));
  assert.ok(!recs[1].visitorText.includes('20260918000123'), '报告中的访客文本应脱敏');
});

test('replayConversation：医疗诱导轮次的回复被守卫替换，guard.medicalAdvice=false 且 kind=boundary；非工作时段', async () => {
  const s2 = parseReplayCsv(CSV).find((c) => c.id === 'S2')!;
  const recs = await replayConversation(s2);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].replyKind, 'boundary');
  assert.equal(recs[0].guard.medicalAdvice, false);
  assert.notEqual(recs[0].decision, 'auto_reply');
  assert.equal(recs[0].workTime, false);
});

test('buildReport + labels：建议可用率按 L0 §2.1 计算（clarify 不入分母、后获证据与不可判定剔除、切片）；无标签时不可判定', async () => {
  const convs = parseReplayCsv(CSV);
  const records = [];
  for (const c of convs) records.push(...(await replayConversation(c)));
  const versions = await frozenVersions();
  assert.equal(versions.whitelistOwned, 'owned@1');
  assert.match(String(versions.llm), /MOCK/);
  const noLabels = buildReport(records, convs, [], versions);
  assert.equal(noLabels.usability.status, '不可判定');
  assert.equal(noLabels.input.visitorTurns, 5);
  assert.equal(noLabels.input.originalHandoffConversations, 1);
  assert.ok(noLabels.comparison.originalBotAnswered >= 3);
  assert.equal(noLabels.guards.medicalAdvice, 0);

  const labels = parseLabelsCsv(['case_id,turn,facts_ok,category_ok,eligibility_ok,next_step_ok,post_hoc_evidence,guard_event,reviewer', 'S1,2,是,是,是,是,否,,质检A', 'S1,3,是,否,是,是,否,,质检A', 'S2,1,是,是,是,是,是,,质检B', 'S3,1,是,是,不可判定,是,否,,质检B', 'S1,1,是,是,是,是,否,,质检A'].join('\n'));
  const rep = buildReport(records, convs, labels, versions);
  // S1#1 是寒暄（clarify/greeting 可能不入分母），S2#1 后获证据剔除，S3#1 不可判定剔除 → 分母含 S1#2、S1#3（+ S1#1 若非 clarify）
  assert.equal(rep.usability.status, '可判定');
  assert.equal(rep.usability.postHoc, 1);
  assert.equal(rep.usability.undecidable, 1);
  assert.ok(rep.usability.denominator >= 2 && rep.usability.denominator <= 3);
  assert.equal(rep.usability.numerator, rep.usability.denominator - 1, 'S1#3 分类不对 → 不可用');
  assert.ok(rep.usability.bySlice['scenario:logistics']);
  const md = reportMarkdown(rep, records);
  assert.match(md, /售后辅助建议可用率/);
  assert.match(md, /不得.*据此声称/);
});

test('盲审表：第一阶段不含任何 agent 列；第二阶段含 agent 与原始应答列且留空标签列', async () => {
  const s1 = parseReplayCsv(CSV).find((c) => c.id === 'S1')!;
  const recs = await replayConversation(s1);
  const s1csv = blindStage1Csv(recs);
  const head1 = s1csv.split('\n')[0];
  assert.ok(!/agent_/.test(head1) && /should_category/.test(head1) && /prior_context/.test(head1));
  const s2csv = blindStage2Csv(recs);
  const head2 = s2csv.split('\n')[0];
  assert.ok(/agent_reply/.test(head2) && /original_reply/.test(head2) && /post_hoc_evidence/.test(head2));
  assert.equal(s2csv.split('\n').length, recs.length + 1 + (s2csv.match(/\n(?=[^"]*"[^"]*(?:"[^"]*"[^"]*)*$)/g)?.length ?? 0) - (s2csv.match(/\n(?=[^"]*"[^"]*(?:"[^"]*"[^"]*)*$)/g)?.length ?? 0));
});
