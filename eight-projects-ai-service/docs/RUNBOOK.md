# 运行手册（腾讯云单机 · Docker Compose）

适用形态：一台 4 核 8G 云服务器，`docker compose` 运行 **Caddy（TLS）→ api-blue + api-green → postgres（pgvector/pg16 + pg-boss）**。依据 CS-013 / ADR-0041。演练步骤与登记见 [DRILLS.md](./DRILLS.md)。

## 1. 启动 / 停止 / 升级

```bash
cp .env.example .env          # 填 LLM_API_KEY、SESSION_SECRET、POSTGRES_PASSWORD
# 可选：SITE_ADDRESS=cs.example.com（ICP 通过后自动 HTTPS）；HTTP_PORT / HTTPS_PORT
docker compose up -d --build  # 首次拉取 pgvector 与 caddy，构建应用镜像（只编 api-blue，green 复用）
docker compose ps             # postgres / api-blue / api-green / caddy 均为 healthy 或 running
docker compose logs -f caddy
docker compose stop           # 停止；数据在 pgdata 卷中保留
```

升级（零中断蓝绿）：`./scripts/deploy.sh`（先备份，再轮换 blue、green，Caddy 健康检查摘除未就绪副本）。回滚：`./scripts/deploy.sh --rollback`。应用启动时自动执行幂等迁移。

## 2. 健康检查

- `GET /api/health`：`status=ok`，`db` 应为 `pg`（本机开发为 `pglite`），`llm.providers[].circuit` 为 `closed`，`knowledgeIndexed > 0`。
- `GET /api/overview`：会话 / 工单 / 轨迹计数，恢复演练后用于核对。
- 云监控：对 `/api/health` 做 HTTP 探活（30 s 间隔，连续 3 次失败告警到企业微信群机器人）。

## 3. 备份与恢复

- 每日备份：`crontab -e` 加 `0 3 * * * /opt/eight/scripts/backup-db.sh >> /var/log/eight-backup.log 2>&1`。
  `pg_dump -Fc` 写入 `backups/`，本地保留 30 天；设置 `COS_BUCKET` 并安装 `coscli` 后自动上传 COS。
- 恢复 / 演练：`./scripts/restore-db.sh backups/eight-YYYYMMDD-HHMM.dump`。脚本先恢复到 `eight_restore`，再原子交换库名，旧库保留为 `eight_old_<epoch>`。
- 验收：恢复后 `GET /api/overview` 各计数与备份时刻一致；确认后 `DROP DATABASE eight_old_<epoch>`。
- 恢复点目标：24 小时（每日一次 dump）。需要更短时再加 WAL 归档。

## 4. 故障处理

| 现象 | 判断 | 处理 |
|---|---|---|
| API 全部 500，日志含 `ECONNREFUSED 5432` | Postgres 未就绪或崩溃 | `docker compose restart postgres`，等待 healthy 后 `docker compose restart api-blue api-green` |
| `/api/health` 中 provider `circuit=open` | 上游模型故障，已自动熔断 | 无需操作；`LLM_CIRCUIT_COOLDOWN_MS` 后自动半开探测；全部 provider 不可用时执行链进入规则降级，trace 标记 `degraded` |
| 磁盘占用高 | `pgdata` 卷或 `backups/` 增长 | `docker system df`；清理 30 天外备份（脚本已自动）；必要时 `VACUUM` |
| 忘记 SESSION_SECRET 变更导致全员登出 | Cookie 签名失效 | 预期行为；提醒重新登录 |

## 5. 微信公众号 / 测试号接入

前置：备案域名 + HTTPS（微信只回调 80/443，服务器地址在腾讯云上需已备案域名；本机联调可用内网穿透到 `/api/channels/wechat/webhook`）。

1. 测试号：`mp.weixin.qq.com/debug/cgi-bin/sandboxinfo` 取 `appID` / `appsecret`；正式服务号在「设置与开发 → 基本配置」。
2. `.env` 填 `WECHAT_APPID`、`WECHAT_SECRET`、`WECHAT_TOKEN`（自定义 3~32 位）、`WECHAT_AES_KEY`（43 位，安全/兼容模式必填），并把 `WECHAT_MOCK` 改为 `0`；`docker compose up -d --build`。
3. 微信后台「服务器配置」：URL `https://<域名>/api/channels/wechat/webhook`，Token 与 EncodingAESKey 同 `.env`，消息加解密方式建议「安全模式」→ 提交，微信会 GET 校验（签名正确回 echostr）。
4. 验证：用手机关注/发消息 → `GET /api/channels/status`（登录后）看 `adapters.wechat.mode=live`、`jobs.started=true`；工作台「在线客服」出现渠道为 `wechat` 的会话，机器人回复经客服消息送达。
5. 常见错误：`45015` 超出 48 小时互动窗口（用户需再发一条消息）；`45047` 客服消息条数超限；`40001/42001` token 失效（适配器自动重取一次）；签名 403 多为 Token 不一致或时钟偏差。
6. 切换/回滚（CS-014）：把微信后台服务器地址改回云商即可，10 分钟内；本系统侧无需操作。

