#!/usr/bin/env bash
# 蓝绿发布（单机零中断）：构建新镜像 → 先轮换 blue、再轮换 green；每个副本等 /api/health 通过后再动下一个。
# 用法：./scripts/deploy.sh            # 发布当前工作树
#       ./scripts/deploy.sh --rollback # 用上一版镜像（eight-projects-ai-service:previous）回滚
set -euo pipefail
cd "$(dirname "$0")/.."
IMAGE=eight-projects-ai-service
HEALTH_URL="http://127.0.0.1:${HTTP_PORT:-80}/api/health"

wait_healthy() { # $1 = 容器名
  for i in $(seq 1 60); do
    status=$(docker inspect -f '{{.State.Health.Status}}' "$1" 2>/dev/null || echo starting)
    [[ "$status" == "healthy" ]] && return 0
    sleep 2
  done
  echo "!! $1 在 120 秒内未健康，中止发布（另一副本仍在服务）"; docker logs --tail 50 "$1"; return 1
}

if [[ "${1:-}" == "--rollback" ]]; then
  docker image inspect "$IMAGE:previous" >/dev/null 2>&1 || { echo "没有可回滚的镜像 $IMAGE:previous"; exit 1; }
  docker tag "$IMAGE:previous" "$IMAGE:latest"
  echo "[rollback] 使用上一版镜像"
else
  echo "[1/4] 备份数据库"; ./scripts/backup-db.sh
  echo "[2/4] 构建镜像"
  docker image inspect "$IMAGE:latest" >/dev/null 2>&1 && docker tag "$IMAGE:latest" "$IMAGE:previous"
  docker compose build api-blue
fi

echo "[3/4] 轮换 blue"
docker compose up -d --no-deps --no-build api-blue
wait_healthy eight-api-blue
echo "[4/4] 轮换 green"
docker compose up -d --no-deps --no-build api-green
wait_healthy eight-api-green
docker compose up -d caddy postgres >/dev/null
echo "done: $(curl -fsS "$HEALTH_URL" | head -c 200 || echo '(caddy 未监听本机端口，跳过入口探测)')"
