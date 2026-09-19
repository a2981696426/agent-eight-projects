# 天猫只读业务数据适配器 实施计划（CS-018）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把电商平台（首个：天猫 / 淘宝开放平台 TOP）的**只读**订单 / 物流 / 退款数据接为执行链的证据来源（CS-018），以同一契约提供 **沙箱实现**（可注入失败语义，离线可测）与 **真实 TOP 实现**（签名、路由、响应映射；企业认证未通过前不可联调，但映射器以录制样例单测）；平台订单号进入槽位识别；坐席工作台可按订单号查看平台数据。

**Architecture:** `services/platform-data.ts` 定义 `PlatformDataSource { getOrder / getLogistics / getRefunds / health }` 与统一 DTO（收件人字段只保留脱敏形态，不做身份反推）；`TmallSandboxSource`（内置 fixtures + `simulate(mode)`）与 `TmallTopSource`（`sign()` + `call(method, params)` + `mapTrade/mapLogistics/mapRefunds`）；chain.ts 的 `orders.lookup / logistics.track / refunds.lookup` 在本地库未命中且订单号形态为平台订单时转平台数据源，证据项标 `source`；`routes/platform.ts` 提供健康 / 模拟 / 订单查询接口；OnlineService 客户上下文增「平台订单」查询。

## Global Constraints

- 只读：不做任何平台写操作；不用平台数据反推访客身份（收件人姓名/电话/地址脱敏后仅用于"是否与访客自述一致"的比对，不入库）。
- 未接为渠道消息通道（CS-012 边界不变）。
- `TAOBAO_MODE=off|sandbox|live`；live 缺 app key / session 时启动即降级为 off 并告警，不阻塞服务。
- 平台调用 5 s 超时、一次重试；失败时工具返回 `{ unavailable: true, reason }` 而不是抛错，让证据完整度 <1 触发 L2（现有规则）。

---

### Task 1: 契约、沙箱实现、TOP 签名与映射器（TDD）

**Files:** Create `apps/api/src/services/platform-data.ts`、`apps/api/test/platform-data.test.ts`；Modify `apps/api/src/env.ts`、`.env.example`。

```ts
export type PlatformId = 'tmall';
export interface PlatformOrder { platform: PlatformId; orderId: string; status: 'WAIT_BUYER_PAY'|'WAIT_SELLER_SEND_GOODS'|'WAIT_BUYER_CONFIRM_GOODS'|'TRADE_FINISHED'|'TRADE_CLOSED'|string; statusText: string; createdAt: string; paidAt: string | null; shippedAt: string | null; amount: number; paidAmount: number; items: { title: string; skuText: string; qty: number; price: number }[]; receiver: { nameMasked: string; phoneMasked: string; addressMasked: string }; buyerNickMasked: string; source: 'tmall-sandbox' | 'tmall-live'; fetchedAt: string }
export interface PlatformLogistics { orderId: string; company: string; trackingNo: string; status: string; lastUpdate: string | null; hoursSinceUpdate: number | null; stalled: boolean; events: { time: string; desc: string }[]; source; fetchedAt }
export interface PlatformRefund { refundId: string; orderId: string; status: string; statusText: string; amount: number; reason: string; createdAt: string; modifiedAt: string; source; fetchedAt }
export interface PlatformDataSource { readonly platform: PlatformId; readonly mode: 'sandbox' | 'live'; getOrder(id): Promise<PlatformOrder | null>; getLogistics(id): Promise<PlatformLogistics | null>; getRefunds(id): Promise<PlatformRefund[]>; health(): Promise<{ ok: boolean; mode; detail: string }> }
export const detectPlatformOrder = (id: string): PlatformId | null   // /^\d{16,19}$/ → 'tmall'
export class TmallSandboxSource implements PlatformDataSource { simulate(mode: 'normal'|'unavailable'|'auth_expired'|'rate_limited'); fixtures: 3 笔订单（已发货停滞 / 待发货 / 已完成有退款） }
export function topSign(params: Record<string,string>, appSecret: string): string   // MD5(secret + k1v1k2v2... + secret) 大写（sign_method=md5）
export function mapTradeFullinfo(json): PlatformOrder; mapLogisticsTrace(json): PlatformLogistics | null; mapRefunds(json): PlatformRefund[]   // 收件人脱敏
export class TmallTopSource implements PlatformDataSource { constructor(cfg: { appKey; appSecret; session; apiUrl?; fetchImpl? }); call(method, params) }
export function platformSourceFromEnv(): PlatformDataSource | null
```
单测：`topSign` 已知向量（官方文档示例：app_key=test, 参数 method/timestamp/format/v/sign_method → 可用 node:crypto 自算对照，断言大写 32 位与顺序无关）；`mapTradeFullinfo` 对录制样例（`trade_fullinfo_get_response.trade`）输出脱敏收件人（`张*`、`138****0001`、`浙江省杭州市**`）；沙箱三笔订单与 `simulate('unavailable')` 抛出 `PlatformUnavailable`；`TmallTopSource.call` 用 fetchImpl 断言请求体含 `sign`、`session`、`method`，错误响应 `error_response.code=27`（无效会话）映射为 `auth_expired`；`detectPlatformOrder`。

