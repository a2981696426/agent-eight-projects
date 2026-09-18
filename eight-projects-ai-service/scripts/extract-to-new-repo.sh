#!/usr/bin/env bash
# 把本目录（eight-projects-ai-service）从上级仓库中拆出为独立仓库并推送到你新建的 GitHub 仓库。
# 用法：先在 GitHub 上新建空仓库（不要初始化 README），然后在上级仓库根目录执行：
#   bash eight-projects-ai-service/scripts/extract-to-new-repo.sh git@github.com:<you>/eight-projects-ai-service.git [branch]
set -euo pipefail
REMOTE="${1:?用法: $0 <new-repo-git-url> [source-branch]}"
SRC_BRANCH="${2:-$(git rev-parse --abbrev-ref HEAD)}"
PREFIX="eight-projects-ai-service"
cd "$(git rev-parse --show-toplevel)"
echo "→ 从分支 $SRC_BRANCH 拆出 $PREFIX/（保留本目录的提交历史）"
SPLIT_SHA=$(git subtree split --prefix="$PREFIX" "$SRC_BRANCH")
TMP=$(mktemp -d)
git clone -q "$(pwd)" "$TMP/repo"
cd "$TMP/repo"
git checkout -q -b main "$SPLIT_SHA"
git remote remove origin
git remote add origin "$REMOTE"
echo "→ 推送到 $REMOTE (main)"
git push -u origin main
echo "✓ 完成。本地独立仓库位于：$TMP/repo"
echo "  下一步：cd $TMP/repo && cp .env.example .env && 填入 LLM_API_KEY && pnpm install && pnpm dev"
