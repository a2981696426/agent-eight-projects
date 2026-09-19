# 子案件 + 人工接续任务 + DMS 模拟适配器 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 CS-016 把现有「工单系统」改造成 **子案件（cases）+ 人工接续任务（handoff_tasks）**，工单能力只保留"关联 DMS"一种写法，DMS 先用同契约的**模拟适配器**跑通（可注入不可用 / 拒绝 / 已注销），执行链转人工时自动创建接续任务并按**工作日历 + 优先级档位**告知预计人工响应时窗（CS-008E/G/I）。

**Architecture:** 领域层新增 `services/handoff.ts`（工作日历、时窗、接续任务生命周期、单活动任务约束）与 `services/dms.ts`（`DmsAdapter` 契约 + `MockDmsAdapter`，落库 `dms_mock_tickets`，幂等键 = 子案件 id）；`routes/cases.ts` 替换 `routes/tickets.ts`，暴露 `/api/cases`、`/api/handoffs`、`/api/dms`；`chain.ts` 在决策非 `auto_reply` 时调用 `ensureHandoffTask`，并通过新增的 `ChainContext.responseWindow` 钩子把日历时窗注入最终回复；前端 `Cases.tsx` 三个 Tab（接续任务 / 子案件 / DMS 模拟）。

**Tech Stack:** 同计划 1（Fastify 5、zod 4、pg/PGlite 数据层、React 19 + antd 5、Playwright、node:test）。

## Global Constraints

- 术语与状态口径来自 `docs/contexts/commerce-platform/CONTEXT.md` 与 CS-016：子案件状态只有 `pending_human`（待人工）/ `in_progress`（处理中）/ `linked_dms`（已关联 DMS）/ `archived`（已归档）；本地**不得**出现"已解决 / 已关闭"等正式售后状态。
- DMS 是正式售后工单唯一权威（CS-003）：本地只保存 `dms_ticket_no` / `dms_status` 回读值；DMS 不可用时子案件标记 `dms_pending=1`（待同步案件），不得展示为"建单成功"。
- 所有 DMS 写入由坐席确认触发（按钮），执行链不得直接调用 DMS。
- 响应时窗只表示"预计开始人工接续"，文案不得出现完成承诺；P0 只有在告警投递回执后才说"已优先通知专人"。
- 同一会话同一时刻只允许一个活动（`pending` / `claimed`）接续任务；重复触发追加进度并沿用最早创建时间，优先级只升不降。
- 导航项保留"工单协作"作为云商产品结构对照，页面内文案一律用"子案件 / 接续任务 / DMS 工单"。
- 不引入新外部依赖；不改 `packages/shared` 以外的公共包接口，`agent-core` 只加可选钩子与工具名。
- `pnpm -r typecheck` 零错误；单测全绿；e2e 全绿。

---

### Task 1: 领域模型与 Schema（shared 类型 + 表 + seed）

**Files:**
- Modify: `packages/shared/src/index.ts`（删 `Ticket`，加 `SubCase` / `HandoffTask` / `DmsTicket` 等）
- Modify: `apps/api/src/db.ts`（SCHEMA：删 `tickets`，加 `cases` / `handoff_tasks` / `dms_mock_tickets`）
- Modify: `apps/api/src/seed.ts`（工单种子 → 子案件 + 接续任务 + DMS 模拟票据；`DEFAULT_AGENT.tools` 中 `tickets.create` → `cases.create`；清表列表更新）

**Interfaces（Produces）:**

