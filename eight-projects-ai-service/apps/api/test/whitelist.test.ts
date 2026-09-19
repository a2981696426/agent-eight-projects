import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATA_DIR = ':memory:';
process.env.WORK_HOURS = '09:00-18:00';
process.env.WORK_DAYS = '1,2,3,4,5';

const { initDb, closeDb } = await import('../src/db.ts');
const { scopeOfChannel, activeWhitelist, whitelistFor, createDraft, signWhitelist, publishWhitelist, disableWhitelist, listWhitelists, clearWhitelistCache } = await import('../src/services/whitelist.ts');

const workday = new Date(2026, 8, 18, 10, 0, 0); // 周五 10:00
const offHours = new Date(2026, 8, 19, 10, 0, 0); // 周六

before(async () => {
  await initDb();
});
after(async () => {
  await closeDb();
});

test('scopeOfChannel：web/app/wechat → owned；taobao/douyin/jd → platform', () => {
  assert.equal(scopeOfChannel('web'), 'owned');
  assert.equal(scopeOfChannel('wechat'), 'owned');
  assert.equal(scopeOfChannel('app'), 'owned');
  assert.equal(scopeOfChannel('taobao'), 'platform');
  assert.equal(scopeOfChannel('jd'), 'platform');
});

test('无 published 白名单 → 默认拒绝（CS-008B）', async () => {
  const gate = await whitelistFor('web', workday);
  assert.equal(gate.version, null);
  assert.equal(gate.allows('logistics', 'L0').allowed, false);
});

test('草稿 → 签发 → 发布：owned 全时段按 items 与风险上限判定', async () => {
  const d = await createDraft('owned', [{ scenario: 'logistics', maxRisk: 'L1' }, { scenario: 'presale', maxRisk: 'L0' }], '初版', '售后负责人');
  assert.equal(d.status, 'draft');
  assert.equal(d.version, 1);
  await assert.rejects(publishWhitelist(d.id, '管理员'), /签发/); // 未签发不能发布
  const s = await signWhitelist(d.id, '售后负责人');
  assert.equal(s.status, 'signed');
  assert.equal(s.signedBy, '售后负责人');
  const p = await publishWhitelist(d.id, '管理员');
  assert.equal(p.status, 'published');
  assert.equal(p.publishedBy, '管理员');

  const gate = await whitelistFor('wechat', offHours); // 自有渠道不看时段
  assert.equal(gate.version, 'owned@1');
  assert.equal(gate.allows('logistics', 'L1').allowed, true);
  assert.equal(gate.allows('logistics', 'L2').allowed, false);
  assert.equal(gate.allows('presale', 'L1').allowed, false, 'presale 上限 L0');
  assert.equal(gate.allows('refund_price_diff', 'L0').allowed, false);
});

test('platform：工作时段一律拒绝（辅助模式），非工作时段按 items', async () => {
  const d = await createDraft('platform', [{ scenario: 'logistics', maxRisk: 'L1' }], '平台夜间', '售后负责人');
  await signWhitelist(d.id, '售后负责人');
  await publishWhitelist(d.id, '管理员');
  const day = await whitelistFor('taobao', workday);
  assert.equal(day.allows('logistics', 'L0').allowed, false);
  assert.match(day.allows('logistics', 'L0').reason, /工作时段|辅助/);
  const night = await whitelistFor('taobao', offHours);
  assert.equal(night.allows('logistics', 'L0').allowed, true);
});

test('发布 v2 自动停用 v1；停用后即时默认拒绝', async () => {
  const v2 = await createDraft('owned', [{ scenario: 'invoice', maxRisk: 'L1' }], '只留发票', '售后负责人');
  assert.equal(v2.version, 2);
  await signWhitelist(v2.id, '售后负责人');
  await publishWhitelist(v2.id, '管理员');
  const list = await listWhitelists('owned');
  assert.equal(list.find((w) => w.version === 1)?.status, 'disabled');
  assert.match(list.find((w) => w.version === 1)?.disabledReason ?? '', /替代/);
  const active = await activeWhitelist('owned');
  assert.equal(active?.version, 2);
  const gate = await whitelistFor('web', workday);
  assert.equal(gate.allows('invoice', 'L1').allowed, true);
  assert.equal(gate.allows('logistics', 'L1').allowed, false);

  await disableWhitelist(v2.id, '管理员', '演练停用');
  clearWhitelistCache();
  const after = await whitelistFor('web', workday);
  assert.equal(after.version, null);
  assert.equal(after.allows('invoice', 'L0').allowed, false);
});

test('非法状态转换 409', async () => {
  const d = await createDraft('owned', [{ scenario: 'general', maxRisk: 'L0' }], 'x', 'a');
  await assert.rejects(disableWhitelist(d.id, 'a', 'r').then(() => signWhitelist(d.id, 'a')), /状态/);
});
