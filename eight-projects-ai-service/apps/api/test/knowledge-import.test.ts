import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { faqToDoc, parseFaqCsv, parseFaqJson } from '../src/services/knowledge-import.ts';

process.env.LLM_MOCK = '1';
process.env.DATA_DIR = ':memory:';
process.env.EMBEDDING_PROVIDER = 'mock';
process.env.EMBEDDING_DIMS = '256';

test('parseFaqCsv：云商导出中文表头映射、引号内换行与逗号、相似问按 | 或 ； 分隔、标签', () => {
  const csv = ['标准问,答案,相似问,分类,标签', '"传感器防水吗？","M8 防水等级 IPX8，日常淋浴没问题。\n不建议长时间泡澡。","洗澡能戴吗|游泳可以戴吗；泡温泉行不行","产品","售前 防水"', '发票多久开,确认收货后 48 小时内自动开具,,售后,发票'].join('\n');
  const rows = parseFaqCsv(csv);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].question, '传感器防水吗？');
  assert.ok(rows[0].answer.includes('IPX8') && rows[0].answer.includes('\n'));
  assert.deepEqual(rows[0].similar, ['洗澡能戴吗', '游泳可以戴吗', '泡温泉行不行']);
  assert.equal(rows[0].category, '产品');
  assert.deepEqual(rows[0].tags, ['售前', '防水']);
  assert.deepEqual(rows[1].similar, []);
  assert.deepEqual(rows[1].tags, ['发票']);
});

test('parseFaqCsv：英文表头 question/answer；缺答案的行被跳过；BOM 去除', () => {
  const csv = '\uFEFFquestion,answer\nHow to bind,Open the app and scan\nEmpty answer,\n';
  const rows = parseFaqCsv(csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].question, 'How to bind');
});

test('parseFaqJson：数组与 { items: [...] } 两种形态；similar 支持字符串或数组', () => {
  const a = parseFaqJson(JSON.stringify([{ question: 'q1', answer: 'a1', similar: 'x|y', tags: 't1,t2' }]));
  assert.deepEqual(a[0].similar, ['x', 'y']);
  assert.deepEqual(a[0].tags, ['t1', 't2']);
  const b = parseFaqJson(JSON.stringify({ items: [{ 标准问: 'q2', 答案: 'a2', 相似问: ['s1'], 分类: 'c' }] }));
  assert.equal(b[0].question, 'q2');
  assert.deepEqual(b[0].similar, ['s1']);
  assert.equal(b[0].category, 'c');
  assert.throws(() => parseFaqJson('{"nope":1}'), /数组/);
});

test('faqToDoc：相似问进入正文提升召回，标题为标准问', () => {
  const d = faqToDoc({ question: '传感器防水吗？', answer: 'IPX8', similar: ['洗澡能戴吗'], category: '产品', tags: ['防水'] });
  assert.equal(d.title, '传感器防水吗？');
  assert.ok(d.content.includes('Q：传感器防水吗？') && d.content.includes('Q：洗澡能戴吗') && d.content.includes('A：IPX8'));
  assert.deepEqual(d.tags, ['防水', 'FAQ']);
});

const { initDb, closeDb } = await import('../src/db.ts');
const { seed } = await import('../src/seed.ts');
const { refreshIndex, vectorStats } = await import('../src/services/chain.ts');
const { buildServer } = await import('../src/server.ts');
type App = Awaited<ReturnType<typeof buildServer>>;
let app: App;
let cookie = '';
before(async () => {
  await initDb();
  await seed(true);
  await refreshIndex();
  app = await buildServer();
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin123' } });
  cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
});
after(async () => {
  await app.close();
  await closeDb();
});

test('POST /api/knowledge/import format=faq-csv publish → 文档/块生成，向量同步补齐，检索命中相似问且返回 mode', async () => {
  const before = JSON.parse((await app.inject({ method: 'GET', url: '/api/knowledge/stats', headers: { cookie } })).body) as { docs: number };
  const csv = '标准问,答案,相似问,分类,标签\n夜间报警怎么关,在 App 设置里关闭夜间提醒即可；不影响数据记录。,晚上老响怎么办|怎么关掉半夜提醒,使用,使用 报警';
  const r = await app.inject({ method: 'POST', url: '/api/knowledge/import', payload: { text: csv, format: 'faq-csv', publish: true }, headers: { cookie } });
  assert.equal(r.statusCode, 200);
  const j = JSON.parse(r.body) as { created: number; format: string };
  assert.equal(j.created, 1);
  assert.equal(j.format, 'faq-csv');
  const after = JSON.parse((await app.inject({ method: 'GET', url: '/api/knowledge/stats', headers: { cookie } })).body) as { docs: number; vectors: { count: number; enabled: boolean } };
  assert.equal(after.docs, before.docs + 1);
  assert.equal(after.vectors.enabled, true);
  assert.ok(after.vectors.count > 0, '队列未启动时应同步向量化');
  const s = await app.inject({ method: 'POST', url: '/api/knowledge/search', payload: { q: '半夜提醒怎么关掉', topK: 3 }, headers: { cookie } });
  const sj = JSON.parse(s.body) as { hits: { docTitle: string; semantic?: number }[]; mode: string };
  assert.equal(sj.mode, 'hybrid');
  assert.equal(sj.hits[0].docTitle, '夜间报警怎么关');
  assert.ok((sj.hits[0].semantic ?? 0) > 0);
  const vs = await vectorStats();
  assert.ok(vs.enabled && vs.coverage > 0);
});

test('format=faq-json 与非法格式 400', async () => {
  const ok = await app.inject({ method: 'POST', url: '/api/knowledge/import', payload: { text: JSON.stringify([{ question: 'JSON 导入题', answer: '答案', tags: ['t'] }]), format: 'faq-json', publish: false }, headers: { cookie } });
  assert.equal(ok.statusCode, 200);
  assert.equal((JSON.parse(ok.body) as { created: number }).created, 1);
  const bad = await app.inject({ method: 'POST', url: '/api/knowledge/import', payload: { text: 'not json', format: 'faq-json' }, headers: { cookie } });
  assert.equal(bad.statusCode, 400);
});