```ts
export type CaseStatus = 'pending_human' | 'in_progress' | 'linked_dms' | 'archived';
export interface CaseEvidence { slots: Record<string, string>; facts: { tool: string; summary: string }[]; traceIds: string[]; candidateReply: string | null }
export interface SubCase {
  id: string; title: string; type: string; status: CaseStatus; priority: Priority;
  conversationId: string | null; customerId: string | null; customerName: string; assignee: string | null;
  description: string; evidence: CaseEvidence; source: 'manual' | 'agent' | 'chain';
  dms: { ticketNo: string | null; status: string | null; syncedAt: string | null; pending: boolean; lastError: string | null };
  createdAt: string; updatedAt: string;
  history: { at: string; by: string; action: string; note?: string }[];
}
export type HandoffStatus = 'pending' | 'claimed' | 'done' | 'cancelled';
export interface HandoffProgress { doneStages: string[]; evidence: string[]; missing: string[]; candidate: string | null; failure: string | null; nextAction: string }
export interface HandoffTask {
  id: string; conversationId: string; caseId: string | null; channel: string; priority: Priority; status: HandoffStatus;
  reason: string; progress: HandoffProgress; traceId: string | null;
  windowText: string; dueAt: string; createdAt: string; claimedBy: string | null; claimedAt: string | null; doneAt: string | null;
  alert: { deliveredAt: string | null; ackAt: string | null } | null;
  history: { at: string; by: string; action: string; note?: string }[];
}
export type DmsFailure = 'unavailable' | 'rejected' | 'not_found' | 'account_cancelled';
export interface DmsTicket { ticketNo: string; status: 'received' | 'processing' | 'resolved' | 'closed'; updatedAt: string }
```

Schema 增量（追加到 `SCHEMA`，删除 `tickets` 建表行）：

```sql
CREATE TABLE IF NOT EXISTS cases(id TEXT PRIMARY KEY, title TEXT, type TEXT, status TEXT, priority TEXT, conversation_id TEXT, customer_id TEXT, customer_name TEXT, assignee TEXT, description TEXT, evidence TEXT, source TEXT, dms_ticket_no TEXT, dms_status TEXT, dms_synced_at TEXT, dms_pending INTEGER DEFAULT 0, dms_last_error TEXT, created_at TEXT, updated_at TEXT, history TEXT);
CREATE INDEX IF NOT EXISTS idx_cases_conv ON cases(conversation_id);
CREATE TABLE IF NOT EXISTS handoff_tasks(id TEXT PRIMARY KEY, conversation_id TEXT, case_id TEXT, channel TEXT, priority TEXT, status TEXT, reason TEXT, progress TEXT, trace_id TEXT, window_text TEXT, due_at TEXT, created_at TEXT, claimed_by TEXT, claimed_at TEXT, done_at TEXT, alert TEXT, history TEXT);
CREATE INDEX IF NOT EXISTS idx_handoff_conv ON handoff_tasks(conversation_id, status);
CREATE TABLE IF NOT EXISTS dms_mock_tickets(ticket_no TEXT PRIMARY KEY, idem_key TEXT UNIQUE, case_id TEXT, payload TEXT, status TEXT, created_at TEXT, updated_at TEXT);
DROP TABLE IF EXISTS tickets;
```

Seed（替换原 tickets 段）：4 个子案件——`CS-2026-0901` 物流催件 `in_progress`（conv-001，客服小欧）、`CS-2026-0902` 发票换开 `linked_dms`（conv-002，dms_ticket_no `DMS-20260916-0001`，对应 `dms_mock_tickets` 一条 `resolved`）、`CS-2026-0903` 退差价 `pending_human`（conv-003，`dms_pending=1`，`dms_last_error='DMS 不可用（演示）'`）、`CS-2026-0904` 投诉 `in_progress` P1（conv-004，主管王琳）；2 个接续任务——conv-003 P2 `pending`（reason "涉及资金，需人工确认"，dueAt 用 `computeWindow('P2', created)`），conv-004 P1 `claimed`（主管王琳）。`DEFAULT_AGENT.tools` 改 `cases.create`。

- [ ] Step 1 修改 shared 类型；Step 2 修改 SCHEMA（含 `DROP TABLE IF EXISTS tickets`，PGlite 开发库一次性清理）；Step 3 改 seed；Step 4 `pnpm -r typecheck`（此时 api/web 报错集中在 tickets 相关文件，Task 2～5 处理）；Step 5 提交 `feat(cases): domain model, schema and seed for sub-cases, handoff tasks and DMS mock`。

