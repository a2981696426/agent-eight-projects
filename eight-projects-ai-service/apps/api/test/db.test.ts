import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb, toPositional, type Db } from '../src/db.ts';

let db: Db;
before(async () => {
  db = await initDb({ url: '', dataDir: null }); // PGlite 内存库
});
after(async () => {
  await closeDb();
});

test('toPositional：引号外的 ? 变成 $n，引号内不动', () => {
  assert.equal(toPositional('SELECT * FROM t WHERE a=? AND b=?'), 'SELECT * FROM t WHERE a=$1 AND b=$2');
  assert.equal(toPositional("SELECT '?' q, x FROM t WHERE y=?"), "SELECT '?' q, x FROM t WHERE y=$1");
  assert.equal(toPositional("SELECT 'it''s ?' FROM t WHERE z=?"), "SELECT 'it''s ?' FROM t WHERE z=$1");
});

test('migrate 建表且 count 返回 number', async () => {
  assert.equal(db.kind, 'pglite');
  const n = await db.count('customers');
  assert.equal(typeof n, 'number');
  assert.equal(n, 0);
});

test('run/get/all 往返，COUNT/SUM/ROUND 返回 number 而不是字符串', async () => {
  await db.run('INSERT INTO customers VALUES (?,?,?,?,?,?,?)', 'c1', '张三', '13800000000', 'vip', 'web', '["a"]', '');
  await db.run('INSERT INTO customers VALUES (?,?,?,?,?,?,?)', 'c2', '李四', '13900000000', 'normal', 'app', '[]', '');
  const one = await db.get<{ name: string }>('SELECT name FROM customers WHERE id=?', 'c1');
  assert.equal(one?.name, '张三');
  const agg = await db.get<{ n: number; s: number; r: number }>("SELECT COUNT(*) n, SUM(CASE WHEN level='vip' THEN 1 ELSE 0 END) s, ROUND(AVG(LENGTH(name))::numeric,1) r FROM customers");
  assert.equal(agg?.n, 2);
  assert.equal(typeof agg?.s, 'number');
  assert.equal(typeof agg?.r, 'number');
  const all = await db.all('SELECT id FROM customers ORDER BY id');
  assert.deepEqual(all.map((r) => r.id), ['c1', 'c2']);
});

test('tx：抛错回滚，正常提交', async () => {
  await assert.rejects(
    db.tx(async (t) => {
      await t.run('INSERT INTO customers VALUES (?,?,?,?,?,?,?)', 'c3', '王五', '', 'normal', 'web', '[]', '');
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.equal(await db.get('SELECT id FROM customers WHERE id=?', 'c3'), undefined);
  await db.tx(async (t) => {
    await t.run('INSERT INTO customers VALUES (?,?,?,?,?,?,?)', 'c4', '赵六', '', 'normal', 'web', '[]', '');
  });
  assert.ok(await db.get('SELECT id FROM customers WHERE id=?', 'c4'));
});

test('ON CONFLICT 覆盖写入 traces 幂等', async () => {
  const sql = 'INSERT INTO traces (id,conversation_id,agent_id,agent_version,created_at,scenario,intent,decision,risk_level,duration_ms,status,doc,degraded,failed_over,llm_calls) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (id) DO UPDATE SET doc=EXCLUDED.doc, status=EXCLUDED.status';
  await db.run(sql, 't1', 'conv', 'a', 1, '2026-01-01T00:00:00Z', 's', 'i', 'auto_reply', 'low', 10, 'ok', '{"v":1}', 0, 0, 1);
  await db.run(sql, 't1', 'conv', 'a', 1, '2026-01-01T00:00:00Z', 's', 'i', 'auto_reply', 'low', 10, 'ok', '{"v":2}', 0, 0, 1);
  const rows = await db.all<{ doc: string }>('SELECT doc FROM traces WHERE id=?', 't1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].doc, '{"v":2}');
});

test('undefined 参数按 NULL 处理', async () => {
  await db.run('INSERT INTO audit_log VALUES (?,?,?,?,?,?)', 'al1', '2026-01-01T00:00:00Z', 'x', 'y', 'z', undefined);
  const r = await db.get<{ detail: string | null }>('SELECT detail FROM audit_log WHERE id=?', 'al1');
  assert.equal(r?.detail, null);
});
