import { expect, request as pwRequest, type APIRequestContext, type Page } from '@playwright/test';

export const API = process.env.E2E_API_URL ?? 'http://127.0.0.1:8787';

/** 以指定账号登录后的 API 请求上下文（Cookie 会话） */
export async function loginApi(username = 'admin', password = 'admin123'): Promise<APIRequestContext> {
  const ctx = await pwRequest.newContext({ baseURL: API });
  const r = await ctx.post('/api/auth/login', { data: { username, password } });
  expect(r.ok(), `登录 ${username} 失败`).toBeTruthy();
  return ctx;
}
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 截图统一落到项目内 artifacts/e2e（已 gitignore），不写入上级目录 */
export function shot(name: string) {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../artifacts/e2e');
  mkdirSync(dir, { recursive: true });
  return resolve(dir, `${name}.png`);
}

/** 收集页面运行期错误：console.error、pageerror、非 2xx/3xx 的 /api 请求 */
export function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()} @ ${m.location().url}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('response', (r) => {
    if (r.url().includes('/api/') && r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.request().method()} ${r.url()}`);
  });
  return {
    errors,
    assertClean(context: string) {
      const filtered = errors.filter((e) => !/favicon|ResizeObserver loop|third-party cookie|Download the React DevTools/i.test(e));
      expect(filtered, `${context} 不应有运行期错误`).toEqual([]);
    },
  };
}

export const ROUTES: { path: string; heading: RegExp }[] = [
  { path: '/', heading: /系统总览/ },
  { path: '/reception/online', heading: /坐席工作台/ },
  { path: '/reception/call-center', heading: /呼叫中心/ },
  { path: '/reception/video', heading: /视频客服/ },
  { path: '/reception/tickets', heading: /工单/ },
  { path: '/ai/online-robot', heading: /在线机器人/ },
  { path: '/ai/inbound-robot', heading: /呼入机器人/ },
  { path: '/ai/outbound', heading: /外呼/ },
  { path: '/ai/aigc', heading: /AIGC/ },
  { path: '/ai/agent-studio', heading: /Agent Studio/ },
  { path: '/ai/mind-studio', heading: /Mind Studio/ },
  { path: '/management/quality', heading: /质检/ },
  { path: '/management/reports', heading: /报表/ },
  { path: '/management/dashboard', heading: /大屏|实时/ },
  { path: '/management/voc', heading: /客户之声/ },
  { path: '/employees', heading: /数字员工/ },
  { path: '/private-domain', heading: /AI 私域/ },
  { path: '/visitor', heading: /欢迎咨询欧态|欧态官方客服/ },
  { path: '/login', heading: /登录|系统总览/ }, // 已登录态会被重定向回总览
];