- [ ] 测试 → 实现 → 提交 `feat(platform): read-only platform data source contract, Tmall sandbox with failure injection, TOP signing and response mappers`。

---

### Task 2: 执行链接入 + 订单号识别 + 接口 + 工作台

**Files:** Modify `packages/agent-core/src/pipeline.ts`（订单号正则增加 16~19 位平台订单）、`apps/api/src/services/chain.ts`（三工具回退到平台数据源；`EvidenceItem` 数据带 `source`）、`apps/api/src/server.ts`、`apps/api/src/services/auth.ts`；Create `apps/api/src/routes/platform.ts`、`apps/api/test/platform.api.test.ts`；Modify `apps/web/src/pages/reception/OnlineService.tsx`（客户上下文「平台订单」：输入订单号 → 订单 / 物流 / 退款卡片 + 来源标签）。

接口：`GET /api/platform/status`（各平台 mode/health）、`POST /api/platform/tmall/simulate {mode}`（admin）、`GET /api/platform/tmall/orders/:id`（订单 + 物流 + 退款汇总；agent/admin）。

单测（inject）：`runStandalone('订单 2026091800012345678 的快递三天没动了')` → 槽位 orderId 识别、`logistics.track` 证据 `source='tmall-sandbox'`、`stalled=true`；`simulate('unavailable')` 后同问 → 工具结果 `unavailable=true`、风险 ≥ L2、决策非 auto；`/api/platform/tmall/orders/:id` 返回三段；analyst 调 simulate 403。

- [ ] 实现 → 测试 → 前端 → 提交 `feat(platform): Tmall read-only evidence in execution chain, platform API and workbench lookup`。

---

### Task 3: 文档 + 回归

- `docs/ARCHITECTURE.md`（L15 平台业务数据源）、`docs/EXECUTION-CHAIN.md`（第 4 阶段证据来源）、`docs/RUNBOOK.md`（天猫开放平台接入：企业认证 → 创建应用 → 申请 API 权限包 `taobao.trade.fullinfo.get` / `taobao.logistics.trace.search` / `taobao.rp.refunds.receive.get` → 商家授权取 session → 服务器出网 IP 白名单；`TAOBAO_MODE=live`）、`.env.example`、`docs/LOOP-LOG.md`（L15）、README。
- [ ] `pnpm -r typecheck`、单测、`pnpm e2e` → 提交 `docs: Tmall read-only data source (L15)`。

## Self-Review

- CS-018 覆盖：只读 ✔、天猫优先 ✔、证据来源标注 ✔、不反推身份 ✔（脱敏 DTO）、不接为渠道 ✔、企业认证前可用沙箱 ✔。
- 类型一致性：`PlatformDataSource`（Task 1）由 chain.ts 与 routes（Task 2）消费；`detectPlatformOrder` 与 pipeline 正则一致（16~19 位）。
