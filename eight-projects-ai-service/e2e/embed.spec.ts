import { test, expect, request as pwRequest } from '@playwright/test';
import { API, shot, watchErrors } from './helpers';

test.describe('官网嵌入脚本', () => {
  test.use({ storageState: { cookies: [], origins: [] } }); // 第三方站点访客，未登录

  test('演示页浮动按钮 → iframe 访客端匿名自动开始 → 机器人回复 → 刷新后历史保留 → 会话渠道为 web', async ({ page }) => {
    const w = watchErrors(page);
    await page.goto('/embed-demo.html');
    const btn = page.getByRole('button', { name: '欧态在线客服' });
    await expect(btn).toBeVisible();
    await btn.click();
    const frame = page.frameLocator('iframe[title="欧态在线客服"]');
    await expect(frame.getByPlaceholder('请输入您的问题…')).toBeVisible({ timeout: 20_000 });
    await frame.getByPlaceholder('请输入您的问题…').fill('你好');
    await frame.getByRole('button', { name: '发送' }).click();
    await expect(frame.locator('.vbubble.bot .txt').first()).toContainText(/欢迎咨询/, { timeout: 30_000 });
    await page.screenshot({ path: shot('embed') });

    // iframe 内 URL 含会话 ID 与 embed 参数
    const iframeUrl = await page.locator('iframe[title="欧态在线客服"]').evaluate((el) => (el as HTMLIFrameElement).contentWindow?.location.href ?? '');
    expect(iframeUrl).toMatch(/\/visitor\/conv-[^/?]+\?embed=1&channel=web&site=embed-demo/);
    const conversationId = /\/visitor\/(conv-[^/?]+)/.exec(iframeUrl)![1];

    // 刷新页面再次打开：同一会话、历史仍在
    await page.reload();
    await page.getByRole('button', { name: '欧态在线客服' }).click();
    await expect(frame.locator('.vbubble.bot .txt').first()).toContainText(/欢迎咨询/, { timeout: 20_000 });
    const again = await page.locator('iframe[title="欧态在线客服"]').evaluate((el) => (el as HTMLIFrameElement).contentWindow?.location.href ?? '');
    expect(again).toContain(conversationId);

    const anon = await pwRequest.newContext({ baseURL: API });
    const detail = await (await anon.get(`/api/conversations/${conversationId}`)).json();
    expect(detail.conversation.channel).toBe('web');
    expect(detail.conversation.title).toContain('embed-demo');
    await anon.dispose();
    w.assertClean('embed');
  });
});
