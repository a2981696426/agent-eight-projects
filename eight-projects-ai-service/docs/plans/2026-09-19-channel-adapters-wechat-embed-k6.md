# 渠道适配器契约 + 官网嵌入脚本 + 微信适配器（测试号）+ k6 压测 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让统一客服 Agent 通过**渠道消息通道**收发消息：定义渠道适配器契约（入站归一化 → 会话；出站发送 → 回执），先由官网嵌入（H5 iframe）与微信公众号（测试号协议）两条自有通道证明契约可复用；出站发送经 pg-boss 队列异步投递（微信 5 秒内 ack）；用 k6 验证 200 并发访客下的容量门禁（p95 ≤ 15 s、失败率 < 1%）。

**Architecture:** `services/channels.ts` 定义 `ChannelAdapter` 契约、适配器注册表、入站幂等（`channel_messages`）、外部身份映射（`channel_identities`）、找/建会话、触发执行链；`services/jobs.ts` 用 pg-boss（PGlite 用 `fromPglite`，生产用连接串）承载 `channel.inbound` 与 `channel.deliver` 两个队列；`channels/wechat.ts` 实现签名校验、安全模式解密、XML 解析、客服消息发送（`WECHAT_MOCK=1` 时不出网）；`routes/channels.ts` 暴露微信 Webhook（公开）与管理接口；官网嵌入脚本 `apps/web/public/embed.js` 以 iframe 加载 `/visitor?embed=1`；`load/k6-chat.js` 压测脚本。

**Tech Stack:** pg-boss 12（`fromPglite`）、fast-xml-parser 5、node:crypto（sha1 / aes-256-cbc）、k6 2.2、Playwright。

## Global Constraints

- 渠道消息通道不拥有意图/知识/规则/回复决策（词汇表「渠道消息通道」）；适配器只做协议、授权、限流、会话与错误语义（「渠道适配器」）。
- 微信入站必须在 5 秒内响应；所有回复经客服消息接口异步发送；`MsgId` 幂等；48 小时窗口过期是业务结果（`window_expired`），系统消息如实告知坐席，不伪造已送达。
- 外部身份（openid）不等于客户身份：`channel_identities` 只做「渠道用户 → 演示客户档案」映射，不与 UMS/佩戴用户合并（CS-006A）。
- 同一会话回合只有一个活动响应者：机器人接待时入站消息走执行链；人工接待时只落库并由坐席回复，坐席回复经同一出站队列投递。
- 不出网测试：`WECHAT_MOCK=1` 时发送只记录不请求 api.weixin.qq.com；测试全部离线。
- `pnpm -r typecheck` 零错误；单测、e2e 全绿。

---

### Task 1: 渠道适配器契约、身份/幂等表、入站编排（TDD）

**Files:** Create `apps/api/src/services/channels.ts`、`apps/api/test/channels.test.ts`；Modify `apps/api/src/db.ts`（表）、`packages/shared/src/index.ts`（类型）。

**Schema:**
```sql
CREATE TABLE IF NOT EXISTS channel_identities(channel TEXT, external_user_id TEXT, customer_id TEXT, display_name TEXT, created_at TEXT, last_seen_at TEXT, PRIMARY KEY(channel, external_user_id));
CREATE TABLE IF NOT EXISTS channel_messages(channel TEXT, external_msg_id TEXT, conversation_id TEXT, message_id TEXT, received_at TEXT, PRIMARY KEY(channel, external_msg_id));
```

