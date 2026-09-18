import { test, expect } from '@playwright/test';
import { loginApi, shot, watchErrors } from './helpers';

test.describe('独立访客端', () => {
  test('开始咨询 → 机器人回复 → 坐席接管并回复可见 → 结束后评价；刷新后历史保留', async ({ page }) => {
    const w = watchErrors(page);
    await page.goto('/visitor');
    await expect(page.getByText('欢迎咨询欧态')).toBeVisible();
    await page.getByRole('button', { name: '开始咨询' }).click();
    await expect(page).toHaveURL(/\/visitor\/conv-/);
    const conversationId = page.url().split('/visitor/')[1];

    // 寒暄走规则，零模型调用
    await page.getByPlaceholder('请输入您的问题…').fill('你好');
    await page.getByRole('button', { name: '发送' }).click();
    await expect(page.locator('.vbubble.bot .txt').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.vbubble.bot .txt').first()).toContainText(/欢迎咨询/);

    // 人工确认场景：访客只看到等待提示，不看到候选话术
    await page.getByPlaceholder('请输入您的问题…').fill('20260910000321 刚买就降价了能退差价吗');
    await page.getByRole('button', { name: '发送' }).click();
    await expect(page.locator('.vbubble.bot .txt').nth(1)).toBeVisible({ timeout: 90_000 });
    const second = await page.locator('.vbubble.bot .txt').nth(1).innerText();
    expect(second).toMatch(/人工客服|转接/);

    // 坐席在工作台接管并回复（通过 API 模拟坐席端），访客端轮询后应看到人工消息
    const api = await loginApi('agent', 'agent123');
    await api.post(`/api/conversations/${conversationId}/control`, { data: { action: 'takeover', actor: '客服小欧' } });
    await api.post(`/api/conversations/${conversationId}/messages`, { data: { role: 'agent', text: '您好，我是人工客服小欧，已核实您的订单符合保价条件，稍后为您登记退差价。' } });
    await expect(page.locator('.vbubble.agent .txt').first()).toContainText('人工客服小欧', { timeout: 15_000 });
    await expect(page.locator('.ant-tag').filter({ hasText: /人工客服 客服小欧 为您服务/ })).toBeVisible();

    // 刷新后历史仍在（会话 ID 记在本地）
    await page.goto('/visitor');
    await expect(page).toHaveURL(new RegExp(conversationId));
    await expect(page.locator('.vbubble.agent .txt').first()).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: shot('visitor') });

    // 坐席结束会话 → 访客可评价
    await api.post(`/api/conversations/${conversationId}/control`, { data: { action: 'close', actor: '客服小欧' } });
    await expect(page.getByText(/本次服务已结束/)).toBeVisible({ timeout: 15_000 });
    await page.locator('.ant-rate-star').nth(4).click();
    await expect(page.getByText('感谢您的评价')).toBeVisible();
    const detail = await (await api.get(`/api/conversations/${conversationId}`)).json();
    expect(detail.conversation.satisfaction).toBe(5);
    await api.dispose();
    w.assertClean('visitor');
  });
});

