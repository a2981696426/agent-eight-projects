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
  llm: {
    baseUrl: process.env.LLM_BASE_URL ?? 'https://api.deepseek.com',
    apiKey: process.env.LLM_API_KEY ?? '',
    modelFast: process.env.LLM_MODEL_FAST ?? 'deepseek-flash',
    modelReasoning: process.env.LLM_MODEL_REASONING ?? 'deepseek-flash',
  },
};