**Interfaces（Produces）:**
```ts
export interface InboundMessage { channel: Channel; externalUserId: string; externalMsgId: string; kind: 'text' | 'image' | 'event'; text: string; attachments: { type: 'image'; mediaId?: string; url?: string }[]; receivedAt: string; displayName?: string }
export type SendFailure = 'window_expired' | 'unavailable' | 'rejected' | 'rate_limited' | 'not_configured';
export type SendResult = { ok: true; externalMsgId: string | null } | { ok: false; kind: SendFailure; message: string; retryable: boolean };
export interface ChannelAdapter { readonly channel: Channel; readonly capabilities: { asyncReply: boolean; media: boolean; windowHours: number | null }; send(externalUserId: string, text: string): Promise<SendResult>; health(): Promise<{ ok: boolean; mode: string }> }
export const channels: Map<Channel, ChannelAdapter>; export function registerChannel(a: ChannelAdapter): void
export async function resolveIdentity(channel, externalUserId, displayName?): Promise<{ customerId: string; created: boolean }>
export async function findOrCreateConversation(channel, customerId, title): Promise<string>   // 24h 内未结束会话复用
export async function ingestInbound(msg: InboundMessage): Promise<{ conversationId: string | null; deduped: boolean; replyMessageId: string | null }>
export async function deliverMessage(conversationId: string, messageId: string): Promise<SendResult & { skipped?: boolean }>   // 无适配器/无身份 → skipped
```
`ingestInbound`：幂等插入 `channel_messages`（`ON CONFLICT DO NOTHING`，changes=0 → deduped）→ 身份 → 会话 → `event:subscribe` 直接回欢迎语 → 机器人接待则 `runForConversation(mode 'bot')`，人工接待则只 `appendMessage('user')`；返回需要投递的 bot 消息 id。`deliverMessage` 把结果写回 `messages.meta.delivery = { status: 'sent' | 'failed' | 'skipped', at, externalMsgId?, error? }`，`window_expired` 时追加系统消息「渠道发送失败：超出 48 小时互动窗口，需等待用户再次发消息」。

**单测（PGlite 内存库 + `FakeAdapter`）**：同 `externalMsgId` 两次入站第二次 `deduped=true` 且不产生新消息；首次入站创建客户与身份、第二次复用；24h 内同渠道同身份复用会话，会话 `closed` 后新建；`LLM_MOCK=1` 下文本入站产生 bot 回复并 `deliverMessage` 成功写 `delivery.status='sent'`；FakeAdapter 返回 `window_expired` → `delivery.status='failed'` 且有系统消息；`web` 渠道无适配器 → `skipped`。

- [ ] 写测试 → 失败 → 实现 → 通过 → 提交 `feat(channels): adapter contract, identity mapping, idempotent inbound ingestion and delivery result recording`。

---

### Task 2: pg-boss 队列（PGlite / Postgres 双后端）+ 出站投递 worker + 坐席回复联动

**Files:** Create `apps/api/src/services/jobs.ts`、`apps/api/test/jobs.test.ts`；Modify `apps/api/src/db.ts`（`driverHandle()`）、`apps/api/src/server.ts`（启动/停止）、`apps/api/src/routes/conversations.ts`（坐席回复入队）、`apps/api/src/services/channels.ts`（bot 回复入队）。

```ts
// db.ts
export function driverHandle(): { kind: 'pg'; connectionString: string } | { kind: 'pglite'; pglite: PGlite }
// jobs.ts
export const QUEUES = { inbound: 'channel.inbound', deliver: 'channel.deliver' } as const;
export async function startJobs(opts?: { pollSeconds?: number }): Promise<void>   // new PgBoss(pglite ? { db: fromPglite(pglite), backend: 'pglite' } : { connectionString }); createQueue ×2; work(inbound → ingestInbound + 入队 deliver); work(deliver → deliverMessage；不可重试失败直接完成并已写 meta)
export async function enqueueInbound(msg: InboundMessage): Promise<string | null>
export async function enqueueDeliver(conversationId: string, messageId: string): Promise<string | null>   // retryLimit 5, retryDelay 5, retryBackoff true
export async function stopJobs(): Promise<void>
export function jobsStatus(): { started: boolean; backend: string }
```
坐席在 `POST /api/conversations/:id/messages`（role=agent）落库后 `await enqueueDeliver(id, m.id)`；`ingestInbound` 产生 bot 回复后由 inbound worker 入队 deliver。`/api/health` 增 `jobs`。

**单测**：`startJobs({ pollSeconds: 0.5 })` on PGlite 内存库；`enqueueDeliver` 后 3 s 内消息 `meta.delivery.status` 变为 `sent`（FakeAdapter）；FakeAdapter 前两次返回 `unavailable`（retryable）第三次成功 → 最终 `sent` 且 `attempts>=3`（用 pg-boss `getJobById` 校验 `retryCount`）。

