import { test, expect } from '@playwright/test';
import { shot, watchErrors } from './helpers';

test.describe('系统基座', () => {
  test('工单：新建 → 开始处理 → 备注 → 解决，流转记录可见', async ({ page }) => {
    const w = watchErrors(page);
    await page.goto('/reception/tickets');
    await page.getByRole('button', { name: /新建工单/ }).click();
    const title = `e2e 工单 ${Date.now()}`;
    await page.getByLabel('标题').fill(title);
    await page.getByLabel('描述').fill('自动化测试创建');
    await page.getByRole('button', { name: '创 建' }).or(page.getByRole('button', { name: '创建' })).click();
    await expect(page.getByText(title).first()).toBeVisible();
    await page.getByText(title).first().click();
    await page.getByRole('button', { name: '开始处理' }).click();
    await expect(page.locator('.ant-drawer').getByText('处理中').first()).toBeVisible();
    await page.getByPlaceholder(/处理备注/).fill('已联系快递');
    await page.getByRole('button', { name: '标记解决' }).click();
    await expect(page.locator('.ant-drawer').getByText('已解决').first()).toBeVisible();
    await expect(page.locator('.ant-drawer').getByText(/备注：已联系快递/)).toBeVisible();
    await page.screenshot({ path: shot('tickets') });
    w.assertClean('tickets');
  });
});
