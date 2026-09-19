import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb, openDb } from '../src/db.ts';
import { MockDmsAdapter } from '../src/services/dms.ts';

let dms: MockDmsAdapter;
before(async () => {
  await initDb({ url: '', dataDir: null });
  dms = new MockDmsAdapter();
});
after(async () => {
  await closeDb();
});

const input = (caseId: string) => ({ caseId, title: '发票换开', type: '发票', priority: 'P2' as const, customerName: '李娜', orderId: '20260915000456', description: '个人→公司', evidence: { slots: { orderId: '20260915000456' } } });

test('normal：建单成功，单号形如 DMS-YYYYMMDD-XXXX，状态 received', async () => {
  const r = await dms.createTicket(input('CS-A'));
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.match(r.data.ticketNo, /^DMS-\d{8}-\d{4}$/);
    assert.equal(r.data.status, 'received');
  }
});

test('幂等：同一子案件重复建单返回同一单号，表中只有一行', async () => {
  const a = await dms.createTicket(input('CS-B'));
  const b = await dms.createTicket(input('CS-B'));
  assert.ok(a.ok && b.ok);
  if (a.ok && b.ok) assert.equal(a.data.ticketNo, b.data.ticketNo);
  const rows = await openDb().all('SELECT ticket_no FROM dms_mock_tickets WHERE case_id=?', 'CS-B');
  assert.equal(rows.length, 1);
});

test('unavailable / reject / account_cancelled 是业务结果而不是异常', async () => {
  dms.mode = 'unavailable';
  const u = await dms.createTicket(input('CS-C'));
  assert.deepEqual({ ok: u.ok, kind: u.ok ? null : u.kind }, { ok: false, kind: 'unavailable' });
  dms.mode = 'reject';
  const j = await dms.createTicket(input('CS-C'));
  assert.deepEqual({ ok: j.ok, kind: j.ok ? null : j.kind }, { ok: false, kind: 'rejected' });
  dms.mode = 'account_cancelled';
  const c = await dms.createTicket(input('CS-C'));
  assert.deepEqual({ ok: c.ok, kind: c.ok ? null : c.kind }, { ok: false, kind: 'account_cancelled' });
  dms.mode = 'normal';
  assert.equal(await openDb().count('dms_mock_tickets'), 2, '失败模式不得落库');
});

test('getTicket：不存在 → not_found；advance 按 received→processing→resolved→closed 推进', async () => {
  const nf = await dms.getTicket('DMS-00000000-0000');
  assert.deepEqual({ ok: nf.ok, kind: nf.ok ? null : nf.kind }, { ok: false, kind: 'not_found' });
  const r = await dms.createTicket(input('CS-D'));
  assert.ok(r.ok);
  const no = r.ok ? r.data.ticketNo : '';
  const s1 = await dms.advance(no);
  assert.ok(s1.ok && s1.data.status === 'processing');
  const s2 = await dms.advance(no);
  assert.ok(s2.ok && s2.data.status === 'resolved');
  const s3 = await dms.advance(no);
  assert.ok(s3.ok && s3.data.status === 'closed');
  const s4 = await dms.advance(no);
  assert.ok(s4.ok && s4.data.status === 'closed', '终态不再推进');
  const g = await dms.getTicket(no);
  assert.ok(g.ok && g.data.status === 'closed');
});

test('health 报告 kind=mock 与当前模式', async () => {
  dms.mode = 'slow';
  const h = await dms.health();
  assert.equal(h.kind, 'mock');
  assert.equal(h.mode, 'slow');
  dms.mode = 'normal';
});
