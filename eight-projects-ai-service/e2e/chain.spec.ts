import { test, expect } from '@playwright/test';
import { shot, watchErrors } from './helpers';

test.describe('核心执行链（真实大模型）', () => {
  test('在线机器人：物流查询 → 九阶段轨迹 → 决策', async ({ page }) => {
    const w = watchErrors(page);
    await page.goto('/ai/online-robot');
    await expect(page.locator('.ant-card-head-title').filter({ hasText: '访客端' })).toBeVisible();
    await page.getByPlaceholder('输入访客问题…').fill('订单 20260918000123 的快递三天没动了，什么情况？');
    await page.getByRole('button', { name: /发送/ }).click();
    // SSE 流式进度：处理期间应看到阶段芯片
    await expect(page.locator('.chain-progress')).toBeVisible({ timeout: 5_000 });
    // 等待机器人气泡出现（真实模型调用，最长 90s）
    await expect(page.locator('.bubble.bot .txt').first()).toBeVisible({ timeout: 90_000 });
    await expect(page.locator('.stage')).toHaveCount(9, { timeout: 20_000 });
    await expect(page.locator('.stage.ok')).toHaveCount(9);
    await expect(page.locator('.ant-tag').filter({ hasText: /^场景 logistics$/ })).toBeVisible();
    await expect(page.locator('.bubble.bot').first()).not.toContainText('正在思考');
    // 访客端气泡必须与轨迹「对客回复（实际发送）」逐字一致；候选话术只在人工确认/升级时另列
    const sent = (await page.locator('.reply-sent').innerText()).trim();
    const bubble = (await page.locator('.bubble.bot .txt').last().innerText()).trim();
    expect(bubble).toBe(sent);
    await page.screenshot({ path: shot('chain-logistics'), fullPage: true });
    w.assertClean('online-robot chain');
  });

  test('在线机器人：缺订单号先追问；投诉直接升级', async ({ page }) => {
    const w = watchErrors(page);
    await page.goto('/ai/online-robot');
    await page.getByPlaceholder('输入访客问题…').fill('我的快递到哪了');
    await page.getByRole('button', { name: /发送/ }).click();
    await expect(page.locator('.bubble.bot').first()).toBeVisible({ timeout: 90_000 });
    await expect(page.locator('.bubble.bot').first()).toContainText(/订单号/);
    await expect(page.getByText(/缺必填槽位/)).toBeVisible();

    await page.getByRole('button', { name: '新会话' }).click();
    await page.getByPlaceholder('输入访客问题…').fill('你们态度太差了，我要去 12315 投诉');
    await page.getByRole('button', { name: /发送/ }).click();
    await expect(page.locator('.bubble.bot').first()).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText(/升级人工/).first()).toBeVisible();
    await expect(page.getByText(/风险 L3/).first()).toBeVisible();
    w.assertClean('clarify + escalate');
  });

  test('坐席工作台：待接入会话可接管、AI 建议、发送人工回复', async ({ page }) => {
    const w = watchErrors(page);
    await page.goto('/reception/online');
    await expect(page.locator('.col-head').filter({ hasText: '会话列表' })).toBeVisible();
    // 选择第一条会话（列表按待接入优先排序）
    const first = page.locator('.conv-item').first();
    await first.click();
    await expect(page.getByText('客户 360')).toBeVisible();
    const takeover = page.getByRole('button', { name: '接管' });
    if (await takeover.isVisible()) await takeover.click();
    await page.getByRole('button', { name: 'AI 建议' }).click();
    await expect(page.getByText('AI 应答建议')).toBeVisible({ timeout: 90_000 });
    await page.getByRole('button', { name: '采用到输入框' }).click();
    const box = page.getByPlaceholder(/输入回复/);
    await expect(box).not.toHaveValue('');
    const before = await page.locator('.bubble.agent').count();
    await page.locator('button.ant-btn-primary').filter({ hasText: /^发送$/ }).click();
    await expect(page.locator('.bubble.agent')).toHaveCount(before + 1, { timeout: 15_000 });
    w.assertClean('workbench');
  });
});
