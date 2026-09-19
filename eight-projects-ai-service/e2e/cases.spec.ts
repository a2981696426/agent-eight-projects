import { test, expect } from '@playwright/test';
import { loginApi, shot, watchErrors } from './helpers';

test.describe('子案件 · 人工接续任务 · DMS 模拟', () => {
  test('DMS 不可用 → 待同步案件 → 恢复后「重试待同步」→ 已关联 DMS', async ({ page }) => {
    const w = watchErrors(page);
    const admin = await loginApi();
    await admin.post('/api/dms/simulate', { data: { mode: 'unavailable' } });
    const created = await (await admin.post('/api/cases', { data: { title: `e2e 待同步 ${Date.now()}`, type: '退款', priority: 'P2' } })).json();
    const linked = await (await admin.post(`/api/cases/${created.id}/dms/link`, { data: {} })).json();
    expect(linked.dms.pending).toBe(true);
    expect(linked.status).toBe('pending_human');

    await page.goto('/reception/cases');
    await page.getByRole('tab', { name: '子案件' }).click();
    await page.getByText(created.title).first().click();
    const drawer = page.locator('.ant-drawer');
    await expect(drawer.getByText('待同步案件').first()).toBeVisible();
    await expect(drawer.getByText(/待同步：DMS 不可用/)).toBeVisible();
    await page.keyboard.press('Escape');

    // 管理员在「DMS 模拟」Tab 切回正常并重试
    await page.getByRole('tab', { name: 'DMS 模拟' }).click();
    await page.locator('.ant-tabs-tabpane-active .ant-select').first().click();
    await page.getByTitle('正常').click();
    await page.getByRole('button', { name: '重试待同步' }).click();
    await expect(page.locator('.ant-message')).toContainText(/仍待同步 0/);

    const after = await (await admin.get(`/api/cases/${created.id}`)).json();
    expect(after.status).toBe('linked_dms');
    expect(after.dms.ticketNo).toMatch(/^DMS-/);
    await page.screenshot({ path: shot('cases-dms-retry') });
    await admin.dispose();
    w.assertClean('cases-dms');
  });

  test('访客投诉 → 转人工回复含预计响应时窗 → 接续任务 P1 待接续 → 认领并接管 → 跳转会话；同会话再次触发不新建任务', async ({ page }) => {
    const w = watchErrors(page);
    // 访客端：投诉走 L3 直升
    await page.goto('/visitor');
    await page.getByRole('button', { name: '开始咨询' }).click();
    await expect(page).toHaveURL(/\/visitor\/conv-/);
    const conversationId = page.url().split('/visitor/')[1];
    await page.getByPlaceholder('请输入您的问题…').fill('你们太差了，我要去 12315 投诉');
    await page.getByRole('button', { name: '发送' }).click();
    await expect(page.locator('.vbubble.bot .txt').first()).toBeVisible({ timeout: 90_000 });
    const reply = await page.locator('.vbubble.bot .txt').first().innerText();
    expect(reply).toMatch(/人工客服/);
    expect(reply).toMatch(/预计|专人/);
    expect(reply).not.toMatch(/完成|一定/);

    const admin = await loginApi();
    const tasks = await (await admin.get('/api/handoffs?status=pending')).json();
    const task = tasks.find((t: { conversationId: string }) => t.conversationId === conversationId);
    expect(task).toBeTruthy();
    expect(task.status).toBe('pending');
    expect(task.reason.length).toBeGreaterThan(0);
    expect(task.progress.doneStages).toContain('intent');
    expect(task.windowText).toMatch(/预计|专人/);

    // 工作台认领并接管 → 跳转在线客服并选中该会话
    await page.goto('/reception/cases');
    const row = page.locator('[data-testid="handoff-row"]').filter({ hasText: task.id });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: '认领并接管' }).click();
    await expect(page).toHaveURL(new RegExp(`/reception/online\\?conv=${conversationId}`));
    await expect(page.locator('.handoff-banner')).toContainText(/接续中 · 管理员/);
    await expect(page.locator('.col-head').filter({ hasText: /人工 · 管理员/ })).toBeVisible();
    await page.screenshot({ path: shot('handoff-claimed') });

    // 同会话再次转人工（坐席转排队）→ 仍只有一个活动任务
    await admin.post(`/api/conversations/${conversationId}/control`, { data: { action: 'handoff', reason: 'e2e 再次排队' } });
    const active = await (await admin.get('/api/handoffs?status=pending|claimed')).json();
    expect(active.filter((t: { conversationId: string }) => t.conversationId === conversationId)).toHaveLength(1);
    await admin.dispose();
    w.assertClean('handoff');
  });
});
