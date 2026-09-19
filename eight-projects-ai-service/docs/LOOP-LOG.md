# Loop Engineering 记录

每个循环：构建 → 浏览器/接口验证 → 发现问题 → 立即修复 → 提交。验证一律使用系统 Chrome 下的 Playwright，断言「0 条 console.error / pageerror / 4xx-5xx 接口」。

| Loop | 范围 | 验证方式 | 发现的问题 → 修复 |
|---|---|---|---|
| L0 | 研究网易云商 AI 客服导航与交互（WebFetch/WebSearch；Firecrawl/Context7 MCP 未接入）；核实 DeepSeek 接口 | `GET /models`、最小 chat 调用 | `deepseek-flash` 默认开启思考，200 tokens 全部耗在 reasoning、content 为空 → LLM 客户端按阶段切换 `thinking`：分类关闭、推理开启并限制强度 |
| L0 | 脚手架：pnpm workspace、agent-core、API、shared 类型 | `tsc`、node:test | pnpm 11 拒绝 esbuild 构建脚本且 `pnpm.onlyBuiltDependencies` 已废弃 → 改用 `pnpm-workspace.yaml: allowBuilds` |
| L1 | 九阶段执行链 + 在线机器人页 + 坐席工作台 | 真实 DeepSeek 端到端 3 条流（物流查询 / 缺槽位追问 + 投诉升级 / 工作台接管 + AI 建议 + 人工回复） | ① antd 5 在 React 19 下 console.error → 引入 `@ant-design/v5-patch-for-react-19`；② favicon 404 → 内联 SVG；③ 单文档索引下 BM25 归一化过低 → 分母改为「词表内查询词的 idf 之和」；④ 话术出现「已为您登记催件工单」但动作未执行 → 承诺检测改为「声称已完成的动作 ≠ 提案动作」才判 L2；⑤ 演示数据 64h 未更新与 72h 停滞阈值矛盾 → 调整为 96h |
| L2 | 工单系统 | 新建 → 处理 → 备注 → 解决流转 | antd 两字按钮自动插空格（「创 建」）使定位不稳 → `ConfigProvider button.autoInsertSpace=false` |
| L3 | Mind Studio、Agent Studio、AIGC、呼入机器人、AI 外呼 | 5 条真实流（发布→检索命中；试跑→发布→版本；IVR→执行链；小记；模拟外呼） | 隐藏 Tab 面板中的同名元素导致断言命中不可见节点 → 断言限定 `.ant-tabs-tabpane-active` |
| L4/L5 | 质检、报表、大屏、客户之声、数字员工 | 5 条流（规则+语义质检→复核；报表切换保存；大屏渲染；VoC 分析→提问；发票智能体沙箱） | ① SQLite 字符串字面量误用双引号 → `/api/quality/report`、`/api/dashboard` 500 → 全部改单引号；② DeepSeek 要求 json_object 模式提示词含 "json" → `chatJson` 自动补充；③ VoC 提问样本关键词匹配为 0 → 主题名 + 二元组 + 停用词过滤，并返回真实样本数；④ 大屏饼图截屏时处于动画中 → `animation:false` |
| L6 | 全量回归 + 生产构建 + 文档 | 31 条 e2e 全绿（含 8 条真实模型流），`pnpm build` 通过 | 根脚本 `pnpm -r --filter ./packages/**` 在 pnpm 11 语义变化 → 改为 `pnpm -r run build`；bundle 2.6MB → manualChunks 拆分 antd/echarts/react |
| L7 | 回复语义修正 + 独立访客端 | 新增 `visitor.spec`（开始咨询 → 规则应答 → 人工确认等待提示 → 坐席接管回复轮询可见 → 刷新历史保留 → 结束评价），`chain.spec` 新增「气泡 === 轨迹对客回复」断言；33 条全绿 | 用户反馈：人工确认时访客气泡与轨迹「最终回复」不一致 → `reply.text` 改为实际对客文本、新增 `reply.candidate` 保存候选话术，`chain.ts` 改为单一来源，TraceViewer 分列展示；坐席回复后「在线机器人」页看不到 → 该页改为轮询，并新增 `/visitor` 独立访客端（本地记住会话、轮询人工消息、结束后满意度评价写入 `satisfaction`） |

