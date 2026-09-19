import { z } from 'zod';
import type { Message } from '@eight/shared';
import { J, nowIso, openDb, uid } from '../db.ts';
import { llm, loadMessages } from './chain.ts';

const transcript = (messages: Message[]) => messages.filter((m) => m.role !== 'system').map((m) => `[${{ user: '用户', agent: '客服', bot: '机器人', system: '系统' }[m.role]}] ${m.text}`).join('\n');

async function record(capability: string, input: unknown, output: unknown, usage: unknown, conversationId: string | null) {
  const id = uid('job-');
  await openDb().run('INSERT INTO aigc_jobs VALUES (?,?,?,?,?,?,?)', id, capability, J.str(input), J.str(output), J.str(usage), nowIso(), conversationId);
  return id;
}

export const SummarySchema = z.object({ problem: z.string(), handling: z.string(), outcome: z.string(), followUp: z.string().default(''), tags: z.array(z.string()).max(6).default([]) });
export async function summarize(conversationId: string) {
  const msgs = await loadMessages(conversationId);
  const r = await llm.chatJson(SummarySchema, [
    { role: 'system', content: '你是客服会话小记生成器。用简洁中文概括：客户问题(problem)、处理过程(handling)、当前结果(outcome)、待跟进事项(followUp)、标签(tags ≤6)。只依据对话内容，不臆测。只输出 JSON。' },
    { role: 'user', content: transcript(msgs) || '（空会话）' },
  ]);
  const id = await record('summary', { conversationId }, r.value, r.usage, conversationId);
  return { id, ...r.value, usage: r.usage };
}

export const ClassifySchema = z.object({ level1: z.string(), level2: z.string(), level3: z.string().default(''), emotion: z.enum(['positive', 'neutral', 'negative', 'angry']), urgency: z.enum(['low', 'medium', 'high']), confidence: z.number().min(0).max(1) });
export async function classify(conversationId: string) {
  const msgs = await loadMessages(conversationId);
  const r = await llm.chatJson(ClassifySchema, [
    { role: 'system', content: '你是客服会话分类器。输出三级分类（level1 如 售后/售前/投诉/账号；level2 如 物流/发票/退款/差价/产品咨询；level3 更细）、用户情绪(emotion)、紧急度(urgency)、置信度。只输出 JSON。' },
    { role: 'user', content: transcript(msgs) },
  ]);
  const id = await record('classify', { conversationId }, r.value, r.usage, conversationId);
  return { id, ...r.value, usage: r.usage };
}

export const TicketExtractSchema = z.object({ title: z.string().max(80), type: z.string(), priority: z.enum(['P0', 'P1', 'P2']), description: z.string().max(600), fields: z.record(z.string(), z.string()).default({}) });
export async function extractTicket(conversationId: string) {
  const msgs = await loadMessages(conversationId);
  const r = await llm.chatJson(TicketExtractSchema, [
    { role: 'system', content: '你把客服对话提取为工单：title、type（物流/发票/退款/投诉/售前/其他）、priority（投诉或监管风险 P1，人身安全 P0，其他 P2）、description（包含订单号、诉求、已做处理）、fields（订单号/手机号/金额等键值）。只输出 JSON。' },
    { role: 'user', content: transcript(msgs) },
  ]);
  const id = await record('ticket-extract', { conversationId }, r.value, r.usage, conversationId);
  return { id, ...r.value, usage: r.usage };
}

export const RewriteSchema = z.object({ variants: z.array(z.object({ style: z.string(), text: z.string() })).min(1).max(3) });
export async function rewrite(text: string, style: string, persona: string) {
  const r = await llm.chatJson(RewriteSchema, [
    { role: 'system', content: `你是客服话术润色器。角色设定：${persona}。在不改变事实、不新增承诺、不新增数字的前提下，按要求风格润色，给出 1~3 个版本。只输出 {"variants":[{"style":..,"text":..}]}。` },
    { role: 'user', content: `风格要求：${style}\n原文：${text}` },
  ]);
  const id = await record('rewrite', { text, style }, r.value, r.usage, null);
  return { id, ...r.value, usage: r.usage };
}

export const FaqExtractSchema = z.object({ faqs: z.array(z.object({ question: z.string(), answer: z.string(), tags: z.array(z.string()).max(4).default([]) })).max(20) });
export async function extractFaq(text: string, max = 8) {
  const r = await llm.chatJson(FaqExtractSchema, [
    { role: 'system', content: `从给定资料中抽取最多 ${max} 个问答对（FAQ）。答案必须完全来自资料原文含义，不得补充资料外的事实。每条给 1~4 个标签。只输出 JSON。` },
    { role: 'user', content: text.slice(0, 8000) },
  ], { maxTokens: 1800 });
  const id = await record('faq-extract', { length: text.length }, r.value, r.usage, null);
  return { id, ...r.value, usage: r.usage };
}

