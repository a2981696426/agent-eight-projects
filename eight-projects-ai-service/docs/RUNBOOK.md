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

## 5. 本机开发对照

- 不设 `DATABASE_URL` → PGlite 进程内 Postgres，数据在 `data/pglite/`，删除该目录即重置并重新 seed。
- `DATA_DIR=:memory:` → 纯内存库（单测使用）。
- 想在本机连真实 Postgres：`docker compose up -d postgres`，然后 `DATABASE_URL=postgres://eight:eight@localhost:5432/eight pnpm dev`。
