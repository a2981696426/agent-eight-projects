# ── 多阶段构建：安装依赖 → 构建前端 → 精简运行镜像（API 托管前端，单端口） ──
FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1
RUN corepack enable && corepack prepare pnpm@11.5.2 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/agent-core/package.json packages/agent-core/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm --filter @eight/web build

FROM base AS runtime
ENV NODE_ENV=production SERVE_WEB=1 API_PORT=8787 DATA_DIR=/data
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /app/packages/agent-core/node_modules ./packages/agent-core/node_modules
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
COPY --from=build /app/apps/web/dist ./apps/web/dist
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:8787/api/health || exit 1
# tsx 位于 apps/api 的依赖中，从该目录启动
WORKDIR /app/apps/api
CMD ["node", "--import", "tsx", "src/server.ts"]