---

### Task 2: `services/handoff.ts` —— 工作日历、响应时窗、接续任务生命周期（TDD）

**Files:**
- Create: `apps/api/src/services/handoff.ts`
- Create: `apps/api/test/handoff.test.ts`
- Modify: `apps/api/src/env.ts`（`WORK_HOURS=09:00-18:00`、`WORK_DAYS=1,2,3,4,5`、`HOLIDAYS=`）

**Interfaces（Produces）:**

```ts
export interface WorkCalendar { startMin: number; endMin: number; days: number[]; holidays: Set<string> }
export function calendarFromEnv(): WorkCalendar
export function isWorkTime(d: Date, cal: WorkCalendar): boolean
export function nextWorkStart(d: Date, cal: WorkCalendar): Date        // d 若在工作时间内返回 d
export function addWorkHours(d: Date, hours: number, cal: WorkCalendar): Date
export function computeWindow(priority: Priority, now: Date, cal: WorkCalendar, alertDelivered = false): { dueAt: string; text: string }
// P0: now+15min；text = alertDelivered ? '已优先通知专人处理' : '已升级处理，专人会尽快联系您'
// P1: addWorkHours(nextWorkStart(now), 2)；text = isWorkTime(now) ? '预计 2 个工作小时内开始接续' : '人工上线后优先处理，预计 2 个工作小时内开始接续'
// P2: addWorkHours(nextWorkStart(now), 9)（一个工作日的工时）；text = '预计 1 个工作日内开始处理'
export const windowSentence = (p: Priority, now = new Date()) => computeWindow(p, now, calendarFromEnv()).text
export function ensureHandoffTask(input: { conversationId: string; channel: string; priority: Priority; reason: string; progress: HandoffProgress; traceId: string | null }): Promise<{ task: HandoffTask; created: boolean }>
// 会话已有活动任务 → 追加 history、progress 覆盖、priority 取更高、created_at 不变；否则新建 pending
export function claimTask(id: string, actor: string): Promise<HandoffTask>      // status→claimed，并把会话 controller=human/assignee=actor/status=open
export function finishTask(id: string, actor: string, note: string): Promise<HandoffTask>
export function cancelActiveTasks(conversationId: string, actor: string, note: string): Promise<number>
export function activeTask(conversationId: string): Promise<HandoffTask | null>
export function rowToTask(r: Record<string, unknown>): HandoffTask
```

单测（先写后实现）：固定日历 09:00–18:00、周一至周五、假日 `2026-10-01`；用 `new Date('2026-09-18T10:00:00+08:00')`（周五工作时段）与 `2026-09-19T10:00:00+08:00`（周六）两个基准：

```ts
test('P1 工作时段内：2 小时后', ...)            // 10:00 → 12:00 同日
test('P1 周六：下周一 09:00 + 2h = 11:00', ...)
test('P1 17:00 跨日：次工作日 10:00', ...)      // 剩 1h 今日 + 1h 次日
test('P2 = 9 工作小时：周五 10:00 → 下周一 10:00', ...)
test('假日跳过：2026-09-30 17:00 P1 → 10-02 10:00', ...)
test('P0 = 15 自然分钟，未回执文案不含"专人已通知"', ...)
test('ensureHandoffTask 同会话第二次触发不新建，优先级只升不降，created_at 不变', ...)  // PGlite 内存库
test('claimTask 把会话切到人工并记录 claimed_by', ...)
```

- [ ] Step 1 写测试；Step 2 运行确认失败；Step 3 实现（时区按服务器本地时间，日历分钟数用本地 `getHours/getMinutes`）；Step 4 测试通过；Step 5 提交 `feat(handoff): work calendar, response window tiers and handoff task lifecycle`。

---

### Task 3: `services/dms.ts` —— 适配器契约 + 模拟实现（TDD）

**Files:**
- Create: `apps/api/src/services/dms.ts`
- Create: `apps/api/test/dms.test.ts`

