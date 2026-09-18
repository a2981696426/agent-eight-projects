# 拆出为独立 GitHub 仓库

本项目目前以 `eight-projects-ai-service/` 子目录的形式提交在 `agent-eight-projects` 仓库的分支上（云端执行环境的 GitHub 凭据是仓库级安装令牌，没有创建新仓库的权限，因此无法直接替你新建云端仓库）。它本身是完整、自包含的 pnpm workspace，拆出只需一条命令。

## 步骤

1. 在 GitHub 新建一个**空**仓库（不勾选 README / .gitignore / License），例如 `eight-projects-ai-service`。
2. 在 `agent-eight-projects` 仓库根目录执行：

```bash
bash eight-projects-ai-service/scripts/extract-to-new-repo.sh git@github.com:<你的账号>/eight-projects-ai-service.git cursor/eight-projects-ai-service-2b57
```

脚本用 `git subtree split` 保留本目录的全部提交历史，克隆到临时目录、重设 remote 并推送 `main`。

3. 在新仓库中：

```bash
cp .env.example .env      # 填入 LLM_API_KEY
pnpm install
pnpm dev                  # http://localhost:5173
```

## 不拆出、直接在当前仓库使用

也可以直接进入子目录使用，与拆出后完全一致：

```bash
cd eight-projects-ai-service && pnpm install && pnpm dev
```

## 注意

- `.env` 已被忽略，不会随任何一种方式进入 Git；请不要把 API Key 写进代码或提交记录。
- `data/*.sqlite` 与 `artifacts/` 同样被忽略；首次启动会自动建库并写入演示数据。
