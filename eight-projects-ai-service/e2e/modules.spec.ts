import { test, expect } from '@playwright/test';
import { shot, watchErrors } from './helpers';

test.describe('系统基座', () => {
  test('子案件：新建 → 开始处理 → 关联 DMS（自动建单）→ 已关联 DMS → 归档；本地没有"已解决"', async ({ page }) => {
    const w = watchErrors(page);
    await page.goto('/reception/cases');
    await page.getByRole('tab', { name: '子案件' }).click();
    await page.getByRole('button', { name: /新建子案件/ }).click();
    const title = `e2e 子案件 ${Date.now()}`;
    await page.getByLabel('标题').fill(title);
    await page.getByLabel('描述').fill('自动化测试创建');
    await page.getByRole('button', { name: '创建' }).click();
    await expect(page.getByText(title).first()).toBeVisible();
    await page.getByText(title).first().click();
    const drawer = page.locator('.ant-drawer');
    await drawer.getByRole('button', { name: '开始处理' }).click();
    await expect(drawer.getByText('处理中').first()).toBeVisible();
    await expect(drawer.getByRole('button', { name: /标记解决|已解决/ })).toHaveCount(0);
    await drawer.getByRole('button', { name: /关联 DMS/ }).click();
    await expect(drawer.locator('.dms-no')).toHaveText(/^DMS-\d{8}-\d{4}$/);
    await expect(drawer.getByText('已关联 DMS').first()).toBeVisible();
    await drawer.getByPlaceholder(/处理备注/).fill('DMS 已受理');
    await drawer.getByRole('button', { name: '归档' }).click();
    await expect(drawer.getByText('已归档').first()).toBeVisible();
    await expect(drawer.getByText(/备注：DMS 已受理/)).toBeVisible();
    await page.screenshot({ path: shot('cases') });
    w.assertClean('cases');
  });
});
