# 架构说明

## 产品结构（对照网易云商「AI 客服」导航）

| 分组 | 网易云商模块 | 本项目页面 | 状态 |
|---|---|---|---|
| 系统基座 · 服务接待 | 在线客服 | `/reception/online` 坐席工作台（会话列表 / 聊天主区 / 客户 360 三栏，接管、转接、AI 建议、小记、分类、建单） | 可用 |
| | 呼叫中心 | `/reception/call-center` | 暂缓（占位 + 接入依赖说明） |
| | 视频客服 | `/reception/video` | 暂缓 |
| | 工单协作（子案件 / 人工接续任务 / DMS 关联） | `/reception/cases` 三 Tab：接续任务（认领=接管会话）、子案件（关联 DMS / 回填 / 回读、待同步案件）、DMS 模拟（管理员：失败注入、重试待同步、推进状态） | 可用（DMS 为模拟适配器） |
| 智能增强 | 在线机器人 | `/ai/online-robot` 访客端 + 执行链透视；`/visitor` 独立访客端（客户视角，记住会话、轮询人工回复、结束评价） | 可用 |
| | 呼入机器人 | `/ai/inbound-robot` IVR 流程编辑 + 文本模拟来电接入执行链 | 可用（无线路/ASR） |
| | AI 外呼 | `/ai/outbound` 任务/名单/话术，大模型模拟外呼结果回写 | 可用（模拟） |
| | AIGC 应用 | `/ai/aigc` 小记、分类、子案件字段抽取、应答建议、润色、FAQ 抽取、相似问 | 可用 |
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
- **后端**：Node ≥22.13、Fastify 5、TypeScript（tsx 直跑）、PostgreSQL 方言数据层（生产 `pg` → PostgreSQL 16 + pgvector；本机/测试 PGlite 进程内 Postgres，零外部依赖）、zod 4
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
│ db（pg / PGlite 双驱动、?→$n、幂等迁移） seed（演示数据：客户/订单/物流/发票/退款/知识/会话）│
└────────────────────────────────────────────────────────────────────────┘
┌ packages/agent-core ───────────────────────────────────────────────────┐
│ pipeline.runChain（九阶段） llm（fast/reasoning 双模式） retrieval（BM25）  │
│ tools（注册表/审计包装） scenarios（场景包 = 数字员工）                     │
└────────────────────────────────────────────────────────────────────────┘
┌ packages/shared ─── 前后端共享类型（Trace/Conversation/Ticket/Agent…）──┘
```

## 发布形态与安全（L9）

- **登录与角色**：`services/auth.ts`，scrypt 密码哈希 + 服务端会话 + 签名 httpOnly Cookie；三角色 admin / agent / analyst；`onRequest` 钩子统一鉴权，公开接口只有健康检查、登录与访客端最小集合；越权写操作 403 并写审计。前端 `RequireAuth` 路由守卫 + 角色隐藏发布/演练按钮。演示账号见登录页。
- **单端口生产模式**：`SERVE_WEB=1` 时 API 用 `@fastify/static` 托管 `apps/web/dist`，非 `/api` GET 回退 `index.html`。
- **容器化**：`Dockerfile` 多阶段（依赖 → 构建前端 → 精简运行），`docker-compose.yml` 含 `postgres`（`pgvector/pgvector:pg16`，healthcheck）与 `ai-service`，读取 `.env`。
- **模型高可用**：`LlmRouter` 主/备 provider、重试、熔断、自动切换、规则降级（见 EXECUTION-CHAIN）。

## 自治门禁与医疗边界（L14，CS-015 / ADR-0042 / CS-008B）

- **签发白名单**：`whitelists(scope, version, status, items[{scenario, maxRisk}])`，`draft → signed（售后负责人）→ published（平台管理员，自动停用同 scope 旧版本）→ disabled（即时）`。`services/whitelist.ts` 的 `whitelistFor(channel)` 生成 `ChainContext.whitelist` 钩子：**owned**（web/app/wechat）全时段按 items 判定；**platform**（天猫等）工作时段一律拒绝（辅助模式），非工作时段按 items；无 published 版本默认拒绝。自治阶段 `允许自动 = 白名单允许(场景, 风险) ∧ 风险 ≤ min(Agent, 场景包) ∧ 动作在场景包允许列表`；`autonomy.whitelistVersion` 记入 trace，TraceViewer 显示。Agent 配置里的 `whitelistScenarios` 只在未注入钩子（单测）时作为回退。
- **医疗边界**：`agent-core/medical.ts`——`detectMedicalRequest`（用药/剂量/诊断/饮食治疗/就医判断；紧急症状另标 `safety`）在意图阶段打 `medical` 标记；`containsMedicalAdvice` 在风险阶段守卫模型话术（越界 → `medical_advice_in_draft`，L3）；回复阶段用固定文案 `MEDICAL_BOUNDARY_TEXT` / `MEDICAL_EMERGENCY_TEXT`（kind=`boundary`，候选话术同样替换，避免坐席误采用），非紧急 → human_confirm 并立即发送边界文案，紧急 → escalate P0。
- **发布门禁**：`benchmark_cases.category='medical_boundary'`（10 例，`expected_guard='no_medical_advice'`），Benchmark 报告 `medicalBoundaryPass` 与 `releaseGate`（必须 100%）；Agent Studio 评测页显示守卫列与门禁状态。

## 知识检索（L13，CS-017）

- **检索器契约**：`agent-core` 的 `Retriever { size, mode, search() }`，`BM25Index` 与宿主的 `HybridRetriever`（`services/retriever.ts`）都实现它，执行链 `ChainContext.index` 注入后者；trace 第 4 阶段 detail 记录 `mode: 'bm25' | 'hybrid'`。
- **向量**：`knowledge_vectors(chunk_id, provider, model, dims, embedding vector(N))`（pgvector，PGlite 与 `pgvector/pgvector:pg16` 都可用）；`services/embeddings.ts` 的 `EmbeddingProvider`——OpenAI 兼容实现（首选混元 `hunyuan-embedding` 1024 维，备用百炼 `text-embedding-v4`）与确定性 Mock（词法哈希，离线用）。向量化前 `scrubForEmbedding` 脱敏（手机号 / 订单号 / 序列号 / 邮箱）。
- **融合**：BM25 与向量并行；`score = min(1, 词法 + 0.6 × 余弦相似度)`——词法基线 + 语义增益，词法满分不被稀释（离线对比显示固定 0.4/0.6 加权会把满分压到 0.45～0.66，误触改写与"售前无知识"风险）；只在语义侧命中的同义问句以 0.6×sim 进入候选。供应商失败 60 s 熔断，期间退回纯 BM25。
- **向量化作业**：pg-boss `knowledge.embed`（发布 / 重切块 / 导入后入队；启动时补齐缺失块）；`POST /api/knowledge/reindex-vectors`（管理员）换供应商后全量重建；`/api/knowledge/stats.vectors` 报 provider / model / count / coverage / mode。
- **导入**：`/api/knowledge/import` 支持 `text`、`faq-csv`（云商导出：标准问 / 答案 / 相似问 / 分类 / 标签，中英表头自动映射，相似问写入正文）、`faq-json`；Mind Studio 提供格式选择与文件上传。

## 渠道接入（L12，CS-012 / CS-014）

- **渠道适配器契约**（`services/channels.ts`）：`ChannelAdapter { channel, capabilities, send(externalUserId, text), health() }`。适配器只做协议、授权、限流、会话与错误语义；意图、知识、规则与回复决策全部在统一客服 Agent。入站以 `(channel, externalMsgId)` 幂等（`channel_messages`），外部身份映射到演示客户档案（`channel_identities`，不与 UMS/佩戴用户合并），24 小时内未结束的同渠道会话复用；机器人接待走执行链，人工接待只落库（单一响应者）。投递结果如实写回 `messages.meta.delivery`（`sent / failed / skipped / queued`），不伪造送达。
- **异步作业**（`services/jobs.ts`，pg-boss）：`channel.inbound`（Webhook 先 ack 再处理）与 `channel.deliver`（出站，重试 5 次指数退避；不可重试失败如 48 小时窗口过期直接如实记录并给坐席系统消息）。PGlite 用 `fromPglite` 共享同一实例，生产用 PostgreSQL 连接串；不引入 Redis（CS-013）。坐席回复也经同一队列投递。
- **微信公众号 / 测试号**（`channels/wechat.ts`、`routes/channels.ts`）：`GET /api/channels/wechat/webhook` 签名校验回 echostr；`POST` 校验签名（安全模式再校验 `msg_signature` 并 AES-256-CBC 解密）→ XML 归一化（text / image / subscribe）→ 入队 → **立即** 回 `success`（5 秒约束）。客服消息发送带 access_token 缓存与失效重取；`45015` → `window_expired`（不可重试）、`45047` → `rate_limited`。未配置 AppID 或 `WECHAT_MOCK=1` 时为 mock：不出网，发送记录见 `GET /api/channels/wechat/mock/sent`。
- **官网嵌入**（`apps/web/public/embed.js`）：一行 `<script>` 注入右下角浮动按钮与 iframe，加载同源 `/visitor?embed=1&channel=web&site=…`；访客端 embed 模式无外框、匿名自动开始，会话记在 iframe 本地存储。演示页 `/embed-demo.html`。web 渠道无出站适配器（访客端轮询），投递记为 `skipped`。
- **容量**：见 `docs/LOAD-TEST.md`——200 VU 下平台开销 p95 ≈ 1 s（单进程 CPU 满载），真实模型执行链 p95 ≈ 12 s；门禁 15 s 通过但余量约 20%。
- **未做**：微信图片消息的媒体下载（只记录 MediaId/PicUrl）、被动回复（全部走客服消息）、小程序客服消息、App 原生 SDK（按 CS-014 用 WebView 加载访客 H5）。

## 子案件、人工接续任务与 DMS 边界（L11，CS-003 / CS-008E-I / CS-016）

- **DMS 是正式售后工单唯一权威**：本平台只持有 **子案件**（`cases`：单一服务目标的事实、证据包、协作轨迹）与 **人工接续任务**（`handoff_tasks`：Agent 无法完成时的内部待办），通过 `services/dms.ts` 的 `DmsAdapter` 契约创建/关联 DMS 工单并回读状态；本地状态只有 待人工 / 处理中 / 已关联 DMS / 已归档，没有"已解决 / 已关闭"。
- **DMS 适配器**：`MockDmsAdapter`（默认，`DMS_MODE=mock`）与将来的真实实现共用同一契约；失败是业务结果（`unavailable` → 待同步案件、`rejected` / `account_cancelled` → 记录原因不改状态、`not_found` → 回填被拒）。建单以子案件 id 为幂等键。所有 DMS 写入都由坐席按钮触发，执行链只会 `cases.create` 拆本地子案件。
- **人工接续任务**（`services/handoff.ts`）：执行链决策为 `human_confirm` / `escalate`、或坐席「转接」时创建；保存已完成阶段、证据、缺项、候选话术、失败原因、下一步；同一会话同一时刻只有一个活动任务（重复触发追加进度、优先级只升不降、沿用最早创建时间）；认领 = 接管会话（单一响应者）；会话结束或转回机器人时取消。
- **预计人工响应时窗**：工作日历（`WORK_HOURS` / `WORK_DAYS` / `HOLIDAYS`，本地时区）+ 档位：P0 15 自然分钟、P1 2 工作小时、P2 1 个工作日（按工时折算）。文案只表示"预计开始接续"，P0 未取得告警回执时不说"已优先通知专人"。同一函数通过 `ChainContext.responseWindow` 注入最终回复，与任务上记录的一致。
- **未做**：P0 轮值告警投递（CS-008H，`alert` 字段预留）、跨渠道强锚点关联（CS-008F）、真实 DMS 适配器（接口授权中）。

## 数据层（L10，CS-013 / ADR-0041）

- **唯一持久化 PostgreSQL**：`apps/api/src/db.ts` 提供 `SqlDriver` 抽象——`DATABASE_URL` 非空走 `pg` 连接池（生产），为空走 PGlite（进程内 Postgres，数据在 `data/pglite/`，`DATA_DIR=:memory:` 为内存库供单测）。两者跑同一套 Postgres 方言 SQL，本机与生产行为一致。
- **`Db` 薄封装**：异步 `all/get/run/tx/count`；保留 `?` 占位符写法，驱动层转 `$n`；int8/numeric 统一解析为 number；`tx(fn)` 回调拿到绑定单连接的 `Db`。
- **迁移**：启动时执行幂等 DDL（`CREATE TABLE/INDEX IF NOT EXISTS`、`ADD COLUMN IF NOT EXISTS`、`CREATE EXTENSION IF NOT EXISTS vector`）。
- **备份**：`scripts/backup-db.sh`（每日 `pg_dump -Fc`，保留 30 天，可选上传 COS）、`scripts/restore-db.sh`（恢复到临时库后原子换名）；操作见 `docs/RUNBOOK.md`。
- **预留**：pgvector 供混合检索（CS-017）；pg-boss 作业队列（同库，不引入 Redis）在异步作业计划中接入。

## 关键设计决策

1. **规则先行、模型分层**：寒暄不调模型；分类/抽取用关闭思考的快模式（~1s）；只有根因推理用思考模式。单次完整链路典型 8~14s、2 次模型调用、3~5k tokens。
2. **引用白名单**：模型只能引用本次给出的 `kb:`/`tool:` id，越界引用被剔除并计入风险；话术中出现证据里没有的金额、或声称已完成未执行的动作，直接抬升风险等级。
3. **分层可信度而非单一置信度**：意图置信、证据完整度、检索置信、规则确定度四个信号分别展示，人工能定位建议可能出错的环节。
4. **自治 = 白名单 × 风险上限 × 动作许可**：三者同时满足才自主回复；资金/权益动作永不自动执行。
5. **一切可回放**：trace 绑定 Agent 版本；Benchmark 用冻结用例比较版本；知识块记录被哪些 trace 引用。
6. **模拟业务系统只在工具层**：订单/物流/发票/退款查询全部是 `ToolRegistry` 里的函数，替换为真实系统不影响链和页面。

## 已知边界

- 呼叫中心、视频客服按规划暂缓；呼入机器人与 AI 外呼没有真实线路，分别用文本模拟来电和大模型模拟外呼结果。
- 混合检索的语义分量在本机/e2e 用的是词法哈希 Mock 向量，只验证链路不代表真实召回；真实效果需配置混元/百炼后用真实用例复测。
- 单机 PostgreSQL，无多租户；账号体系为三角色本地用户，审计只有 `audit_log` 记录。
- 大模型输出存在非确定性；Benchmark 用于观察版本间趋势，不是一次通过即宣称能力成熟。
