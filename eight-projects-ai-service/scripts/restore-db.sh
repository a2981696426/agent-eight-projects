#!/usr/bin/env bash
# 恢复（含演练）：./scripts/restore-db.sh backups/eight-YYYYMMDD-HHMM.dump
# 先恢复到 eight_restore，再原子交换数据库名；旧库保留为 eight_old_<epoch>，确认无误后手动 DROP。
set -euo pipefail
cd "$(dirname "$0")/.."
FILE="${1:?用法: restore-db.sh <dump 文件>}"
[[ -f "$FILE" ]] || { echo "文件不存在: $FILE"; exit 1; }

echo "[1/4] 停止应用（两个副本），避免恢复期间写入"
docker compose stop api-blue api-green

echo "[2/4] 恢复到临时库 eight_restore"
docker compose exec -T postgres psql -U eight -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS eight_restore;" \
  -c "CREATE DATABASE eight_restore OWNER eight;"
docker compose exec -T postgres pg_restore -U eight -d eight_restore --no-owner --no-privileges < "$FILE"

echo "[3/4] 交换数据库名（旧库保留）"
OLD="eight_old_$(date +%s)"
docker compose exec -T postgres psql -U eight -d postgres -v ON_ERROR_STOP=1 \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='eight' AND pid<>pg_backend_pid();" \
  -c "ALTER DATABASE eight RENAME TO ${OLD};" \
  -c "ALTER DATABASE eight_restore RENAME TO eight;"

echo "[4/4] 启动应用"
docker compose start api-blue api-green
echo "restored from $FILE; previous database kept as ${OLD} (drop it manually after verification)"
