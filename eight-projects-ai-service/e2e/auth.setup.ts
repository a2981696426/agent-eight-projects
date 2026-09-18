import { test as setup, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const file = resolve(dirname(fileURLToPath(import.meta.url)), '.auth/admin.json');

setup('以管理员登录并保存会话', async ({ page }) => {
  mkdirSync(dirname(file), { recursive: true });
  await page.goto('/login');
  await page.getByLabel('用户名').fill('admin');
  await page.getByLabel('密码').fill('admin123');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText('系统总览')).toBeVisible();
  await page.context().storageState({ path: file });
});
