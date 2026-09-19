#!/usr/bin/env bash
# 每日备份：pg_dump 自定义格式 → backups/eight-YYYYMMDD-HHMM.dump，本地保留 30 天。
# 可选上传腾讯云 COS：设置 COS_BUCKET（如 my-bucket-1250000000）且已安装 coscli 时执行。
# crontab 示例：0 3 * * * /opt/eight/scripts/backup-db.sh >> /var/log/eight-backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p backups
STAMP=$(date +%Y%m%d-%H%M)
FILE="backups/eight-${STAMP}.dump"
docker compose exec -T postgres pg_dump -U eight -d eight -Fc > "$FILE"
find backups -name 'eight-*.dump' -mtime +30 -delete
echo "backup written: $FILE ($(du -h "$FILE" | cut -f1))"
if [[ -n "${COS_BUCKET:-}" ]] && command -v coscli >/dev/null 2>&1; then
  coscli cp "$FILE" "cos://${COS_BUCKET}/eight-backups/$(basename "$FILE")"
  echo "uploaded to cos://${COS_BUCKET}/eight-backups/$(basename "$FILE")"
fi