| L8 | Firecrawl/Context7 调研 + 执行链提速 + 模型高可用 + SSE | Benchmark 同一 10 例前后对比；单测新增 5 条（重试/熔断/切换/降级/跳过推理）；e2e 新增 `ha.spec`（全部模型故障 → 访客端 <8s 收到受限模式回复并转人工 → Studio 显示演练 → 恢复）；`chain.spec` 断言流式进度芯片 | **Benchmark**：场景准确率 100%→100%，决策准确率 80%→90%，平均耗时 **8825ms→5399ms（−39%）**，模型调用 23→19，tokens 36.5k→27.1k（−26%）；缺槽位追问 5.4s→1.1s。发现问题：pnpm 根目录无 tsx 导致 `node --import tsx` 失败 → 生产启动改在 `apps/api` 目录执行 |
| L9 | 发布形态：登录 + 三角色权限、API 托管前端、Dockerfile/compose、会话结束自动小记 | `auth.spec`（未登录跳转/坐席只读/退出拦截；API 401/403/200 与审计）；Playwright 改为 setup 项目登录并复用 storageState；本地以 `SERVE_WEB=1` 启动核对 `/`、SPA 回退、静态资源、API 鉴权 | 已登录态访问 `/login` 被重定向使页面用例误判 → 断言放宽；38 条 e2e 全绿 |
| L10 | 数据层迁移 PostgreSQL（CS-013 / ADR-0041）：`db.ts` 改为异步驱动抽象——生产 `pg` 连 PostgreSQL 16 + pgvector，本机/测试用 PGlite（进程内 Postgres，零依赖）；`?` 占位符自动转 `$n`；全部 ~150 处调用点异步化；compose 增加 `pgvector/pgvector:pg16` 服务；备份/恢复脚本与运行手册 | `apps/api/test/db.test.ts` 6 条（占位符转换、建表、聚合返回 number、事务回滚、ON CONFLICT 幂等、undefined→NULL）；`/api/dashboard`、`/api/reports/run`、`/api/quality/report`、`/api/voc/overview` 冒烟核对数值类型；38 条 e2e 全绿（真实模型） | 方言问题清单：① `INSERT OR REPLACE/IGNORE` → `ON CONFLICT DO UPDATE/NOTHING`（traces/quality_rules/ivr_flows/voc_items）；② `ROUND(AVG(score),1)` 在 double 上无重载 → `::numeric`；③ 子查询必须有别名（agents 概览）；④ `day` 是时间单位关键字不能作裸别名（VoC 趋势）→ `AS day` + 显式分组表达式；⑤ int8/numeric 默认返回字符串 → 驱动层 type parser 转 number；⑥ 报表 `GROUP BY key/value` 改为 `dim_key/metric_value`；⑦ e2e 保存报表撞名（数据库跨轮次持久化）→ 用例改唯一名。Docker 守护进程本机未运行，compose 与备份脚本待服务器验证 |
| L11 | 工单系统 → 子案件 + 人工接续任务 + DMS 模拟适配器（CS-003 / CS-008E-I / CS-016）：`cases` / `handoff_tasks` / `dms_mock_tickets` 表；`services/handoff.ts`（工作日历、P0/P1/P2 时窗、单活动任务、认领=接管）；`services/dms.ts`（`DmsAdapter` 契约 + Mock：幂等建单、unavailable/reject/account_cancelled 注入、状态推进）；`routes/cases.ts`（cases / handoffs / dms 三组接口）；执行链非自主决策自动建接续任务并用 `responseWindow` 钩子注入日历时窗；前端三 Tab 工作台与在线客服接续条 | 单测 7（日历/时窗/任务）+ 5（DMS Mock）+ 8（Fastify inject：建单→关联、待同步→重试、拒绝、回填、认领、control 联动、鉴权）；e2e 新增 `cases.spec`（DMS 不可用→待同步→重试；访客投诉→时窗文案→接续任务→认领跳转→同会话不新建）；浏览器核对三 Tab 与种子数据 | 多个 tsx watch 残留进程同时打开同一 PGlite 目录导致 `PGlite failed to initialize`（单进程约束）→ 清理后正常；e2e 三处断言收紧（antd Tag 与文本重复、Drawer 关闭按钮、真实模型下升级优先级不固定）；未做：P0 轮值告警投递（CS-008H）、跨渠道强锚点关联（CS-008F）、真实 DMS 适配器 |
| L12 | 渠道接入（切片 0 P1 剩余）：渠道适配器契约（`services/channels.ts`：幂等入站、外部身份映射、24h 会话复用、单一响应者、投递结果如实回写）；pg-boss 队列（`services/jobs.ts`，PGlite `fromPglite` / Postgres 连接串，`channel.inbound` + `channel.deliver` 重试退避）；微信公众号/测试号适配器（签名、AES 安全模式、XML 归一化、客服消息发送 + 错误码语义、mock 模式）与公开 Webhook（5 秒 ack）；官网嵌入 `embed.js` + 访客端 embed 模式 + 演示页；k6 压测脚本与结果 | 单测 7（channels）+ 4（pg-boss on PGlite，含重试 retryCount≥2）+ 8（微信：签名/加解密往返/解析/inject 明文与安全模式/幂等/状态）；e2e 新增 `embed.spec`；k6 peak 200 VU 0 失败、平台开销 p95 986 ms、单进程 CPU 满载；真实模型 3 VU 执行链 p95 12.3 s | 发现：单进程 + 同线程 PGlite 在 200 VU 时 CPU 打满（生产用独立 PostgreSQL + 双副本缓解）；真实模型 p95 距 15 s 门禁只剩 ~20% 余量（下一步：更多场景模板短路、精简推理输出、备用 provider 分流）；pg-boss `stop()` 无 `wait` 选项；k6 winget 包 id 为 `GrafanaLabs.k6`。未做：微信媒体下载、小程序客服消息、App 原生 SDK、服务器形态压测 |

## 复跑验证

```bash
pnpm install
cp .env.example .env   # 填 LLM_API_KEY
pnpm dev               # 终端 1：api 8787 + web 5173
pnpm test              # agent-core 单测 12 条（不联网，含路由器重试/熔断/降级）
pnpm e2e               # 终端 2：41 条 Playwright（先自动登录 admin），含真实模型调用与故障演练，约 3.5 分钟
```
