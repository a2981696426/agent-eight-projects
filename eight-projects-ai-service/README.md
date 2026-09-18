# 八项目 AI 客服系统（eight-projects-ai-service）

以网易云商「AI 客服」的产品结构为参照，重构为一套**围绕单条可审计 Agent 执行链**的模块化单体：

- **系统基座**：在线客服（坐席工作台）、工单系统；呼叫中心 / 视频客服暂缓
- **智能增强**：在线机器人、呼入机器人、AI 外呼、AIGC 应用、Agent Studio、Mind Studio
- **服务管理**：智能质检、自定义报表、数据大屏、客户之声
- **智能体**：售后服务数字员工（物流 / 发票 / 退款差价）

每一次机器人应答都完整经过 **用户输入 → 信息补全 → 意图/场景识别 → 证据获取 → 知识/工具调用 → 推理与根因判断 → 风险分级 → 自主处理/人工确认/升级 → 最终回复** 九个阶段，并把每一步的依据留痕（见 [docs/EXECUTION-CHAIN.md](docs/EXECUTION-CHAIN.md)）。

## 快速开始

要求：Node ≥ 22.13、pnpm 11。

```bash
pnpm install
cp .env.example .env          # 填入兼容 OpenAI 协议的 LLM_API_KEY（默认 DeepSeek deepseek-flash）
pnpm dev                      # API http://127.0.0.1:8787 · Web http://127.0.0.1:5173
```

首次启动自动建库并写入演示数据（6 位客户、7 笔订单、物流/发票/退款记录、12 篇知识、7 条历史会话、质检规则、IVR 流程、外呼任务、10 条评测用例）。

登录账号（演示）：`admin / admin123` 管理员 · `agent / agent123` 坐席 · `analyst / analyst123` 质检与运营。客户视角的独立访客端 `/visitor` 无需登录。

## 生产部署

```bash
pnpm build && pnpm start:prod          # API 单端口托管前端：http://127.0.0.1:8787
# 或容器
docker compose up -d --build            # 读取 .env，数据卷 /data
```

模型高可用：`.env` 可配置备用 provider（`LLM_FALLBACK_*`）、熔断阈值与重试次数；主模型故障时自动切换，全部不可用时执行链进入规则降级（关键词识别 + 证据模板 + 强制人工），服务不中断。Agent Studio →「模型与高可用」可做故障演练。

建议路线：`总览` → `在线机器人` 发一句「订单 20260918000123 的快递三天没动了」看九阶段轨迹 → 打开 `/visitor` 独立访客端以客户视角持续对话 → `在线客服` 接管待接入会话并用「AI 建议」回复（访客端会实时收到）→ `Agent Studio` 改白名单后试跑 / 跑 Benchmark → `Mind Studio` 新建资料并发布 → `智能质检` / `客户之声` 运行分析 → `数据大屏`。

## 验证

```bash
pnpm typecheck   # 全部包
pnpm test        # agent-core 单测 12 条（不联网；含模型路由重试/熔断/降级）
pnpm build       # 生产构建
pnpm e2e         # Playwright（需 dev 服务已启动、系统 Chrome）；38 条用例，含真实模型业务流、故障演练与权限，断言 0 控制台错误
```

## 目录

```
apps/api            Fastify + node:sqlite；路由按模块拆分；services/chain 注入业务工具与知识索引
apps/web            React 19 + Ant Design 5 + ECharts；17 个页面；TraceViewer 统一展示执行链
packages/agent-core 九阶段执行链、LLM 客户端（fast/reasoning 双模式）、BM25 检索、工具注册表、场景包
packages/shared     前后端共享类型
e2e                 Playwright 用例（页面零错误 + 业务流）
docs                架构、执行链、Loop 记录、拆仓库指南
```

## 大模型

任何兼容 OpenAI Chat Completions 的服务均可，通过 `.env` 配置 `LLM_BASE_URL / LLM_API_KEY / LLM_MODEL_FAST / LLM_MODEL_REASONING`。默认 DeepSeek：分类、抽取、改写、AIGC 用关闭思考的快模式（~1s），根因推理开启思考并限制强度。API Key 只存在 `.env`，不入库。

## 拆出为独立仓库

见 [docs/EXTRACT-TO-NEW-REPO.md](docs/EXTRACT-TO-NEW-REPO.md)：`scripts/extract-to-new-repo.sh <new-repo-url>` 一条命令保留历史拆出并推送。

## 文档

- [架构说明](docs/ARCHITECTURE.md) · [执行链](docs/EXECUTION-CHAIN.md) · [调研与借鉴分析](docs/RESEARCH-2026-09-18.md) · [Loop Engineering 记录](docs/LOOP-LOG.md) · [拆仓库](docs/EXTRACT-TO-NEW-REPO.md)
