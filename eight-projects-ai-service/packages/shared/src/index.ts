/** 八项目 AI 客服：前后端共享类型。所有跨模块对象在此定义，避免各页面各造一套事实。 */

export type Role = 'user' | 'agent' | 'bot' | 'system';
export type Channel = 'web' | 'app' | 'wechat' | 'taobao' | 'douyin' | 'jd' | 'phone';
export type ConversationStatus = 'open' | 'waiting_human' | 'closed';
export type Controller = 'bot' | 'human';

export interface Message {
  id: string;
  conversationId: string;
  role: Role;
  text: string;
  at: string;
  traceId?: string | null;
  meta?: Record<string, unknown> | null;
}

export interface Customer {
  id: string;
  name: string;
  phone: string;
  level: 'normal' | 'vip' | 'svip';
  channel: Channel;
  tags: string[];
  note?: string;
}

export interface Conversation {
  id: string;
  title: string;
  channel: Channel;
  customerId: string;
  customerName: string;
  status: ConversationStatus;
  controller: Controller;
  assignee: string | null;
  scenario: string | null;
  priority: 'P0' | 'P1' | 'P2' | null;
  lastMessageAt: string;
  createdAt: string;
  messageCount: number;
  summary?: string | null;
  satisfaction?: number | null;
  unread?: number;
}

/** 执行链九个阶段 */
export type StageId =
  | 'intake'
  | 'completion'
  | 'intent'
  | 'evidence'
  | 'knowledge'
  | 'reasoning'
  | 'risk'
  | 'autonomy'
  | 'reply';

export const STAGE_LABELS: Record<StageId, string> = {
  intake: '用户输入',
  completion: '信息补全',
  intent: '意图/场景识别',
  evidence: '证据获取',
  knowledge: '知识/工具调用',
  reasoning: '推理与根因判断',
  risk: '风险分级',
  autonomy: '自主处理/人工确认/升级',
  reply: '最终回复',
};

export interface StageRecord {
  id: StageId;
  label: string;
  status: 'ok' | 'skipped' | 'error';
  startedAt: string;
  durationMs: number;
  summary: string;
  detail: Record<string, unknown>;
  llm?: LlmUsage | null;
}

export interface LlmUsage {
  model: string;
  provider?: string;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
  cachedTokens?: number;
  durationMs: number;
  thinking: boolean;
  attempts?: number;
  failedOver?: boolean;
}

export type RiskLevel = 'L0' | 'L1' | 'L2' | 'L3';
export type AutonomyDecision = 'auto_reply' | 'human_confirm' | 'escalate';
export type Priority = 'P0' | 'P1' | 'P2';

export interface Slot {
  key: string;
  label: string;
  value: string | null;
  source: 'message' | 'regex' | 'crm' | 'history' | 'llm' | 'missing';
  required: boolean;
}

export interface EvidenceItem {
  id: string; // tool:<name>#<n>
  tool: string;
  label: string;
  ok: boolean;
  durationMs: number;
  args: Record<string, unknown>;
  data: unknown;
  error?: string;
}

export interface KnowledgeHit {
  id: string; // kb:<chunkId>
  chunkId: string;
  docId: string;
  docTitle: string;
  text: string;
  score: number;
  tags: string[];
}

export interface Citation {
  id: string; // kb:... 或 tool:...
  quote?: string;
}

export interface ProposedAction {
  type:
    | 'none'
    | 'clarify'
    | 'create_ticket'
    | 'reship'
    | 'refund'
    | 'price_difference_refund'
    | 'invoice_reissue'
    | 'handoff';
  params: Record<string, unknown>;
  reason: string;
}

export interface RiskAssessment {
  level: RiskLevel;
  signals: {
    intentConfidence: number;
    evidenceCompleteness: number;
    retrievalConfidence: number;
    ruleCertainty: number;
  };
  flags: string[];
  reasons: string[];
}

export interface AutonomyResult {
  decision: AutonomyDecision;
  priority: Priority | null;
  reasons: string[];
  autoActionsExecuted: string[];
  whitelistMatched: boolean;
}

