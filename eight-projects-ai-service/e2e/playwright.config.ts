import { defineConfig } from '@playwright/test';

const WEB = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: '../playwright-report' }]],
  outputDir: '../test-results',
  use: {
    baseURL: WEB,
    channel: 'chrome',
    headless: true,
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    // 先以管理员登录并保存会话，其余用例复用（访客端/登录用例自行控制登录态）
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    { name: 'chromium', dependencies: ['setup'], use: { storageState: 'e2e/.auth/admin.json' }, testIgnore: /auth\.setup\.ts/ },
  ],
});
