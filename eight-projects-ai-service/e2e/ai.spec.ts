import { test, expect } from '@playwright/test';
import { shot, watchErrors } from './helpers';

test.describe('智能增强', () => {
  test('Mind Studio：新建资料 → 发布 → 检索命中 → 使用追溯', async ({ page }) => {
    const w = watchErrors(page);
    await page.goto('/ai/mind-studio');
    await page.getByRole('button', { name: /新建资料/ }).click();
    const title = `e2e 加固贴说明 ${Date.now()}`;
    await page.getByLabel('标题').fill(title);
    await page.getByLabel(/标签/).fill('产品,加固贴');
    await page.getByLabel(/正文/).fill('加固贴用于固定传感器，出汗或洗澡后如边缘翘起可更换新的加固贴。每盒附赠 3 片，可在店铺单独购买补充装。');
    await page.getByRole('button', { name: /保存草稿/ }).click();
    const row = page.locator('tr').filter({ hasText: title });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: /发布/ }).click();
    await expect(row.getByText('已发布')).toBeVisible();
    await page.getByRole('tab', { name: '检索测试台' }).click();
    await page.getByPlaceholder(/输入用户可能的问法/).fill('加固贴翘起来了怎么办');
    await page.getByRole('button', { name: /检索/ }).click();
    await expect(page.locator('.ant-tabs-tabpane-active').getByText(title).first()).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: shot('mind-studio-search') });
    w.assertClean('mind-studio');
  });

  test('Agent Studio：修改白名单 → 测试台试跑 → 发布 → 版本列表', async ({ page }) => {
    const w = watchErrors(page);
    await page.goto('/ai/agent-studio');
    await expect(page.getByLabel('名称')).toHaveValue(/客服/, { timeout: 15_000 });
    await page.getByRole('tab', { name: '测试台' }).click();
    await page.getByRole('button', { name: /运行执行链/ }).click();
    await expect(page.locator('.stage')).toHaveCount(9, { timeout: 90_000 });
    await expect(page.locator('.ant-tag').filter({ hasText: /^场景 refund_price_diff$/ })).toBeVisible();
    await page.screenshot({ path: shot('agent-studio-test'), fullPage: true });
    await page.getByRole('button', { name: /发布新版本/ }).click();
    await expect(page.getByText(/已发布 v\d+/).first()).toBeVisible({ timeout: 15_000 });
    await page.getByRole('tab', { name: /版本/ }).click();
    await expect(page.locator('.ant-tabs-tabpane-active tr').filter({ hasText: '当前' }).first()).toBeVisible();
    w.assertClean('agent-studio');
  });

  test('呼入机器人：模拟来电走 IVR 并接入执行链', async ({ page }) => {
    const w = watchErrors(page);
    await page.goto('/ai/inbound-robot');
    await expect(page.getByText('流程节点')).toBeVisible();
    await page.getByRole('button', { name: /模拟来电/ }).click();
    await expect(page.getByText(/执行链 tr-/)).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText(/"orderId":"20260918000123"/)).toBeVisible();
    await page.screenshot({ path: shot('inbound-robot') });
    w.assertClean('inbound');
  });

  test('AIGC：会话小记生成并记录用量', async ({ page }) => {
    const w = watchErrors(page);
    await page.goto('/ai/aigc');
    await page.locator('.ant-card').filter({ hasText: '会话小记' }).first().click();
    await page.getByRole('button', { name: /生成/ }).click();
    await expect(page.locator('pre').filter({ hasText: /"problem"/ })).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('tr').filter({ hasText: 'summary' }).first()).toBeVisible();
    await page.screenshot({ path: shot('aigc-summary') });
    w.assertClean('aigc');
  });

  test('AI 外呼：运行模拟外呼并回写结果', async ({ page }) => {
    const w = watchErrors(page);
    await page.goto('/ai/outbound');
    await page.getByRole('button', { name: /开始外呼|重跑/ }).first().click();
    await expect(page.getByText(/接通 \d+/).first()).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('.ant-tag').filter({ hasText: /接通·|未接听|忙线/ }).first()).toBeVisible();
    await page.screenshot({ path: shot('outbound') });
    w.assertClean('outbound');
  });
});