export interface Trace {
  id: string;
  conversationId: string;
  agentId: string;
  agentVersion: number;
  createdAt: string;
  input: { text: string; turn: number };
  scenario: string | null;
  intent: string | null;
  slots: Slot[];
  evidence: EvidenceItem[];
  knowledge: KnowledgeHit[];
  reasoning: {
    rootCause: string;
    analysis: string;
    draft: string;
    citations: Citation[];
    proposedAction: ProposedAction;
    needsHuman: boolean;
  } | null;
  risk: RiskAssessment | null;
  autonomy: AutonomyResult | null;
  /**
   * text：实际对客发送的文本（自主回复 = 候选话术；人工确认 = 等待人工核实提示；升级 = 转接话术）
   * candidate：推理阶段生成的候选话术，供坐席审核采用；自主回复时与 text 相同
   */
  reply: { text: string; candidate: string; internalNote: string; kind: 'answer' | 'clarify' | 'pending_confirm' | 'handoff' } | null;
  stages: StageRecord[];
  totalDurationMs: number;
  usage: { promptTokens: number; completionTokens: number; calls: number };
  status: 'completed' | 'failed';
  error?: string | null;
  /** 模型不可用时进入规则降级：意图用关键词规则、话术用证据模板，强制人工确认 */
  degraded: boolean;
  degradedReason: string | null;
  /** 本次实际使用的 provider（去重），含是否发生切换 */
  providers: string[];
  failedOver: boolean;
}

/** 场景包 = 数字员工。同一条链按场景包切换必填槽位、工具、知识标签与允许动作。 */
export interface ScenarioPack {
  id: string;
  name: string;
  description: string;
  requiredSlots: { key: string; label: string; ask: string }[];
  tools: string[];
  knowledgeTags: string[];
  allowedAutoActions: ProposedAction['type'][];
  maxAutoRisk: RiskLevel;
  examples: string[];
}

export interface AgentConfig {
  id: string;
  name: string;
  description: string;
  version: number;
  status: 'draft' | 'published';
  models: { fast: string; reasoning: string; reasoningEffort: 'low' | 'medium' | 'high' };
  persona: string;
  scenarios: string[]; // scenario pack ids
  whitelistScenarios: string[]; // 允许自主回复的场景
  maxAutoRisk: RiskLevel;
  retrieval: { topK: number; minScore: number; rewriteOnMiss: boolean };
  handoffRules: { keywords: string[]; maxBotTurns: number };
  tools: string[];
  updatedAt: string;
}

export interface Ticket {
  id: string;
  title: string;
  type: string;
  status: 'open' | 'processing' | 'pending' | 'resolved' | 'closed';
  priority: Priority;
  conversationId: string | null;
  customerId: string | null;
  customerName: string;
  assignee: string | null;
  description: string;
  slaDueAt: string;
  createdAt: string;
  updatedAt: string;
  source: 'manual' | 'agent' | 'chain';
  history: { at: string; by: string; action: string; note?: string }[];
}

export interface KnowledgeDoc {
  id: string;
  title: string;
  category: string;
  tags: string[];
  content: string;
  status: 'draft' | 'published';
  version: number;
  chunkCount: number;
  updatedAt: string;
  source: 'manual' | 'import' | 'faq' | 'conversation';
}

export interface KnowledgeChunk {
  id: string;
  docId: string;
  seq: number;
  text: string;
  tags: string[];
}

export interface QualityRule {
  id: string;
  name: string;
  kind: 'forbidden_word' | 'required_word' | 'response_time' | 'turns' | 'sentiment' | 'semantic';
  config: Record<string, unknown>;
  score: number; // 加减分
  enabled: boolean;
}

export interface QualityResult {
  id: string;
  conversationId: string;
  agent: string | null;
  score: number;
  hits: { ruleId: string; ruleName: string; delta: number; evidence: string }[];
  semantic: { summary: string; issues: string[]; tone: string } | null;
  createdAt: string;
  reviewedBy: string | null;
  reviewNote: string | null;
}

export interface VocItem {
  id: string;
  conversationId: string;
  messageId: string;
  text: string;
  topic: string;
  sentiment: 'positive' | 'neutral' | 'negative';
  keywords: string[];
  createdAt: string;
}

export interface IvrNode {
  id: string;
  type: 'play' | 'menu' | 'collect' | 'transfer' | 'end';
  text: string;
  options?: { key: string; label: string; next: string }[];
  next?: string;
  slot?: string;
}

export interface IvrFlow {
  id: string;
  name: string;
  status: 'draft' | 'published';
  entry: string;
  nodes: IvrNode[];
  updatedAt: string;
}

export interface OutboundCampaign {
  id: string;
  name: string;
  goal: string;
  script: string;
  status: 'draft' | 'running' | 'finished';
  contacts: { name: string; phone: string; result?: string; summary?: string }[];
  stats: { total: number; connected: number; interested: number; refused: number };
  createdAt: string;
}

export interface ReportSpec {
  dataset: 'conversations' | 'tickets' | 'traces' | 'quality';
  dimension: string;
  metric: string;
  dateFrom?: string;
  dateTo?: string;
}

export interface ReportResult {
  spec: ReportSpec;
  columns: string[];
  rows: { key: string; value: number; extra?: Record<string, number> }[];
  generatedAt: string;
}
