# 核心业务执行链

每一次机器人应答（在线机器人、呼入机器人接入点、坐席「AI 建议」、Agent Studio 测试台、数字员工试跑、Benchmark）都完整走一遍下面九个阶段，并把每阶段的输入/输出/耗时/模型用量写入 `traces` 表，前端 `TraceViewer` 原样展示。实现：`packages/agent-core/src/pipeline.ts`（`runChain`）。

| # | 阶段 | 做什么 | 关键实现 | 何时调用模型 |
|---|---|---|---|---|
| 1 | 用户输入 | 规范化文本、统计轮次/机器人已答轮次、取最近 12 条对话窗口、规则识别寒暄/致谢/要求人工/强制转人工关键词 | `GREETING`/`THANKS`/`HUMAN_REQUEST` 正则 + `agent.handoffRules.keywords` | 否 |
| 2 | 信息补全 | 正则从本轮与历史用户消息抽订单号/运单号/手机/金额/税号；沿用上一轮 trace 的槽位；CRM 补手机号与客户等级。每个槽位记录来源（regex/history/crm/llm/missing） | `completion` 阶段；`Slot.source` | 否 |
| 3 | 意图/场景识别 | 快模型（thinking 关闭，~1s）在 Agent 启用的场景包中选一个，输出意图、置信度、实体、风险信号（complaint/legal/safety/urgent/vip…）、是否需人工；合并实体到槽位；按场景包标出缺失的必填槽位 | `IntentSchema`（zod）+ `chatJson` 校验重试 | 是（寒暄/致谢除外） |
| 4 | 证据获取 | 按场景包声明的工具逐个执行（仅当 `requires` 槽位齐全且在 Agent 授权范围内）；记录每次调用的参数/结果/耗时；计算业务证据完整度 | `ToolRegistry.execute`，工具由 API 层注入（订单/物流/发票/退款/差价/CRM/目录） | 否 |
| 5 | 知识/工具调用（检索） | 查询 = 当前问题 + 意图 + 实体；BM25（中文二元组）+ 场景标签加权；弱命中且开启 `rewriteOnMiss` 时让快模型结合上下文补全省略实体改写 1~3 个查询再检索并合并 | `BM25Index.search`、`RewriteSchema` | 弱命中时是 |
| 6 | 推理与根因判断 | 推理模型（thinking 开启、`reasoning_effort` 可配）依据证据+知识输出：根因、分析、对客话术、引用（只能引用给出的 `kb:`/`tool:` id）、动作提案、是否需人工、自评置信度；无效引用被剔除并计入风险；必填缺失时强制改为追问 | `ReasonSchema`；引用白名单校验 | 是 |
| 7 | 风险分级 | 四维信号（意图置信、证据完整度、检索置信、规则确定度）+ 规则：资金/权益动作 ≥L2；投诉/法律/安全 =L3；话术含证据中不存在的金额 L2；声称已完成未执行的动作 L2；售前无知识作答 L2；工具失败 L2；意图置信 <0.5 L2/<0.7 L1；纯追问 L0 | `risk` 阶段 | 否 |
| 8 | 自主处理 / 人工确认 / 升级 | 用户要求人工 → 升级；L3 → 升级（safety/legal 为 P0，否则 P1）；机器人连续轮次超阈值 → 升级；模型提案 handoff → 升级；白名单场景 且 风险 ≤ min(Agent 上限, 场景包上限) 且 动作在场景包允许列表 → 自主回复（允许时执行 `create_ticket`）；否则人工确认（VIP/紧急 P1，其余 P2） | `autonomy` 阶段 | 否 |
| 9 | 最终回复 | 产出两份文本：`reply.text` = **实际对客发送**（自主回复 = 候选话术并附自动执行结果；人工确认 = 带优先级/时窗的等待核实提示；升级 = 转接话术），`reply.candidate` = 推理阶段的候选话术，供坐席审核采用；同时生成内部备注（人工确认/升级时含候选话术） | `reply` 阶段 | 否 |

## 与业务系统的关系

- **场景包 = 数字员工**（`packages/agent-core/src/scenarios.ts`）：`logistics` 物流智能体、`invoice` 发票智能体、`refund_price_diff` 退款/差价智能体、`presale` 售前、`complaint` 投诉（自治上限 L0）、`general` 通用。新增一个售后能力 = 新增一个场景包 + 需要的工具。
- **工具**（`apps/api/src/services/chain.ts`）：当前接的是 SQLite 中的模拟业务数据（订单、物流轨迹、发票、退款、保价核算、CRM、商品目录）。接真实 ERP/WMS/DMS 时只替换工具的 `run`，链与页面不变。
- **动作工具**（`mutating: true`，如 `tickets.create`）只在第 8 阶段被自治门禁放行后执行；退款/补发/开票类动作永远不会自动执行，只形成「待人工确认」的提案。

## 会话落库规则（`runForConversation`）

- 机器人接待（`controller = bot`）：对客消息**永远等于 `trace.reply.text`**（单一来源）。`auto_reply` → 追加候选话术；`human_confirm` / `escalate` → 会话转 `waiting_human`，对客发送等待/转接提示，并以系统内部消息保存内部备注与候选话术供坐席在工作台一键采用。访客端（`/visitor`）只显示非 system 消息。
- 坐席辅助（`assist`）：不落消息，只返回带依据的建议，坐席可一键采用到输入框。
- 每个 trace 记录 Agent 版本、模型用量、总耗时，`Benchmark` 用同一函数在沙箱中跑冻结评测集。