- [ ] 测试 → 实现 → 通过 → 提交 `feat(jobs): pg-boss queues on PGlite/Postgres for channel inbound and delivery; agent replies delivered via queue`。

---

### Task 3: 微信公众号适配器（测试号协议）+ Webhook 路由（TDD）

**Files:** Create `apps/api/src/channels/wechat.ts`、`apps/api/src/routes/channels.ts`、`apps/api/test/wechat.test.ts`；Modify `apps/api/src/env.ts`（`WECHAT_*`）、`apps/api/src/services/auth.ts`（公开 `/api/channels/wechat/webhook`）、`apps/api/src/server.ts`（注册路由、注册适配器）、`.env.example`。

```ts
export function verifySignature(token: string, timestamp: string, nonce: string, signature: string): boolean   // sha1(sort([token,timestamp,nonce]).join(''))
export function verifyMsgSignature(token, timestamp, nonce, encrypt, msgSignature): boolean                         // sha1(sort([token,timestamp,nonce,encrypt]))
export function decryptMessage(encodingAesKey: string, encrypted: string): { xml: string; appId: string }        // AES-256-CBC, key=base64(aesKey+'='), iv=key[0..16], 去 PKCS#7 填充，随机16B + 长度4B(BE) + xml + appid
export function parseWechatXml(xml: string): InboundMessage | null   // text → text；image → kind image + MediaId/PicUrl；event subscribe → kind event text '[subscribe]'；其他返回 null
export class WechatAdapter implements ChannelAdapter { channel='wechat'; capabilities={asyncReply:true, media:true, windowHours:48}; send(openid, text) → mock 时 push 到 mockSent 并返回 ok；真实：token 缓存（过期前 60s 刷新），POST /cgi-bin/message/custom/send，errcode 45015→window_expired(不可重试)，45047→rate_limited，40001/42001→刷新 token 重试一次，网络错→unavailable(可重试)；health() }
```
路由：`GET /api/channels/wechat/webhook`（校验签名回 echostr，否则 403）；`POST /api/channels/wechat/webhook`（校验签名；`encrypt_type=aes` 时校验 `msg_signature` 并解密；解析 → `enqueueInbound` → **立即** `reply.type('text/plain').send('success')`；解析失败也回 `success` 以免微信重试轰炸，但写审计）；`GET /api/channels/status`（各适配器 health + jobs 状态）；`GET /api/channels/wechat/mock/sent`（admin，mock 发送记录）。`WECHAT_MOCK=1`、无 AppID 时适配器仍注册（mode `mock`），便于本机与 e2e。

**单测**：签名正确/错误；安全模式加解密往返（用与解密相反的加密函数在测试里构造密文）；三类 XML 解析；inject `GET webhook` 回 echostr；inject `POST webhook` 文本消息 → 200 `success` 且 ≤ 5 s（mock 模式下不等待执行链）→ 等待 3 s 后 `channel_messages` 有记录且会话存在；重复 MsgId 只有一条会话消息；`mockSent` 收到 bot 回复。

- [ ] 测试 → 实现 → 通过 → 提交 `feat(wechat): official-account adapter (signature, AES safe mode, XML parse, customer-service send with mock), public webhook with 5s ack`。

---

### Task 4: 官网嵌入脚本 + 访客端 embed 模式 + 演示页 + e2e

**Files:** Create `apps/web/public/embed.js`、`apps/web/public/embed-demo.html`；Modify `apps/web/src/pages/Visitor.tsx`（`embed` / `channel` / `site` 查询参数）、`apps/web/src/styles.css`（`.visitor-bg.embed`）、`e2e/embed.spec.ts`（新）、`e2e/helpers.ts`（无需登录页面）。

