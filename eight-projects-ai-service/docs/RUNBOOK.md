# 运行手册（腾讯云单机 · Docker Compose）

适用形态：一台 4 核 8G 云服务器，`docker compose` 运行 `postgres`（pgvector/pg16）与 `ai-service`（API 托管前端）。依据 CS-013 / ADR-0041。

## 1. 启动 / 停止 / 升级

```bash
cp .env.example .env          # 填 LLM_API_KEY、SESSION_SECRET、POSTGRES_PASSWORD
docker compose up -d --build  # 首次会拉取 pgvector/pgvector:pg16 并构建应用镜像
docker compose ps             # 两个容器均为 healthy / running
docker compose logs -f ai-service
docker compose stop           # 停止；数据在 pgdata 卷中保留
```

升级：`./scripts/backup-db.sh && git pull && docker compose up -d --build`。应用启动时自动执行幂等迁移（`CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`）。

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
| API 全部 500，日志含 `ECONNREFUSED 5432` | Postgres 未就绪或崩溃 | `docker compose restart postgres`，等待 healthy 后 `docker compose restart ai-service` |
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

- 队列：`channel.inbound`、`channel.deliver`；`/api/health` 的 `jobs.started` 应为 `true`。
- 排查：`SELECT name, state, count(*) FROM pgboss.job GROUP BY 1,2;`（生产 PostgreSQL）；失败任务保留 14 天，`retry` 状态表示等待退避重试。
- 发送失败不会重试的情况（48 小时窗口过期、被拒绝）会在会话里追加系统消息，坐席可见。

## 8. 本机开发对照

- 不设 `DATABASE_URL` → PGlite 进程内 Postgres，数据在 `data/pglite/`，删除该目录即重置并重新 seed。
- `DATA_DIR=:memory:` → 纯内存库（单测使用）。
- 想在本机连真实 Postgres：`docker compose up -d postgres`，然后 `DATABASE_URL=postgres://eight:eight@localhost:5432/eight pnpm dev`。
