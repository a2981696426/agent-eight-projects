import { test, expect } from '@playwright/test';
import { shot, watchErrors } from './helpers';

test.describe('服务管理与数字员工', () => {
  test('智能质检：运行规则+语义质检 → 结果 → 人工复核', async ({ page }) => {
    const w = watchErrors(page);
    await page.goto('/management/quality');
    await page.getByRole('button', { name: /运行质检/ }).click();
    await expect(page.locator('.ant-message').getByText(/已质检 \d+ 个会话/)).toBeVisible({ timeout: 170_000 });
    const firstRow = page.locator('.ant-table-tbody tr').filter({ hasText: /conv-/ }).first();
    await expect(firstRow).toBeVisible();
    await firstRow.click();
    await page.getByPlaceholder(/复核意见/).fill('同意机器判断');
    await page.getByRole('button', { name: '提交复核' }).click();
    await expect(page.locator('.ant-tag').filter({ hasText: '质检员李明' }).first()).toBeVisible();
    await page.screenshot({ path: shot('quality') });
    w.assertClean('quality');
  });

  test('自定义报表：切换维度/指标并保存', async ({ page }) => {
    const w = watchErrors(page);
    await page.goto('/management/reports');
    await expect(page.locator('.ant-table-tbody tr').first()).toBeVisible({ timeout: 15_000 });
    await page.locator('.ant-select').filter({ hasText: '数据集' }).click();
    await page.getByTitle('数据集：执行链').click();
    await page.getByRole('button', { name: '运行报表' }).click();
    await expect(page.locator('.ant-card-head-title').filter({ hasText: /执行链 ·/ })).toBeVisible();
    await page.getByPlaceholder('保存为…').fill('e2e 执行链场景报表');
    await page.getByRole('button', { name: '保存' }).click();
    await expect(page.getByText('e2e 执行链场景报表')).toBeVisible();
    await page.screenshot({ path: shot('reports') });
    w.assertClean('reports');
  });

  test('数据大屏：KPI 与图表渲染', async ({ page }) => {
    const w = watchErrors(page);
    await page.goto('/management/dashboard');
    await expect(page.getByText('实时运营大屏')).toBeVisible();
    await expect(page.getByText('机器人自主解决率')).toBeVisible();
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: shot('dashboard'), fullPage: true });
    w.assertClean('dashboard');
  });

  test('客户之声：分析 → 主题图表 → AI 提问', async ({ page }) => {
    const w = watchErrors(page);
    await page.goto('/management/voc');
    await page.getByRole('button', { name: /分析未标注/ }).click();
    await expect(page.locator('.ant-message').getByText(/累计 \d+ 条/)).toBeVisible({ timeout: 120_000 });
    await expect(page.locator('.ant-table-tbody tr').first()).toBeVisible();
    await page.getByRole('button', { name: '提问' }).click();
    await expect(page.getByText(/基于 \d+ 条样本/).first()).toBeVisible({ timeout: 90_000 });
    await page.screenshot({ path: shot('voc'), fullPage: true });
    w.assertClean('voc');
  });

  test('数字员工：发票智能体沙箱运行', async ({ page }) => {
    const w = watchErrors(page);
    await page.goto('/employees');
    await page.locator('.ant-card').filter({ hasText: '发票智能体' }).first().click();
    await page.getByRole('button', { name: /运行（沙箱）/ }).click();
    await expect(page.locator('.stage')).toHaveCount(9, { timeout: 90_000 });
    await expect(page.locator('.ant-tag').filter({ hasText: /^场景 invoice$/ })).toBeVisible();
    await expect(page.locator('.ant-table-tbody tr').first()).toBeVisible();
    await page.screenshot({ path: shot('employees'), fullPage: true });
    w.assertClean('employees');
  });
});
