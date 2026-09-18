import { test, expect } from '@playwright/test';
import { ROUTES, shot, watchErrors } from './helpers';

test.describe('全部页面可加载且无运行期错误', () => {
  for (const r of ROUTES) {
    test(`页面 ${r.path}`, async ({ page }) => {
      const w = watchErrors(page);
      await page.goto(r.path);
      await expect(page.locator('body')).toContainText(r.heading, { timeout: 20_000 });
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(600);
      w.assertClean(r.path);
      await page.screenshot({ path: shot(`page${r.path.replace(/\//g, '_') || '_root'}`), fullPage: false });
    });
  }
});