`embed.js`（IIFE，无依赖）：读取自身 `<script>` 的 `data-title`（默认「在线客服」）、`data-color`（默认 `#2563eb`）、`data-site`；在 `body` 追加右下角圆形按钮与 380×600 的 iframe（`src = origin + '/visitor?embed=1&channel=web&site=' + site`），点击切换显示，`Esc` 关闭；对外暴露 `window.EightChat.open()/close()`。
`Visitor.tsx`：`embed=1` → 根节点加 `embed` 类（无背景、占满 iframe）、隐藏「管理端入口」；首次进入且无本地会话时以 `channel`（默认 web）自动 `start()`，跳过身份/渠道选择（匿名访客）。
`embed-demo.html`：一段示例页面 + `<script src="/embed.js" data-title="欧态在线客服" data-site="demo"></script>`。

**e2e `embed.spec.ts`**（未登录态）：`/embed-demo.html` → 点击浮动按钮 → `frameLocator('iframe[title="欧态在线客服"]')` 内输入「你好」发送 → 机器人回复含「欢迎咨询」→ 通过 API 查该会话 `channel==='web'`；刷新页面再打开 → 历史保留。

- [ ] 实现 → `pnpm --filter @eight/web build` → e2e 通过 → 提交 `feat(web): embeddable widget script and visitor embed mode with demo page`。

---

### Task 5: k6 压测脚本与结果

**Files:** Create `load/k6-chat.js`、`load/README.md`、`docs/LOAD-TEST.md`；Modify `package.json`（`load:smoke` / `load:peak` 脚本）。

`k6-chat.js`：`BASE_URL`（默认 `http://127.0.0.1:8788`）；场景 `smoke`（5 VU × 30 s）与 `peak`（ramping-vus 0→200 用 60 s，持稳 120 s，降 30 s）；每个 VU 迭代：`POST /api/conversations`（web 匿名）→ `POST messages "你好"`（规则）→ `POST messages "订单 20260918000123 的快递三天没动了"`（执行链）→ `GET /api/conversations/:id`；`sleep(1~3)`。阈值：`http_req_failed < 0.01`，`chain_duration p(95) < 15000`（自定义 Trend），`http_req_duration{name:create} p(95) < 1000`。
运行方式：另起一个 **mock 模型** API 实例避免真实模型费用与限流：`LLM_MOCK=1 DATA_DIR=:memory: API_PORT=8788 pnpm --filter @eight/api start`；`pnpm load:peak`。结果写入 `docs/LOAD-TEST.md`（VU、RPS、p50/p95/p99、失败率、Node 进程 RSS/CPU 观测）；并附一次 20 VU 真实模型的 `smoke` 结果作为时延参考（若 API Key 可用）。

- [ ] 编写 → 运行 smoke 与 peak → 记录 → 提交 `test(load): k6 chat scenarios and results`。

---

### Task 6: 文档与全量回归

**Files:** Modify `docs/ARCHITECTURE.md`（渠道接入一节）、`docs/EXECUTION-CHAIN.md`（入站/出站与会话复用）、`docs/RUNBOOK.md`（微信测试号接入步骤：服务器地址、Token、EncodingAESKey、公网/内网穿透说明；队列观察）、`README.md`、`docs/LOOP-LOG.md`（L12）、`.env.example`。

- [ ] `pnpm -r typecheck`、`pnpm test`、`pnpm --filter @eight/api test`、`pnpm e2e` 全绿 → 提交 `docs: channel adapters, wechat onboarding, embed, load test (L12)`。

## Self-Review

- 切片 0 P1 交付物对照：渠道适配器契约 ✔（Task 1）、官网嵌入脚本 ✔（Task 4）、微信适配器（测试号）✔（Task 3，真实联调需用户提供 AppID/Token 与公网地址，RUNBOOK 写明）、k6 压测 ✔（Task 5）、运行手册 ✔（Task 6）。
- 决策约束：微信 5 秒 ack + 异步客服消息 ✔；MsgId 幂等 ✔；单一响应者 ✔（人工接待时入站不触发执行链）；pg-boss 不引 Redis ✔（CS-013）；身份不合并 UMS ✔。
- 类型一致性：`InboundMessage` / `SendResult` 在 Task 1 定义、Task 2/3 消费；`enqueueInbound` / `enqueueDeliver` 在 Task 2 定义、Task 3 路由与 Task 1 编排消费；`driverHandle()` 在 Task 2 定义供 jobs 使用。