**Interfaces（Produces）:**

```ts
export type DmsResult<T> = { ok: true; data: T } | { ok: false; kind: DmsFailure; message: string };
export interface DmsTicketInput { caseId: string; title: string; type: string; priority: Priority; customerName: string; orderId?: string | null; description: string; evidence: unknown }
export interface DmsAdapter {
  readonly kind: 'mock' | 'real';
  createTicket(input: DmsTicketInput): Promise<DmsResult<DmsTicket>>;   // 幂等键 = input.caseId
  getTicket(ticketNo: string): Promise<DmsResult<DmsTicket>>;
  health(): Promise<{ ok: boolean; kind: string; mode: MockMode }>;
}
export type MockMode = 'normal' | 'unavailable' | 'reject' | 'account_cancelled' | 'slow';
export class MockDmsAdapter implements DmsAdapter {
  mode: MockMode = 'normal';
  // normal：写 dms_mock_tickets（idem_key 冲突时返回已有票据），ticketNo = `DMS-${yyyymmdd}-${seq 4 位}`，status 'received'
  // unavailable：返回 { ok:false, kind:'unavailable' }；reject：kind 'rejected'；account_cancelled：kind 'account_cancelled'；slow：延迟 1500ms 后按 normal
  advance(ticketNo: string): Promise<DmsResult<DmsTicket>>   // received→processing→resolved→closed
  list(): Promise<DmsTicket[]>
}
export const dms: DmsAdapter & { simulate?: (m: MockMode) => void }   // 单例；DMS_MODE=real 时抛"未实现"，提示接口可得后替换
```

单测：normal 创建两次同 caseId 返回同 ticketNo 且表中只有一行；unavailable 返回 kind；advance 状态机顺序；`getTicket('nope')` → not_found；account_cancelled 结果不是异常而是业务结果（`ok:false, kind:'account_cancelled'`）。

- [ ] Step 1～5 同 Task 2 流程；提交 `feat(dms): adapter contract and mock implementation with failure injection`。

---

### Task 4: 路由 `routes/cases.ts`（替换 `tickets.ts`）+ 会话/总览/大屏/报表/鉴权联动

**Files:**
- Delete: `apps/api/src/routes/tickets.ts`
- Create: `apps/api/src/routes/cases.ts`
- Modify: `apps/api/src/server.ts`（注册 `caseRoutes`；`/api/overview` 的 `tickets` → `cases` + `handoffsPending`）
- Modify: `apps/api/src/routes/conversations.ts`（`/ticket` → `/case`；详情返回 `cases` 与 `handoffTask`；control：`handoff` 创建任务、`takeover` 认领活动任务、`close` 取消活动任务）
- Modify: `apps/api/src/routes/management.ts`（大屏 `openTickets/overdueTickets` → `pendingHandoffs/overdueHandoffs`；报表数据集 `tickets` → `cases`，维度 type/status/priority/assignee/day/source，指标 count / `linked_ratio`）
- Modify: `apps/api/src/services/auth.ts`（规则：`/api/cases`、`/api/handoffs` admin+agent；`/api/dms/(simulate|mock|retry-pending)` admin）
- Create: `apps/api/test/cases.api.test.ts`（Fastify inject）

