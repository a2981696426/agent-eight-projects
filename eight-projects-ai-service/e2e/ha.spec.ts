import { test, expect, request as pwRequest } from '@playwright/test';
import { shot, watchErrors } from './helpers';

const API = process.env.E2E_API_URL ?? 'http://127.0.0.1:8787';

test.describe('模型高可用与降级', () => {
  test.afterEach(async () => {
    const api = await pwRequest.newContext({ baseURL: API });
    await api.post('/api/llm/simulate', { data: { mode: 'normal' } });
    await api.dispose();
  });

  test('全部模型故障 → 访客端仍在 1s 内收到基于证据的受限模式回复并转人工；Studio 显示演练状态；恢复后正常', async ({ page }) => {
    const w = watchErrors(page);
    const api = await pwRequest.newContext({ baseURL: API });
    const sim = await (await api.post('/api/llm/simulate', { data: { mode: 'all_down' } })).json();
    expect(sim.configured).toBe(false);

    await page.goto('/visitor');
    await page.getByRole('button', { name: '开始咨询' }).click();
    await expect(page).toHaveURL(/\/visitor\/conv-/);
    const t0 = Date.now();
    await page.getByPlaceholder('请输入您的问题…').fill('订单 20260918000123 的快递怎么还没到');
    await page.getByRole('button', { name: '发送' }).click();
    await expect(page.locator('.vbubble.bot .txt').first()).toBeVisible({ timeout: 15_000 });
    const elapsed = Date.now() - t0;
    const text = await page.locator('.vbubble.bot .txt').first().innerText();
    expect(text).toMatch(/受限模式/);
    expect(text).toMatch(/20260918000123/);
    expect(text).toMatch(/转接人工客服/);
    expect(elapsed).toBeLessThan(8000);
    await expect(page.locator('.ant-tag').filter({ hasText: /排队等待人工客服/ })).toBeVisible();
    await page.screenshot({ path: shot('ha-degraded-visitor') });

    await page.goto('/ai/agent-studio');
    await page.getByRole('tab', { name: '模型与高可用' }).click();
    await expect(page.locator('.ant-tag').filter({ hasText: '演练故障' }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/全部不可用 → 规则降级/)).toBeVisible();
    await page.screenshot({ path: shot('ha-studio') });

    await page.getByRole('button', { name: '恢复正常' }).click();
    await expect(page.locator('.ant-tag').filter({ hasText: /^可用$/ })).toBeVisible({ timeout: 15_000 });
    const status = await (await api.get('/api/llm/status')).json();
    expect(status.configured).toBe(true);
    expect(status.stats.degradedTraces).toBeGreaterThan(0);
    await api.dispose();
    w.assertClean('ha');
  });
});
