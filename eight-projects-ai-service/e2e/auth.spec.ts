import { test, expect, request as pwRequest } from '@playwright/test';
import { API, loginApi, shot, watchErrors } from './helpers';

test.describe('登录与角色权限', () => {
  test.use({ storageState: { cookies: [], origins: [] } }); // 本组用例从未登录态开始

  test('未登录访问管理端跳转登录页；登录后回到来源页；退出后再次拦截', async ({ page }) => {
    const w = watchErrors(page);
    await page.goto('/reception/tickets');
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel('用户名').fill('agent');
    await page.getByLabel('密码').fill('agent123');
    await page.getByRole('button', { name: '登录' }).click();
    await expect(page).toHaveURL(/\/reception\/tickets$/);
    await expect(page.getByText('客服小欧 · 欧态旗舰店')).toBeVisible();
    await page.screenshot({ path: shot('auth-agent-tickets') });
    // 坐席在 Agent Studio 看不到发布按钮
    await page.goto('/ai/agent-studio');
    await expect(page.getByText('只读：配置发布需管理员')).toBeVisible();
    await expect(page.getByRole('button', { name: /发布新版本/ })).toHaveCount(0);
    // 退出
    await page.getByText('客服小欧 · 欧态旗舰店').click();
    await page.getByText('退出登录').click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
    w.assertClean('auth');
  });

  test('API：未登录 401；坐席发布 Agent 403；管理员 200；访客端接口无需登录', async () => {
    const anon = await pwRequest.newContext({ baseURL: API });
    expect((await anon.get('/api/tickets')).status()).toBe(401);
    expect((await anon.get('/api/health')).status()).toBe(200);
    const conv = await (await anon.post('/api/conversations', { data: { channel: 'web', customerId: 'cust-002', title: '匿名访客', mode: 'bot' } })).json();
    expect(conv.id).toMatch(/^conv-/);
    expect((await anon.get(`/api/conversations/${conv.id}`)).status()).toBe(200);
    await anon.dispose();

    const agent = await loginApi('agent', 'agent123');
    expect((await agent.get('/api/tickets')).status()).toBe(200);
    const forbidden = await agent.post('/api/agents/agent-cs-main/publish', { data: { note: 'e2e' } });
    expect(forbidden.status()).toBe(403);
    expect((await forbidden.json()).error).toMatch(/无权/);
    expect((await agent.post('/api/llm/simulate', { data: { mode: 'normal' } })).status()).toBe(403);
    await agent.dispose();

    const analyst = await loginApi('analyst', 'analyst123');
    expect((await analyst.post(`/api/conversations/${conv.id}/control`, { data: { action: 'takeover' } })).status()).toBe(403);
    expect((await analyst.get('/api/quality/report')).status()).toBe(200);
    await analyst.dispose();

    const admin = await loginApi();
    expect((await admin.post('/api/llm/simulate', { data: { mode: 'normal' } })).status()).toBe(200);
    const audit = await (await admin.get('/api/audit')).json();
    expect(audit.some((a: { action: string }) => a.action === 'auth.forbidden')).toBe(true);
    await admin.dispose();
  });
});