export const SimilarSchema = z.object({ questions: z.array(z.string()).min(3).max(10) });
export async function similarQuestions(question: string, n = 6) {
  const r = await llm.chatJson(SimilarSchema, [
    { role: 'system', content: `为给定标准问生成 ${n} 个语义相同但表达不同的相似问（口语化、含错别字/省略也可），不改变意图与范围。只输出 {"questions":[...]}。` },
    { role: 'user', content: question },
  ]);
  const id = await record('similar-questions', { question }, r.value, r.usage, null);
  return { id, ...r.value, usage: r.usage };
}

export const SemanticQcSchema = z.object({
  summary: z.string().max(200),
  scores: z.object({ empathy: z.number().min(0).max(10), completeness: z.number().min(0).max(10), accuracy: z.number().min(0).max(10), compliance: z.number().min(0).max(10) }),
  issues: z.array(z.string()).max(6).default([]),
  tone: z.string().max(30),
  highlights: z.array(z.object({ quote: z.string().max(120), comment: z.string().max(80) })).max(4).default([]),
});
export async function semanticQc(conversationId: string) {
  const msgs = await loadMessages(conversationId);
  const r = await llm.chatJson(SemanticQcSchema, [
    { role: 'system', content: '你是客服质检员。对「客服/机器人」侧发言从同理心(empathy)、解决方案完整性(completeness)、信息准确性(accuracy)、合规性(compliance，不得承诺退款/赔付结果、不得给医疗建议、不得推责)四个维度 0-10 打分，列出问题(issues)、整体语气(tone)、关键片段(highlights)。只输出 JSON。' },
    { role: 'user', content: transcript(msgs) },
  ]);
  await record('semantic-qc', { conversationId }, r.value, r.usage, conversationId);
  return { ...r.value, usage: r.usage };
}

export const VocBatchSchema = z.object({ items: z.array(z.object({ messageId: z.string(), topic: z.string(), sentiment: z.enum(['positive', 'neutral', 'negative']), keywords: z.array(z.string()).max(4) })) });
export async function vocClassify(items: { messageId: string; text: string }[]) {
  const r = await llm.chatJson(VocBatchSchema, [
    { role: 'system', content: '你是客户之声分析器。为每条用户消息标注主题(topic，从：物流时效/物流异常/发票开具/退款到账/保价差价/产品防水/佩戴安装/手机适配/价格优惠/服务态度/账号使用/其他 中选一个)、情绪(sentiment)、≤4 个关键词。逐条输出，messageId 原样返回。只输出 {"items":[...]}。' },
    { role: 'user', content: items.map((i) => `${i.messageId}\t${i.text.slice(0, 200)}`).join('\n') },
  ], { maxTokens: 1600 });
  await record('voc-classify', { count: items.length }, { count: r.value.items.length }, r.usage, null);
  return r.value.items;
}

export const VocAskSchema = z.object({ answer: z.string().max(800), evidence: z.array(z.string()).max(6).default([]), caveats: z.string().max(200).default('') });
export async function vocAsk(question: string, stats: unknown, samples: string[]) {
  const r = await llm.chatJson(VocAskSchema, [
    { role: 'system', content: '你是客户之声分析助手。只能依据给出的统计数据与样本原声回答问题，给出结论(answer)、引用的原声(evidence ≤6 条，原文摘录)、局限说明(caveats)。不要编造统计数字。只输出 JSON。' },
    { role: 'user', content: `问题：${question}\n\n统计：${JSON.stringify(stats)}\n\n样本原声：\n${samples.map((s, i) => `${i + 1}. ${s}`).join('\n')}` },
  ], { maxTokens: 1200 });
  await record('voc-ask', { question }, r.value, r.usage, null);
  return { ...r.value, usage: r.usage };
}

export const OutboundSchema = z.object({ results: z.array(z.object({ name: z.string(), result: z.enum(['connected_interested', 'connected_refused', 'connected_neutral', 'no_answer', 'busy']), summary: z.string().max(120) })) });
export async function simulateOutbound(script: string, goal: string, contacts: { name: string; phone: string }[]) {
  const r = await llm.chatJson(OutboundSchema, [
    { role: 'system', content: '你是 AI 外呼模拟器。给定话术与目标，为每位联系人模拟一次外呼结果（result 从 connected_interested / connected_refused / connected_neutral / no_answer / busy 选）并给一句通话小结。结果应多样且合理。只输出 JSON。注意：这是模拟，用于演示流程。' },
    { role: 'user', content: `目标：${goal}\n话术：${script}\n联系人：${contacts.map((c) => c.name).join('、')}` },
  ]);
  await record('outbound-simulate', { goal, contacts: contacts.length }, r.value, r.usage, null);
  return r.value.results;
}
