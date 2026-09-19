import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = resolve(here, '../../..');

// Node 22 内置 .env 加载；根目录 .env 不入库，.env.example 作为模板
for (const candidate of [resolve(ROOT_DIR, '.env'), resolve(here, '../.env')]) {
  if (existsSync(candidate)) {
    try {
      process.loadEnvFile(candidate);
    } catch {
      /* 已加载或格式问题时忽略，运行时以已有环境变量为准 */
    }
  }
}

export const env = {
  apiPort: Number(process.env.API_PORT ?? 8787),
  dataDir: resolve(here, '..', process.env.DATA_DIR ?? '../../data'),
  /** 非空 → pg 连接 PostgreSQL；空 → PGlite 进程内 Postgres（本机/测试零依赖） */
  databaseUrl: process.env.DATABASE_URL ?? '',
  /** PGlite 数据目录；DATA_DIR=:memory: 时为 null（内存库） */
  pgliteDir: process.env.DATA_DIR === ':memory:' ? null : resolve(here, '..', process.env.DATA_DIR ?? '../../data', 'pglite'),
  /** 生产模式：API 托管 apps/web/dist（单端口部署） */
  serveWeb: process.env.SERVE_WEB === '1' || process.env.NODE_ENV === 'production',
  webDist: resolve(ROOT_DIR, 'apps/web/dist'),
  sessionSecret: process.env.SESSION_SECRET ?? 'eight-projects-dev-secret-change-me-32chars',
  llm: {
    baseUrl: process.env.LLM_BASE_URL ?? 'https://api.deepseek.com',
    apiKey: process.env.LLM_API_KEY ?? '',
    modelFast: process.env.LLM_MODEL_FAST ?? 'deepseek-flash',
    modelReasoning: process.env.LLM_MODEL_REASONING ?? 'deepseek-flash',
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 60_000),
  },
  /** 备用 provider（可选）：任何兼容 OpenAI 协议的端点；主 provider 熔断/失败时自动切换 */
  llmFallback: {
    baseUrl: process.env.LLM_FALLBACK_BASE_URL ?? '',
    apiKey: process.env.LLM_FALLBACK_API_KEY ?? '',
    modelFast: process.env.LLM_FALLBACK_MODEL_FAST ?? process.env.LLM_FALLBACK_MODEL ?? '',
    modelReasoning: process.env.LLM_FALLBACK_MODEL_REASONING ?? process.env.LLM_FALLBACK_MODEL ?? '',
  },
  /** LLM_MOCK=1：离线确定性假模型（e2e / 无网络演示），不会与真实 provider 混用 */
  llmMock: process.env.LLM_MOCK === '1',
  router: {
    failureThreshold: Number(process.env.LLM_CIRCUIT_FAILURES ?? 3),
    cooldownMs: Number(process.env.LLM_CIRCUIT_COOLDOWN_MS ?? 30_000),
    maxRetries: Number(process.env.LLM_MAX_RETRIES ?? 1),
  },
};