**Endpoints:**

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/cases?status&priority&type&assignee` | 列表，排序 P0>P1>P2, created_at desc |
| GET | `/api/cases/stats` | byStatus / byPriority / dmsPending / total |
| GET | `/api/cases/:id` | 详情 |
| POST | `/api/cases` | 手工创建（可带 conversationId） |
| PATCH | `/api/cases/:id` | `status ∈ {in_progress, archived}`、assignee、priority、note；`linked_dms` 不能由 PATCH 设置 |
| POST | `/api/cases/:id/dms/link` | 调 `dms.createTicket`：ok → status `linked_dms` + dms 字段；`unavailable` → `dms_pending=1`、history "DMS 不可用，转为待同步案件"；`rejected/account_cancelled` → `dms_last_error`，状态不变，history 记原因 |
| POST | `/api/cases/:id/dms/attach` `{ticketNo}` | 坐席回填工单号：`getTicket` 成功才关联；not_found → 400 |
| POST | `/api/cases/:id/dms/refresh` | `getTicket` 回读 `dms_status`/`dms_synced_at` |
| POST | `/api/dms/retry-pending` | 对所有 `dms_pending=1` 的子案件重试 link；返回 `{retried, linked, stillPending}` |
| GET | `/api/dms/health` | 适配器 kind/mode |
| POST | `/api/dms/simulate` `{mode}` | admin；写审计 |
| GET | `/api/dms/mock` / POST `/api/dms/mock/:ticketNo/advance` | admin |
| GET | `/api/handoffs?status` | 列表：pending 先、P0>P1>P2、created_at asc |
| GET | `/api/handoffs/stats` | pendingByPriority / claimed / overdue（`due_at < now` 且 pending） |
| POST | `/api/handoffs/:id/claim` | 认领 = 接管会话（actor = 登录用户） |
| POST | `/api/handoffs/:id/done` `{note}` | 完成 |
| POST | `/api/handoffs/:id/case` | 从任务拆子案件：title=会话标题，evidence 来自 progress，status `pending_human`，回写 `case_id` |

`toCase(row)`、`caseFromInput()` 两个纯函数放在 `cases.ts` 顶部；子案件编号 `CS-YYYYMMDD-XXXX`。

inject 测试（`process.env.LLM_MOCK='1'; process.env.DATA_DIR=':memory:'` 后动态 import `buildServer`，`initDb`，`seed(true)`，登录 admin 取 cookie）：创建子案件 → link（normal）→ `linked_dms` 且 `dms.ticketNo` 匹配 `^DMS-`；`simulate unavailable` → 新子案件 link → `dms.pending=true`；`simulate normal` → `retry-pending` → `stillPending=0`；`attach` 一个不存在的单号 → 400；handoff：`ensureHandoffTask` 后 `GET /api/handoffs` 有 pending，`claim` 后会话 `controller=human`。

- [ ] Step 1 写 inject 测试；Step 2 失败；Step 3 实现路由与联动；Step 4 `pnpm -r typecheck` api 零错误、测试通过；Step 5 提交 `feat(api): cases/handoffs/dms routes; conversation, overview, dashboard, reports and auth wired to sub-cases`。

---

### Task 5: 执行链联动（agent-core 可选钩子 + chain.ts）

**Files:**
- Modify: `packages/agent-core/src/pipeline.ts`
  - `ChainContext` 增 `responseWindow?: (priority: Priority) => string`
  - 第 9 阶段：`const etaText = ctx.responseWindow ? ctx.responseWindow(p) : eta[p]`，文案改为 `……已为您转接人工客服（优先级 ${p}），${etaText}。人工上线后会直接接续本次对话，无需重复描述。` / `……正在由人工客服核实后回复您（优先级 ${p}），${etaText}，请稍候。`；降级分支同样用 `etaText`
  - `tickets.create` → `cases.create`（`ctx.tools.get/execute`）；自动动作文案 `（已为您登记跟进事项，编号 ${id}）`
- Modify: `packages/agent-core/src/pipeline.ts` 导出 `ChainContext` 类型已存在，只加字段
- Modify: `apps/api/src/services/chain.ts`
  - 工具 `tickets.create` → `cases.create`：插入 `cases`（status `pending_human`，source `chain`，evidence 由参数 `facts/slots` 组装），返回 `{ id, type }`
  - `runForConversation`：`ctx.responseWindow = (p) => windowSentence(p)`；`runChain` 后若 `decision !== 'auto_reply'`：`ensureHandoffTask({ conversationId, channel: conv.channel, priority, reason: trace.autonomy.reasons.join('；'), progress: { doneStages: trace.stages.filter(ok).map(id), evidence: trace.evidence?.items.filter(ok).map(i=>i.id) ?? [], missing: trace.slots.filter(missing).map(key), candidate: reply.candidate, failure: null, nextAction: decision==='human_confirm' ? '核实候选话术后发送' : '接续会话并处理诉求' }, traceId: trace.id })`；系统消息里附任务号
  - `runStandalone` 沙箱：`cases.create` 仍替换为 SANDBOX
- Modify: `packages/agent-core/test/*`（如有引用 `tickets.create` 的用例改名）

- [ ] Step 1 改 pipeline 与 chain；Step 2 `pnpm -r typecheck`、`pnpm test`（agent-core 12 条）；Step 3 本机发一句"你们太差了，我要去 12315 投诉"验证：访客端回复含"预计 … 开始接续"、`/api/handoffs` 出现 P1 pending；Step 4 提交 `feat(chain): auto handoff task on non-auto decisions; calendar-based response window in reply; cases.create tool`。

---

### Task 6: 前端 —— `Cases.tsx`（三 Tab）、在线客服联动、导航/总览/大屏/报表文案

**Files:**
- Delete: `apps/web/src/pages/reception/Tickets.tsx`
- Create: `apps/web/src/pages/reception/Cases.tsx`
- Modify: `apps/web/src/App.tsx`（路由 `/reception/cases`）、`apps/web/src/layout/AppLayout.tsx`（key `/reception/cases`，label `工单协作`）
- Modify: `apps/web/src/pages/reception/OnlineService.tsx`（"生成工单"→"生成子案件"，POST `/case`；详情 Tab "子案件 n"；聊天区顶部显示活动接续任务条：优先级、时窗、`pending` 时"认领并接管"按钮）
- Modify: `apps/web/src/pages/Overview.tsx`（`tickets` → `cases`，文案"待处理子案件"；新增"待接续任务"）
- Modify: `apps/web/src/pages/management/Dashboard.tsx`（tile "待接续任务 / 超时 n"）
- Modify: `apps/web/src/pages/management/Reports.tsx`（`cases: '子案件'`）
- Modify: `apps/web/src/pages/reception/Deferred.tsx`、`apps/web/src/pages/ai/Aigc.tsx` 文案（"工单系统"→"子案件与 DMS 关联"，"工单生成"→"子案件生成"）

**Cases.tsx 结构：**
- 页头：`工单协作 · 子案件与人工接续任务`，desc：`正式售后工单在 DMS；本平台只持有子案件、证据、接续任务与关联轨迹（CS-003 / CS-016）`。
- KPI 行：待接续任务 / 超时接续 / 待人工子案件 / 处理中 / 已关联 DMS / 待同步。
- Tab「接续任务」：表格列 任务号、优先级、会话（标题 + 渠道）、原因、预计响应（`dueAt` 过期红字"超时"）、状态、认领人；行操作：`认领并接管`（pending）→ 成功后 `navigate('/reception/online?conv=' + conversationId)`；`完成`（claimed）；`拆为子案件`（无 caseId 时）。展开行显示 progress（已完成阶段 / 证据 / 缺项 / 候选话术 / 下一步）。
- Tab「子案件」：表格 + Drawer。Drawer：状态/优先级/处理人操作；证据卡（slots、facts、trace 链接）；**DMS 区块**：未关联 → 按钮 `关联 DMS（自动建单）` 与折叠的 `回填 DMS 工单号` 输入；`dms.pending` → 橙色 Tag `待同步案件` + 最近错误；已关联 → 单号 + 状态 Tag + `刷新状态`。状态按钮：`开始处理`（pending_human→in_progress）、`归档`（任何非 archived）。不提供"解决/关闭"。
- Tab「DMS 模拟」（仅 admin 可见，`useAuth().can('admin')` 或按角色判断）：当前模式 Select（normal / unavailable / reject / account_cancelled / slow）、`重试待同步` 按钮、模拟票据表（单号、子案件、状态、`推进状态` 按钮）。
- e2e 选择器约定：Tab 文案精确 `接续任务` / `子案件` / `DMS 模拟`；表格行 `data-testid="case-row"` / `"handoff-row"`；DMS 单号元素 `className="dms-no"`。

- [ ] Step 1 实现页面与联动；Step 2 `pnpm --filter @eight/web typecheck` 与 `build`；Step 3 浏览器手工核对三 Tab；Step 4 提交 `feat(web): cases/handoff/DMS-mock workbench replaces tickets page; online service shows active handoff`。

---

### Task 7: e2e 与文档

**Files:**
- Modify: `e2e/helpers.ts`（ROUTES：`/reception/cases` heading `/工单协作|子案件/`）
- Modify: `e2e/auth.spec.ts`（路径与 API 改为 cases）
- Modify: `e2e/modules.spec.ts`（替换"工单"用例）
- Create: `e2e/cases.spec.ts`
- Modify: `docs/ARCHITECTURE.md`、`docs/EXECUTION-CHAIN.md`、`docs/LOOP-LOG.md`（L11）、`README.md`

**`cases.spec.ts` 用例：**
1. 子案件 → DMS 关联（正常）：`/reception/cases` → 子案件 Tab → 新建 → Drawer `开始处理` → `关联 DMS（自动建单）` → 出现 `.dms-no` 匹配 `/^DMS-/` 与 Tag `已关联 DMS` → `归档`。
2. DMS 不可用 → 待同步 → 重试：API 设 `simulate unavailable` → 新建子案件并 link → Tag `待同步案件`；设 `normal` → DMS 模拟 Tab `重试待同步` → 该子案件变 `已关联 DMS`。
3. 转人工产生接续任务并可认领：访客端 `/visitor` 发送"你们太差了，我要去 12315 投诉" → 机器人回复含 `预计` 与 `开始接续` → `/reception/cases` 接续任务 Tab 出现 P1 `pending` 行 → `认领并接管` → 跳转在线客服且该会话 `controller=human`（页面显示人工接待标识）→ 回到接续任务 Tab 该行 `claimed`。
4. 同会话二次触发不新建任务（API 断言：访客再发一句投诉 → `GET /api/handoffs?status=pending|claimed` 中该会话仍只有 1 条）。

文档：ARCHITECTURE 产品结构表"工单系统" → "工单协作（子案件 / 接续任务 / DMS 关联）"，新增"子案件与 DMS 边界"小节；EXECUTION-CHAIN 第 8/9 阶段说明接续任务与日历时窗；LOOP-LOG L11；README 路线与目录更新。

- [ ] Step 1 更新 helpers/auth/modules；Step 2 写 `cases.spec.ts`；Step 3 `pnpm --filter @eight/api seed -- --force` 重置开发库后 `pnpm e2e` 全绿；Step 4 文档；Step 5 提交 `test(e2e): cases/handoff/DMS flows; docs L11`。

---

## Self-Review

- CS-016 覆盖：改名 ✔（Task 1/4/6）；只保留"关联 DMS"写法 ✔（Task 4 link/attach/refresh）；四个本地状态 ✔；待同步案件 ✔（`dms_pending`）；模拟适配器同契约 ✔（Task 3，`kind: 'mock' | 'real'`）。
- CS-008E/G/I 覆盖：接续任务字段（进度、缺项、失败原因、下一步、定位标识）✔；日历 + 档位时窗 ✔（Task 2）；P0/P1/P2 目标 ✔；P0 告警回执文案条件 ✔（`alertDelivered` 参数，告警投递本身留空实现为 `alert=null`，在 LOOP-LOG 标注 CS-008H 待做）。
- CS-008F 局部覆盖：同会话单活动任务 ✔；跨渠道强锚点关联 ✗（超出本计划，登记待做）。
- 类型一致性：`HandoffProgress` 在 Task 1 定义、Task 2 `ensureHandoffTask` 与 Task 5 chain 使用同字段；`DmsResult` 在 Task 3 定义、Task 4 路由消费 `kind`；`CaseStatus` 四值在 Task 4 PATCH 校验与 Task 6 UI 一致。