## 6. 官网嵌入

页面加 `<script src="https://<域名>/embed.js" data-title="欧态在线客服" data-site="official-site"></script>`；灰度只在部分页面加即可。演示页 `/embed-demo.html`。

## 7. 异步队列（pg-boss）

- 队列：`channel.inbound`、`channel.deliver`、`knowledge.embed`、`oncall.watch`；`/api/health` 的 `jobs.started` 应为 `true`。
- 排查：`SELECT name, state, count(*) FROM pgboss.job GROUP BY 1,2;`（生产 PostgreSQL）；失败任务保留 14 天，`retry` 状态表示等待退避重试。
- 发送失败不会重试的情况（48 小时窗口过期、被拒绝）会在会话里追加系统消息，坐席可见。

## 8. 知识库迁移与向量检索

- 云商知识库迁移：云商后台导出知识（Excel）→ 另存为「CSV UTF-8」→ Mind Studio「批量导入」选「FAQ CSV（云商导出）」上传，勾选「导入后直接发布」；表头自动映射（标准问 / 答案 / 相似问 / 分类 / 标签）。
- 向量供应商：`.env` 设 `EMBEDDING_PROVIDER=hunyuan`（同云首选）与 `EMBEDDING_API_KEY`（混元 OpenAI 兼容 Key）；备用 `bailian`。重启后启动作业自动补齐缺失向量；`GET /api/knowledge/stats` 的 `vectors.coverage` 到 1.0 即完成。
- 换供应商 / 维度：改 `.env` → 若维度变化需在数据库执行 `DROP TABLE knowledge_vectors;` 后重启（表按 `EMBEDDING_DIMS` 重建）→ `POST /api/knowledge/reindex-vectors`（管理员）。
- 供应商故障：检索自动退回 BM25（trace 第 5 阶段 `mode=bm25`），60 s 后自动重试；无需人工干预。

## 9. 天猫只读数据接入（CS-018）

- 默认 `TAOBAO_MODE=sandbox`：内置 3 笔样例订单（在线客服「平台订单」Tab 有链接），管理员可在 `POST /api/platform/tmall/simulate {mode}` 注入 `unavailable / auth_expired / rate_limited` 演练执行链降级。
- 切 live 前置：淘宝开放平台**企业开发者认证**通过 → 创建「自用型」应用取得 `app_key / app_secret` → 申请 API 权限包（交易 `taobao.trade.fullinfo.get`、物流 `taobao.logistics.trace.search`、退款 `taobao.rp.refunds.receive.get`）→ 商家账号完成应用授权取得 `session`（access token，注意有效期与刷新）→ 在开放平台配置服务器出网 IP 白名单。
- `.env`：`TAOBAO_MODE=live`、`TAOBAO_APP_KEY`、`TAOBAO_APP_SECRET`、`TAOBAO_SESSION`；缺任一项启动即降级为 off 并打印告警，服务不受影响。
- 排障：`GET /api/platform/status` 看 `ok/detail`（最近一次调用错误）；`auth_expired` → 重新授权刷新 session；`rate_limited` → 降低调用频率或申请更高配额；trace 第 4 阶段证据项 `unavailable=true` 对应 L2 人工确认。

## 10. 本机开发对照

- 不设 `DATABASE_URL` → PGlite 进程内 Postgres，数据在 `data/pglite/`，删除该目录即重置并重新 seed。
- `DATA_DIR=:memory:` → 纯内存库（单测使用）。
- 想在本机连真实 Postgres：`docker compose up -d postgres`，然后 `DATABASE_URL=postgres://eight:eight@localhost:${POSTGRES_PORT:-55432}/eight pnpm dev`（宿主机默认 55432，避免与本机 5432 冲突）。

## 11. P0 轮值告警（CS-008H）

- `.env`：`ONCALL_MODE=mock`（本机/演练）或 `wecom`（生产，填 `ONCALL_WEBHOOK` 企业微信群机器人）；`ONCALL_ROSTER=姓名1,姓名2,姓名3`（按日轮转，升级链从当值起向后）。
- 验收：制造一条 P0 接续任务 → `GET /api/oncall/status` 的 `pending` 出现且 `deliveredAt` 有值 → 工单协作页显示「P0 已回执」→ 15 分钟内 `POST /api/oncall/alerts/:id/ack` 或认领任务；超时未确认会升下一跳。管理员可 `POST .../escalate` 立即演练下一跳。
- **禁止**：通道关闭或投递失败时对访客说「已优先通知专人」。`off` 或缺花名册只记失败历史，执行链不中断。
- 排障：`handoff_tasks.alert` JSON 含 `hops[].receipt`；无回执查 `ONCALL_MODE` / webhook HTTP 与企业微信 `errcode`。
