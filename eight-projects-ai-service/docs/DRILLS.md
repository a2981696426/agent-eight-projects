# 故障与恢复演练记录（切片 0 / P1 门禁）

门禁要求：**备份恢复演练成功**；**故障演练通过**（单副本摘除后入口仍可用）。本文件同时是操作步骤与结果登记。

形态：`Caddy → api-blue + api-green → postgres`。入口探测 `GET ${SITE_ADDRESS}/api/health`，响应含 `instance: blue|green`。

---

## D1 备份 → 恢复（RPO 24h）

**步骤**

```bash
# 1. 栈在跑（至少 postgres + 一个 API）
docker compose up -d postgres api-blue api-green caddy
# 2. 记下当前计数
curl -sS http://127.0.0.1:${HTTP_PORT:-80}/api/overview > /tmp/overview-before.json
# 3. 备份
./scripts/backup-db.sh
# 4. 写入可识别标记（登录后）
#    POST /api/knowledge/import {text:"# 演练标记\\n...", format:text, publish:false}
# 5. 恢复刚写下的 dump（会短暂停 API）
./scripts/restore-db.sh backups/eight-<stamp>.dump
# 6. 核对 overview 与步骤 2 一致；演练标记应消失
# 7. 确认后 DROP DATABASE eight_old_<epoch>;
```

**验收**：恢复后 `conversations / cases / traces / knowledge` 与备份时刻一致；应用 `/api/health` 为 `ok`；旧库已登记待删。

| 日期 | 环境 | dump 文件 | 备份时刻 overview | 恢复后 overview | 结果 | 操作人 |
|---|---|---|---|---|---|---|
| 2026-09-19 | 本机 Docker（仅 postgres，host 55432） | `backups/eight-20260919-drill.dump`（93 384 B，在容器内 `pg_dump -Fc`） | 空库（未跑应用 seed） | `eight_restore` 恢复 32 张 `public` 表，无 ERROR | **部分通过**（dump↔restore 往返成功；未做双副本换库） | 工程 |

### 本机部分演练（2026-09-19）

完整「停双副本 → 原子换库 → 启动」依赖已构建的应用镜像。本机若尚未 `docker compose build`，至少应对 **postgres 容器**跑通 `pg_dump -Fc` ↔ `pg_restore` 往返：

```bash
docker compose up -d postgres
./scripts/backup-db.sh
# 恢复到 eight_restore 并核对表数，不交换生产库名（避免打断本机开发）
docker compose exec -T postgres psql -U eight -d postgres -c "DROP DATABASE IF EXISTS eight_restore; CREATE DATABASE eight_restore OWNER eight;"
docker compose exec -T postgres pg_restore -U eight -d eight_restore --no-owner --no-privileges < backups/eight-<stamp>.dump
docker compose exec -T postgres psql -U eight -d eight_restore -c "\\dt"
```

通过标准：dump 非空、restore 无 ERROR、`\\dt` 能列出业务表。**全栈换库演练在腾讯云首发当晚补登一行。**

---

## D2 单副本故障（入口不中断）

**步骤**

```bash
# 观察负载均衡把流量打到两个 instance
for i in 1 2 3 4 5 6; do curl -sS http://127.0.0.1/api/health | jq -r .instance; done
# 摘除 blue
docker compose stop api-blue
# 连续 20 次探测必须全部 200，且 instance 全是 green
for i in $(seq 1 20); do curl -fsS -o /dev/null -w "%{http_code} " http://127.0.0.1/api/health; done
docker compose start api-blue
```

**验收**：摘除期间入口 0 次非 2xx；恢复后 blue 重新进入轮询。

| 日期 | 环境 | 摘除对象 | 探测次数 / 失败 | 结果 | 操作人 |
|---|---|---|---|---|---|
| | 腾讯云首发 | | | 待做 | |

---

## D3 模型全部不可用（规则降级，服务不中断）

已有自动化：`e2e/ha.spec.ts`（`/api/llm/simulate {mode:all_down}` → 访客 <8s 收到受限模式回复并转人工）。本机 `pnpm e2e` 41 条含此用例。**不替代**生产上对真实备用 provider 的演练。

---

## 回滚

`./scripts/deploy.sh --rollback` 使用 `eight-projects-ai-service:previous`。发布前 `deploy.sh` 会先 `backup-db.sh` 并 tag 上一版镜像。
