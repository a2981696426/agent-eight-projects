# 架构说明

## 产品结构（对照网易云商「AI 客服」导航）

| 分组 | 网易云商模块 | 本项目页面 | 状态 |
|---|---|---|---|
| 系统基座 · 服务接待 | 在线客服 | `/reception/online` 坐席工作台（会话列表 / 聊天主区 / 客户 360 三栏，接管、转接、AI 建议、小记、分类、建单） | 可用 |
| | 呼叫中心 | `/reception/call-center` | 暂缓（占位 + 接入依赖说明） |
| | 视频客服 | `/reception/video` | 暂缓 |
| | 工单系统 | `/reception/tickets` | 可用 |
| 智能增强 | 在线机器人 | `/ai/online-robot` 访客端 + 执行链透视 | 可用 |
| | 呼入机器人 | `/ai/inbound-robot` IVR 流程编辑 + 文本模拟来电接入执行链 | 可用（无线路/ASR） |
| | AI 外呼 | `/ai/outbound` 任务/名单/话术，大模型模拟外呼结果回写 | 可用（模拟） |
| | AIGC 应用 | `/ai/aigc` 小记、分类、工单抽取、应答建议、润色、FAQ 抽取、相似问 | 可用 |
| | Agent Studio | `/ai/agent-studio` 配置、测试台、Benchmark、版本/回滚 | 可用 |
| | Mind Studio | `/ai/mind-studio` 资料、切块、发布、检索测试、批量导入、FAQ 抽取、使用追溯 | 可用 |
| 服务管理 | 智能质检 | `/management/quality` 规则 + 语义质检、人机对比、复核 | 可用 |
| | 自定义报表 | `/management/reports` 数据集 × 维度 × 指标，图表联动，保存 | 可用 |
| | 数据大屏 | `/management/dashboard` 深色大屏，15s 刷新 | 可用 |
| | 客户之声 | `/management/voc` 主题/情绪/热词/预警、自然语言提问、下钻 | 可用 |
| 智能体 | 售后服务数字员工 | `/employees` 物流 / 发票 / 退款差价三智能体 = 三场景包 | 可用 |
| AI 私域 | AI 私域 / SCRM / 私域数字员工 | `/private-domain` | 骨架占位，复用 AI 外呼 |

## 技术栈

- **Monorepo**：pnpm workspace（`apps/api`、`apps/web`、`packages/agent-core`、`packages/shared`）
- **后端**：Node ≥22.13、Fastify 5、TypeScript（tsx 直跑）、`node:sqlite`（零依赖嵌入式库，WAL）、zod 4
- **执行链**：`@eight/agent-core` 纯 TypeScript，无框架依赖；LLM 客户端用 fetch 直连兼容 OpenAI 协议的端点（默认 DeepSeek，透传 `thinking` / `reasoning_effort`）
- **前端**：React 19、Vite 7、Ant Design 5（+ React 19 兼容补丁）、ECharts 5、react-router 7
- **验证**：node:test 单测（agent-core）+ Playwright（系统 Chrome）全页面零控制台错误 + 真实大模型业务流

## 分层

```
┌ apps/web ──────────────────────────────────────────────────────────────┐
│ AppLayout（顶部 AI 客服 / AI 私域 · 左侧四组导航）→ 17 个页面 → TraceViewer │
└──────────────────────────── /api（Vite 代理）───────────────────────────┘
┌ apps/api ──────────────────────────────────────────────────────────────┐
│ routes/conversations  tickets  knowledge  agents  aigc  bots  management│
│ services/chain（工具注册、知识索引、会话落库、沙箱试跑） services/aigc     │
│ db（SQLite 建表/迁移）  seed（演示数据：客户/订单/物流/发票/退款/知识/会话）│
└────────────────────────────────────────────────────────────────────────┘
┌ packages/agent-core ───────────────────────────────────────────────────┐
│ pipeline.runChain（九阶段） llm（fast/reasoning 双模式） retrieval（BM25）  │
│ tools（注册表/审计包装） scenarios（场景包 = 数字员工）                     │
└────────────────────────────────────────────────────────────────────────┘
┌ packages/shared ─── 前后端共享类型（Trace/Conversation/Ticket/Agent…）──┘
```

## 关键设计决策

1. **规则先行、模型分层**：寒暄不调模型；分类/抽取用关闭思考的快模式（~1s）；只有根因推理用思考模式。单次完整链路典型 8~14s、2 次模型调用、3~5k tokens。
2. **引用白名单**：模型只能引用本次给出的 `kb:`/`tool:` id，越界引用被剔除并计入风险；话术中出现证据里没有的金额、或声称已完成未执行的动作，直接抬升风险等级。
3. **分层可信度而非单一置信度**：意图置信、证据完整度、检索置信、规则确定度四个信号分别展示，人工能定位建议可能出错的环节。
4. **自治 = 白名单 × 风险上限 × 动作许可**：三者同时满足才自主回复；资金/权益动作永不自动执行。
5. **一切可回放**：trace 绑定 Agent 版本；Benchmark 用冻结用例比较版本；知识块记录被哪些 trace 引用。
6. **模拟业务系统只在工具层**：订单/物流/发票/退款查询全部是 `ToolRegistry` 里的函数，替换为真实系统不影响链和页面。

## 已知边界

- 呼叫中心、视频客服按规划暂缓；呼入机器人与 AI 外呼没有真实线路，分别用文本模拟来电和大模型模拟外呼结果。
- 检索为词法（BM25 + 二元组 + 改写重检），未接向量库；知识规模上千段后建议引入 embedding 混合召回。
- 单机 SQLite，无多租户/账号体系；权限与审计只有 `audit_log` 记录。
- 大模型输出存在非确定性；Benchmark 用于观察版本间趋势，不是一次通过即宣称能力成熟。
