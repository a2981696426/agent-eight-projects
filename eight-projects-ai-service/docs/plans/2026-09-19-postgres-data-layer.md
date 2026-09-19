# 数据层迁移 PostgreSQL（pg + PGlite 双驱动）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `apps/api` 的持久化从 `node:sqlite` 换成 PostgreSQL 方言的异步数据层，生产用 `pg` 连接 PostgreSQL 16 + pgvector，本机/测试用 PGlite（进程内 Postgres）零依赖运行，全部 e2e 保持绿色。

**Architecture:** `apps/api/src/db.ts` 暴露驱动抽象 `SqlDriver`（`PgDriver` / `PgliteDriver`），`Db` 类提供异步 `all/get/run/tx/count`，把现有 `?` 占位符自动转成 `$n`，保留现有 SQL 字符串风格；启动时 `await initDb()`，之后各处仍用同步访问器 `openDb()` 取实例。所有调用点从同步改为 `await`。DDL 改为 Postgres 方言，`INSERT OR REPLACE/IGNORE` 改为 `ON CONFLICT`。

**Tech Stack:** Node 22.13+（本机 24.11）、pnpm 11、TypeScript 5.9（tsx 直接运行 `.ts`）、Fastify 5、`pg` 8、`@electric-sql/pglite` + `@electric-sql/pglite-pgvector`、PostgreSQL 16（镜像 `pgvector/pgvector:pg16`）、`node:test`。

## Global Constraints

- 决策依据：CS-013 / ADR-0041——PostgreSQL 为唯一持久化，启用 pgvector，队列后续用 pg-boss，不引入 Redis。
- 环境切换：`DATABASE_URL` 非空 → `pg`；为空 → PGlite 持久化到 `${DATA_DIR}/pglite`；`DATA_DIR=:memory:` 或测试传 `dataDir: null` → PGlite 内存库。
- 不改 `packages/agent-core`、`packages/shared`、`apps/web`。
- SQL 只允许 Postgres 方言；`node:sqlite` 依赖与 `platform.sqlite` 文件引用全部移除。
- 现有 22 个 Playwright 用例（`LLM_MOCK=1`）必须全部通过；`pnpm -r typecheck` 零错误。
- 提交粒度：每个 Task 结束提交一次，提交信息中文或英文均可，前缀 `feat(db)` / `refactor(api)` / `chore(deploy)`。
- 文案与注释保持中文。

---

### Task 1: 新数据层 `db.ts`（驱动抽象 + 占位符转换 + Postgres DDL）与单元测试

**Files:**
- Modify: `apps/api/package.json`（依赖与 `test` 脚本）
- Rewrite: `apps/api/src/db.ts`
- Modify: `apps/api/src/env.ts`（新增 `databaseUrl`、`pgliteDir`）
- Create: `apps/api/test/db.test.ts`
- Modify: `.env.example`（新增 `DATABASE_URL` 注释块）

**Interfaces:**
- Produces:
  - `toPositional(sql: string): string` —— 把引号外的 `?` 依次替换为 `$1..$n`
  - `class Db { all<T>(sql, ...params): Promise<T[]>; get<T>(sql, ...params): Promise<T|undefined>; run(sql, ...params): Promise<{changes:number}>; tx<T>(fn:(t:Db)=>Promise<T>): Promise<T>; count(table): Promise<number>; readonly kind: 'pg'|'pglite' }`
  - `initDb(opts?: { url?: string; dataDir?: string | null }): Promise<Db>`
  - `openDb(): Db`（同步访问器，未初始化则抛错）
  - `closeDb(): Promise<void>`
  - `uid`、`nowIso`、`J` 保持原签名

- [ ] **Step 1: 安装依赖并加测试脚本**

```bash
cd apps/api
pnpm add pg @electric-sql/pglite @electric-sql/pglite-pgvector
pnpm add -D @types/pg
```

`apps/api/package.json` 的 `scripts.test` 改为：

```json
"test": "node --import tsx --test test/*.test.ts"
```

- [ ] **Step 2: 写失败的单元测试 `apps/api/test/db.test.ts`**

```ts
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
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm --filter @eight/api test`
Expected: FAIL —— `initDb`/`toPositional` 不存在（当前 db.ts 只导出 `openDb`、`Db`、`J`、`uid`、`nowIso`）。

- [ ] **Step 4: 重写 `apps/api/src/db.ts`**

```ts
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Pool, types as pgTypes, type PoolClient } from 'pg';
import { PGlite, types as liteTypes } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { env } from './env.ts';

export const uid = (prefix = '') => `${prefix}${randomUUID().slice(0, 8)}`;
export const nowIso = () => new Date().toISOString();

type Row = Record<string, unknown>;
export type SqlParam = string | number | boolean | null | undefined;

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}
export interface SqlExecutor {
  query<T = Row>(text: string, params: unknown[]): Promise<QueryResult<T>>;
}
export interface SqlDriver extends SqlExecutor {
  readonly kind: 'pg' | 'pglite';
  transaction<T>(fn: (ex: SqlExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/* ───────────── `?` → `$n`（跳过单引号字符串，支持 '' 转义） ───────────── */
const positionalCache = new Map<string, string>();
export function toPositional(sql: string): string {
  const hit = positionalCache.get(sql);
  if (hit) return hit;
  let out = '';
  let n = 0;
  let inQuote = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inQuote) {
      out += ch;
      if (ch === "'") {
        if (sql[i + 1] === "'") {
          out += "'";
          i++;
        } else inQuote = false;
      }
      continue;
    }
    if (ch === "'") {
      inQuote = true;
      out += ch;
    } else if (ch === '?') out += `$${++n}`;
    else out += ch;
  }
  positionalCache.set(sql, out);
  return out;
}

const normalizeParams = (params: unknown[]) => params.map((p) => (p === undefined ? null : p));

/* ───────────── 驱动：pg（生产） ───────────── */
class PgDriver implements SqlDriver {
  readonly kind = 'pg' as const;
  private readonly pool: Pool;
  constructor(connectionString: string) {
    // int8 / numeric 默认返回字符串，这里统一转 number（COUNT/SUM/ROUND/AVG）
    pgTypes.setTypeParser(20, Number);
    pgTypes.setTypeParser(1700, Number);
    this.pool = new Pool({ connectionString, max: Number(process.env.PG_POOL_MAX ?? 10), idleTimeoutMillis: 30_000 });
  }
  async query<T = Row>(text: string, params: unknown[]): Promise<QueryResult<T>> {
    const r = await this.pool.query(text, normalizeParams(params));
    return { rows: r.rows as T[], rowCount: r.rowCount ?? r.rows.length };
  }
  async transaction<T>(fn: (ex: SqlExecutor) => Promise<T>): Promise<T> {
    const client: PoolClient = await this.pool.connect();
    const ex: SqlExecutor = {
      async query<R = Row>(text: string, params: unknown[]) {
        const r = await client.query(text, normalizeParams(params));
        return { rows: r.rows as R[], rowCount: r.rowCount ?? r.rows.length };
      },
    };
    try {
      await client.query('BEGIN');
      const out = await fn(ex);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }
  async close() {
    await this.pool.end();
  }
}

/* ───────────── 驱动：PGlite（本机/测试，进程内 Postgres） ───────────── */
class PgliteDriver implements SqlDriver {
  readonly kind = 'pglite' as const;
  private constructor(private readonly pg: PGlite) {}
  static async create(dataDir: string | null) {
    if (dataDir) mkdirSync(dataDir, { recursive: true });
    const pg = await PGlite.create({
      dataDir: dataDir ?? undefined,
      extensions: { vector },
      parsers: { [liteTypes.INT8]: (v: string) => Number(v), [liteTypes.NUMERIC]: (v: string) => Number(v) },
    });
    return new PgliteDriver(pg);
  }
  async query<T = Row>(text: string, params: unknown[]): Promise<QueryResult<T>> {
    const r = await this.pg.query<T>(text, normalizeParams(params));
    return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
  }
  async transaction<T>(fn: (ex: SqlExecutor) => Promise<T>): Promise<T> {
    return this.pg.transaction(async (tx) => {
      const ex: SqlExecutor = {
        async query<R = Row>(text: string, params: unknown[]) {
          const r = await tx.query<R>(text, normalizeParams(params));
          return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
        },
      };
      return fn(ex);
    });
  }
  async close() {
    await this.pg.close();
  }
}

/* ───────────── Db：业务代码使用的薄封装 ───────────── */
export class Db {
  constructor(
    private readonly ex: SqlExecutor,
    private readonly driver: SqlDriver,
  ) {}
  get kind() {
    return this.driver.kind;
  }
  async all<T = Row>(sql: string, ...params: SqlParam[]): Promise<T[]> {
    return (await this.ex.query<T>(toPositional(sql), params)).rows;
  }
  async get<T = Row>(sql: string, ...params: SqlParam[]): Promise<T | undefined> {
    return (await this.all<T>(sql, ...params))[0];
  }
  async run(sql: string, ...params: SqlParam[]): Promise<{ changes: number }> {
    const r = await this.ex.query(toPositional(sql), params);
    return { changes: r.rowCount };
  }
  /** 事务：回调内必须使用传入的 t，而不是外层 db */
  tx<T>(fn: (t: Db) => Promise<T>): Promise<T> {
    return this.driver.transaction((ex) => fn(new Db(ex, this.driver)));
  }
  async count(table: string): Promise<number> {
    return (await this.get<{ n: number }>(`SELECT COUNT(*)::int n FROM ${table}`))?.n ?? 0;
  }
}

/* ───────────── Schema（Postgres 方言，幂等） ───────────── */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS customers(id TEXT PRIMARY KEY, name TEXT, phone TEXT, level TEXT, channel TEXT, tags TEXT, note TEXT);
CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY, customer_id TEXT, product TEXT, sku TEXT, amount DOUBLE PRECISION, paid_amount DOUBLE PRECISION, status TEXT, created_at TEXT, paid_at TEXT, shipped_at TEXT, address TEXT, promo_price DOUBLE PRECISION, promo_start TEXT, promo_end TEXT, price_protect_days INTEGER);
CREATE TABLE IF NOT EXISTS logistics(order_id TEXT PRIMARY KEY, carrier TEXT, tracking_no TEXT, status TEXT, last_update TEXT, eta TEXT, events TEXT);
CREATE TABLE IF NOT EXISTS invoices(order_id TEXT PRIMARY KEY, status TEXT, title TEXT, tax_id TEXT, type TEXT, issued_at TEXT, url TEXT, note TEXT);
CREATE TABLE IF NOT EXISTS refunds(id TEXT PRIMARY KEY, order_id TEXT, type TEXT, amount DOUBLE PRECISION, status TEXT, applied_at TEXT, processed_at TEXT, reason TEXT, channel_eta TEXT);
CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, title TEXT, channel TEXT, customer_id TEXT, status TEXT, controller TEXT, assignee TEXT, scenario TEXT, priority TEXT, last_message_at TEXT, created_at TEXT, summary TEXT, agent_id TEXT, satisfaction INTEGER);
CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, conversation_id TEXT, role TEXT, text TEXT, at TEXT, trace_id TEXT, meta TEXT);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, at);
CREATE TABLE IF NOT EXISTS traces(id TEXT PRIMARY KEY, conversation_id TEXT, agent_id TEXT, agent_version INTEGER, created_at TEXT, scenario TEXT, intent TEXT, decision TEXT, risk_level TEXT, duration_ms INTEGER, status TEXT, doc TEXT, degraded INTEGER DEFAULT 0, failed_over INTEGER DEFAULT 0, llm_calls INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_traces_conv ON traces(conversation_id, created_at);
CREATE TABLE IF NOT EXISTS tickets(id TEXT PRIMARY KEY, title TEXT, type TEXT, status TEXT, priority TEXT, conversation_id TEXT, customer_id TEXT, customer_name TEXT, assignee TEXT, description TEXT, sla_due_at TEXT, created_at TEXT, updated_at TEXT, source TEXT, history TEXT);
CREATE TABLE IF NOT EXISTS knowledge_docs(id TEXT PRIMARY KEY, title TEXT, category TEXT, tags TEXT, content TEXT, status TEXT, version INTEGER, updated_at TEXT, source TEXT);
CREATE TABLE IF NOT EXISTS knowledge_chunks(id TEXT PRIMARY KEY, doc_id TEXT, seq INTEGER, text TEXT, tags TEXT);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON knowledge_chunks(doc_id);
CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY, name TEXT, version INTEGER, status TEXT, doc TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS agent_versions(id TEXT PRIMARY KEY, agent_id TEXT, version INTEGER, doc TEXT, published_at TEXT, note TEXT);
CREATE TABLE IF NOT EXISTS quality_rules(id TEXT PRIMARY KEY, doc TEXT);
CREATE TABLE IF NOT EXISTS quality_results(id TEXT PRIMARY KEY, conversation_id TEXT, agent TEXT, score DOUBLE PRECISION, doc TEXT, created_at TEXT, reviewed_by TEXT, review_note TEXT);
CREATE TABLE IF NOT EXISTS voc_items(id TEXT PRIMARY KEY, conversation_id TEXT, message_id TEXT UNIQUE, text TEXT, topic TEXT, sentiment TEXT, keywords TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS ivr_flows(id TEXT PRIMARY KEY, doc TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS campaigns(id TEXT PRIMARY KEY, doc TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS saved_reports(id TEXT PRIMARY KEY, name TEXT, spec TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS aigc_jobs(id TEXT PRIMARY KEY, capability TEXT, input TEXT, output TEXT, usage TEXT, created_at TEXT, conversation_id TEXT);
CREATE TABLE IF NOT EXISTS benchmark_cases(id TEXT PRIMARY KEY, text TEXT, expected_scenario TEXT, expected_decision TEXT, note TEXT, customer_id TEXT);
CREATE TABLE IF NOT EXISTS benchmark_runs(id TEXT PRIMARY KEY, agent_id TEXT, agent_version INTEGER, created_at TEXT, doc TEXT);
CREATE TABLE IF NOT EXISTS audit_log(id TEXT PRIMARY KEY, at TEXT, actor TEXT, action TEXT, target TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS employee_runs(id TEXT PRIMARY KEY, employee TEXT, trace_id TEXT, conversation_id TEXT, created_at TEXT, decision TEXT, risk_level TEXT, summary TEXT);
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT UNIQUE, password_hash TEXT, salt TEXT, name TEXT, role TEXT, disabled INTEGER DEFAULT 0, created_at TEXT, last_login_at TEXT);
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, user_id TEXT, created_at TEXT, expires_at TEXT, user_agent TEXT);
ALTER TABLE traces ADD COLUMN IF NOT EXISTS degraded INTEGER DEFAULT 0;
ALTER TABLE traces ADD COLUMN IF NOT EXISTS failed_over INTEGER DEFAULT 0;
ALTER TABLE traces ADD COLUMN IF NOT EXISTS llm_calls INTEGER DEFAULT 0;
`;

async function migrate(driver: SqlDriver) {
  try {
    await driver.query('CREATE EXTENSION IF NOT EXISTS vector', []);
  } catch (e) {
    console.warn(`[db] pgvector 不可用，向量检索将不可用：${(e as Error).message}`);
  }
  for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) await driver.query(stmt, []);
}

export const J = {
  parse<T>(v: unknown, fallback: T): T {
    if (typeof v !== 'string') return fallback;
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  },
  str: (v: unknown) => JSON.stringify(v ?? null),
};

/* ───────────── 生命周期 ───────────── */
let driver: SqlDriver | null = null;
let instance: Db | null = null;

export async function initDb(opts: { url?: string; dataDir?: string | null } = {}): Promise<Db> {
  if (instance) return instance;
  const url = opts.url ?? env.databaseUrl;
  const dataDir = opts.dataDir === undefined ? env.pgliteDir : opts.dataDir;
  driver = url ? new PgDriver(url) : await PgliteDriver.create(dataDir);
  await migrate(driver);
  instance = new Db(driver, driver);
  return instance;
}
export function openDb(): Db {
  if (!instance) throw new Error('数据库未初始化：请先 await initDb()');
  return instance;
}
export async function closeDb() {
  await driver?.close();
  driver = null;
  instance = null;
}
```

- [ ] **Step 5: `apps/api/src/env.ts` 增加两个字段**

在 `dataDir` 之后加入：

```ts
  /** 非空 → pg 连接 PostgreSQL；空 → PGlite 进程内 Postgres（本机/测试零依赖） */
  databaseUrl: process.env.DATABASE_URL ?? '',
  /** PGlite 数据目录；DATA_DIR=:memory: 时为 null（内存库） */
  pgliteDir: process.env.DATA_DIR === ':memory:' ? null : resolve(here, '..', process.env.DATA_DIR ?? '../../data', 'pglite'),
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm --filter @eight/api test`
Expected: 6 个测试 PASS（首次运行会下载/加载 PGlite WASM，约 1～3 s）。

- [ ] **Step 7: `.env.example` 加说明**

在 `DATA_DIR` 附近追加：

```
# 数据库：留空 = PGlite 进程内 Postgres（本机零依赖，数据在 DATA_DIR/pglite）；
# 生产填 PostgreSQL 连接串（docker-compose 默认：postgres://eight:eight@postgres:5432/eight）
DATABASE_URL=
```

- [ ] **Step 8: 提交**

```bash
git add apps/api/package.json apps/api/src/db.ts apps/api/src/env.ts apps/api/test/db.test.ts .env.example pnpm-lock.yaml
git commit -m "feat(db): async data layer with pg/PGlite drivers, ?->\$n placeholders, Postgres schema; unit tests"
```

（此时 typecheck 会失败，因为调用点仍是同步用法——Task 2～5 修复。）

---

### Task 2: `services/chain.ts`、`services/auth.ts`、`services/aigc.ts`、`seed.ts`、`server.ts` 改为异步

**Files:**
- Modify: `apps/api/src/services/chain.ts`
- Modify: `apps/api/src/services/auth.ts`
- Modify: `apps/api/src/services/aigc.ts`
- Modify: `apps/api/src/seed.ts`
- Modify: `apps/api/src/server.ts`

**Interfaces:**
- Consumes: Task 1 的 `Db`（异步）、`initDb`、`openDb`
- Produces（供路由使用，签名全部变为 Promise）:
  - `refreshIndex(): Promise<number>`、`knowledgeIndex(): BM25Index`（首次调用前必须 `await refreshIndex()`；server 启动时调用）
  - `loadAgent(id?): Promise<AgentConfig>`
  - `rowToConversation(r): Promise<Conversation>`
  - `loadMessages(id): Promise<Message[]>`、`loadCustomer(id): Promise<Customer|null>`
  - `appendMessage(...): Promise<Message>`、`saveTrace(t): Promise<void>`、`loadTrace(id): Promise<Trace|null>`
  - `seedUsers(): Promise<void>`、`createSession(...)`、`destroySession(...)`、`userBySession(...)`、`authenticate(...)` 全部返回 Promise
  - `seed(force?): Promise<{ seeded: boolean }>`

- [ ] **Step 1: `chain.ts` 转换规则与关键改动**

规则：每个 `db().all/get/run` 与 `d.all/get/run` 前加 `await`；包含 await 的函数加 `async`；返回类型包一层 Promise。具体：

`knowledgeIndex/refreshIndex`：

```ts
let index: BM25Index | null = null;
export function knowledgeIndex() {
  return (index ??= new BM25Index());
}
export async function refreshIndex() {
  const rows = await db().all<{ id: string; doc_id: string; seq: number; text: string; tags: string; title: string }>(
    `SELECT c.id, c.doc_id, c.seq, c.text, c.tags, d.title FROM knowledge_chunks c JOIN knowledge_docs d ON d.id=c.doc_id WHERE d.status='published'`,
  );
  const chunks = rows.map((r) => ({ docTitle: r.title, chunk: { id: r.id, docId: r.doc_id, seq: r.seq, text: r.text, tags: J.parse<string[]>(r.tags, []) } as KnowledgeChunk }));
  knowledgeIndex().rebuild(chunks);
  return chunks.length;
}
```

工具 `run` 已是 async，只需在内部 `db()` 调用前加 `await`（8 个工具，约 14 处）。

`saveTrace` 改为 ON CONFLICT：

```ts
export async function saveTrace(t: Trace) {
  await db().run(
    `INSERT INTO traces (id,conversation_id,agent_id,agent_version,created_at,scenario,intent,decision,risk_level,duration_ms,status,doc,degraded,failed_over,llm_calls)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (id) DO UPDATE SET conversation_id=EXCLUDED.conversation_id, agent_id=EXCLUDED.agent_id, agent_version=EXCLUDED.agent_version, created_at=EXCLUDED.created_at, scenario=EXCLUDED.scenario, intent=EXCLUDED.intent, decision=EXCLUDED.decision, risk_level=EXCLUDED.risk_level, duration_ms=EXCLUDED.duration_ms, status=EXCLUDED.status, doc=EXCLUDED.doc, degraded=EXCLUDED.degraded, failed_over=EXCLUDED.failed_over, llm_calls=EXCLUDED.llm_calls`,
    t.id, t.conversationId, t.agentId, t.agentVersion, t.createdAt, t.scenario, t.intent, t.autonomy?.decision ?? null, t.risk?.level ?? null, t.totalDurationMs, t.status, J.str(t), t.degraded ? 1 : 0, t.failedOver ? 1 : 0, t.usage.calls,
  );
}
```

`rowToConversation`：

```ts
export async function rowToConversation(r: Record<string, unknown>): Promise<Conversation> {
  const name = (await db().get<{ name: string }>('SELECT name FROM customers WHERE id=?', String(r.customer_id)))?.name ?? '匿名访客';
  const count = (await db().get<{ n: number }>('SELECT COUNT(*)::int n FROM messages WHERE conversation_id=?', String(r.id)))?.n ?? 0;
  return { /* 字段同现状 */ };
}
```

`runForConversation` 内：`const row = await d.get(...)`、`const conv = await rowToConversation(row)`、`const agent = await loadAgent(...)`、`const messages = await loadMessages(...)`、`const customer = await loadCustomer(...)`、`const lastTrace = await d.get(...)`、`userMessage = await appendMessage(...)`、`await saveTrace(trace)`、所有 `d.run` 加 await、`botMessage = await appendMessage(...)`、末尾 `conversation: await rowToConversation((await d.get(...))!)`。

`runStandalone` 内：`const agent = opts.agent ?? (await loadAgent())`、`const customer = await loadCustomer(...)`、`await saveTrace(trace)`。

- [ ] **Step 2: `auth.ts`**

`seedUsers`、`createSession`、`destroySession`、`userBySession`、`authenticate` 加 `async` 并在 db 调用前加 `await`；`installAuth` 的 onRequest 钩子里 `req.user = await userBySession(...)`；登录路由 `const u = await authenticate(...)`、`const sid = await createSession(...)`；登出 `await destroySession(...)`。

- [ ] **Step 3: `aigc.ts`**

`record(...)` 加 `async` + `await db().run(...)`；所有调用 `record(...)` 的地方改为 `await record(...)`；函数内 `loadMessages`/`loadCustomer` 等调用加 `await`。

- [ ] **Step 4: `seed.ts`**

```ts
export async function seed(force = false) {
  const db = openDb();
  if (!force && (await db.count('customers')) > 0) return { seeded: false };
  await db.tx(async (t) => {
    for (const table of [/* 同现状列表 */]) await t.run(`DELETE FROM ${table}`);
    // 以下所有 db.run(...) 改为 await t.run(...)
  });
  return { seeded: true };
}
```

`seed.ts` 内如有 `db.run` 位于 `forEach` 回调（知识 chunk 那一段），改为 `for (const [seq, text] of chunkText(k.content).entries()) await t.run(...)`。

- [ ] **Step 5: `server.ts`**

```ts
import { initDb, openDb } from './db.ts';
import { knowledgeIndex, llm, refreshIndex } from './services/chain.ts';
// buildServer 内
await seedUsers();
installAuth(app);
// /api/overview
app.get('/api/overview', async () => {
  const db = openDb();
  const n = async (sql: string) => (await db.get<{ n: number }>(sql))?.n ?? 0;
  return {
    conversations: await n('SELECT COUNT(*)::int n FROM conversations'),
    waitingHuman: await n("SELECT COUNT(*)::int n FROM conversations WHERE status='waiting_human'"),
    tickets: await n("SELECT COUNT(*)::int n FROM tickets WHERE status NOT IN ('resolved','closed')"),
    traces: await n('SELECT COUNT(*)::int n FROM traces'),
    knowledge: await n("SELECT COUNT(*)::int n FROM knowledge_docs WHERE status='published'"),
    quality: await n('SELECT COUNT(*)::int n FROM quality_results'),
    voc: await n('SELECT COUNT(*)::int n FROM voc_items'),
    degraded: await n('SELECT COUNT(*)::int n FROM traces WHERE degraded=1'),
    llmConfigured: llm.configured,
  };
});
// 启动段
if (process.argv[1]?.endsWith('server.ts')) {
  await initDb();
  const s = await seed(false);
  const app = await buildServer();
  await refreshIndex();
  await app.listen({ port: env.apiPort, host: '0.0.0.0' });
  app.log.info(`version=${VERSION} db=${openDb().kind} mode=... seeded=${s.seeded} ...`);
}
```

`/api/health` 里 `knowledgeIndexed: knowledgeIndex().size` 保持；新增 `db: openDb().kind`。

- [ ] **Step 6: typecheck 收敛到只剩路由文件的错误**

Run: `pnpm --filter @eight/api typecheck`
Expected: 报错全部位于 `src/routes/*.ts`（Task 3～5 处理）；`services/*`、`seed.ts`、`server.ts` 零错误。

- [ ] **Step 7: 提交**

```bash
git add apps/api/src/services apps/api/src/seed.ts apps/api/src/server.ts
git commit -m "refactor(api): services/seed/server use async Db; traces upsert via ON CONFLICT"
```

---

### Task 3: 路由 `conversations.ts`、`tickets.ts` 异步化

**Files:**
- Modify: `apps/api/src/routes/conversations.ts`
- Modify: `apps/api/src/routes/tickets.ts`

**Interfaces:**
- Consumes: Task 2 的异步 `rowToConversation/loadMessages/loadCustomer/appendMessage/loadTrace`

- [ ] **Step 1: `conversations.ts` 关键模式**

`audit` 变为 async 并在调用处 `await`：

```ts
const audit = (actor: string, action: string, target: string, detail: unknown = null) => db().run('INSERT INTO audit_log VALUES (?,?,?,?,?,?)', uid('al-'), nowIso(), actor, action, target, J.str(detail));
```

列表：

```ts
const rows = await db().all(`SELECT * FROM conversations ...`, ...params);
return Promise.all(rows.map((r) => rowToConversation(r)));
```

客户详情里的嵌套查询（不能在 `.map` 回调里直接 await 同步返回）：

```ts
const orderRows = await db().all('SELECT * FROM orders WHERE customer_id=? ORDER BY created_at DESC', id);
const orders = await Promise.all(orderRows.map(async (o) => ({
  ...o,
  logistics: (await db().get('SELECT * FROM logistics WHERE order_id=?', String(o.id))) ?? null,
  invoice: (await db().get('SELECT * FROM invoices WHERE order_id=?', String(o.id))) ?? null,
  refunds: await db().all('SELECT * FROM refunds WHERE order_id=?', String(o.id)),
})));
const convRows = await db().all('SELECT * FROM conversations WHERE customer_id=? ORDER BY last_message_at DESC', id);
const conversations = await Promise.all(convRows.map((r) => rowToConversation(r)));
```

自动小记的 fire-and-forget 分支：

```ts
if (body.action === 'close' && (await loadMessages(id)).filter((m) => m.role !== 'system').length >= 2) {
  summarize(id)
    .then(async (s) => {
      const text = `...`;
      await db().run('UPDATE conversations SET summary=? WHERE id=?', text, id);
      await appendMessage(id, 'system', `【自动小记】...`, { meta: { internal: true, autoSummary: true } });
    })
    .catch((e) => app.log.warn(...));
}
```

其余：每个 `db().get/all/run`、`appendMessage`、`loadMessages`、`loadCustomer`、`loadTrace`、`rowToConversation`、`audit` 前加 `await`。`/api/audit` 与 `/api/customers` 的 `.map` 在 `await db().all(...)` 结果上继续同步 map。

- [ ] **Step 2: `tickets.ts`**

同规则；`GROUP BY status` 等聚合不用改；`db().count('tickets')` 加 await。

- [ ] **Step 3: typecheck**

Run: `pnpm --filter @eight/api typecheck`
Expected: `conversations.ts`、`tickets.ts` 零错误。

- [ ] **Step 4: 提交**

```bash
git add apps/api/src/routes/conversations.ts apps/api/src/routes/tickets.ts
git commit -m "refactor(api): conversations/tickets routes await async Db"
```

---

### Task 4: 路由 `knowledge.ts`、`agents.ts`、`aigc.ts`、`bots.ts` 异步化 + 方言修正

**Files:**
- Modify: `apps/api/src/routes/knowledge.ts`
- Modify: `apps/api/src/routes/agents.ts`
- Modify: `apps/api/src/routes/aigc.ts`
- Modify: `apps/api/src/routes/bots.ts`

- [ ] **Step 1: 方言修正点**

`agents.ts:35` 子查询必须有别名：

```ts
avgChainMsRecent20: (await db().get<{ v: number }>('SELECT ROUND(AVG(duration_ms)) v FROM (SELECT duration_ms FROM traces ORDER BY created_at DESC LIMIT 20) t'))?.v ?? 0,
```

`bots.ts:18` IVR 覆盖写：

```ts
await db().run('INSERT INTO ivr_flows VALUES (?,?,?) ON CONFLICT (id) DO UPDATE SET doc=EXCLUDED.doc, updated_at=EXCLUDED.updated_at', id, J.str(flow), flow.updatedAt);
```

`knowledge.ts` 若有 `LIKE ?` 搜索改为 `ILIKE ?`（Postgres LIKE 区分大小写）；`refreshIndex()` 调用处加 `await`。

- [ ] **Step 2: 其余按规则加 `await`/`async`**

对象字面量里多处 db 调用（如 knowledge 统计、agents 概览）改为先 `await` 到局部变量再组装，或每个属性前加 `await`（对象字面量内允许 `await` 表达式）。

- [ ] **Step 3: typecheck**

Run: `pnpm --filter @eight/api typecheck`
Expected: 四个文件零错误。

- [ ] **Step 4: 提交**

```bash
git add apps/api/src/routes/knowledge.ts apps/api/src/routes/agents.ts apps/api/src/routes/aigc.ts apps/api/src/routes/bots.ts
git commit -m "refactor(api): knowledge/agents/aigc/bots routes async; Postgres dialect fixes"
```

---

### Task 5: 路由 `management.ts` 异步化 + 聚合函数方言修正

**Files:**
- Modify: `apps/api/src/routes/management.ts`

- [ ] **Step 1: 方言修正点**

- 质检规则覆盖写（第 50 行）：`INSERT INTO quality_rules VALUES (?,?) ON CONFLICT (id) DO UPDATE SET doc=EXCLUDED.doc`
- VoC 去重（第 219 行）：`INSERT INTO voc_items VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (message_id) DO NOTHING`
- `ROUND(AVG(score),1)`：`score` 是 DOUBLE PRECISION，Postgres 没有 `round(double, int)`，改为 `ROUND(AVG(score)::numeric,1)`（第 98 行、`METRICS.quality.avg_score`、大屏 `qualityAvg`）。`AVG(satisfaction)`、`AVG(duration_ms)` 基于 INTEGER，结果已是 numeric，不用改。
- 报表 `GROUP BY key ORDER BY value DESC`：Postgres 允许按输出列别名分组，但 `key`/`value` 与函数名易混，改别名为 `dim_key` / `metric_value`，并同步 `rows.map` 里的字段名。

- [ ] **Step 2: 大屏 `n()` 助手改 async**

```ts
const n = async (sql: string, ...p: (string | number)[]) => (await d.get<{ n: number }>(sql, ...p))?.n ?? 0;
```

`kpis` 对象内每个 `n(...)`、`d.get(...)` 前加 `await`；上方的 `traces/risks/scenarios/hourly/channels/agents/avgMs/tokens` 先 `await` 到局部变量。

- [ ] **Step 3: 其余按规则加 `await`**

包括 `db().count('voc_items')`、员工统计的 `.map` 内嵌 db 调用（改为 `for...of` 或 `Promise.all`）。

- [ ] **Step 4: typecheck 全绿**

Run: `pnpm -r typecheck`
Expected: 全部 workspace 零错误。

- [ ] **Step 5: 提交**

```bash
git add apps/api/src/routes/management.ts
git commit -m "refactor(api): management routes async; ROUND(numeric) and upsert dialect fixes"
```

---

### Task 6: 本机启动 + 全量 e2e 回归（PGlite）

**Files:**
- Modify: `.gitignore`（忽略 `data/pglite/`；移除 `platform.sqlite` 条目如有）
- Modify: `e2e/playwright.config.ts`（如 webServer 环境需要 `DATA_DIR`，保持默认即可）

- [ ] **Step 1: 清理旧数据并启动**

```bash
rm -rf data/platform.sqlite* 2>/dev/null; true
LLM_MOCK=1 pnpm --filter @eight/api dev
```

Expected: 日志出现 `db=pglite ... seeded=true knowledgeIndexed=<N>`；`curl http://localhost:8787/api/health` 返回 `"db":"pglite"`。

- [ ] **Step 2: 手工冒烟**

```bash
curl -s -c c.txt -H 'content-type: application/json' -d '{"username":"admin","password":"admin123"}' http://localhost:8787/api/auth/login
curl -s -b c.txt http://localhost:8787/api/dashboard | head -c 400
curl -s -b c.txt -X POST http://localhost:8787/api/reports/run -H 'content-type: application/json' -d '{"dataset":"quality","dimension":"agent","metric":"avg_score"}'
```

Expected: 三个请求均 200，且数值字段为 number（无引号）。

- [ ] **Step 3: 全量 e2e**

Run: `pnpm e2e`
Expected: 22 passed（与迁移前一致）。失败则按报错回到对应 Task 修 SQL 方言。

- [ ] **Step 4: 提交**

```bash
git add .gitignore e2e/playwright.config.ts
git commit -m "chore(api): PGlite dev data dir ignored; e2e green on Postgres dialect"
```

---

### Task 7: 部署形态：compose 增加 PostgreSQL、备份脚本、运行手册

**Files:**
- Modify: `docker-compose.yml`
- Create: `scripts/backup-db.sh`
- Create: `scripts/restore-db.sh`
- Create: `docs/RUNBOOK.md`
- Modify: `README.md`（数据库章节）
- Modify: `docs/ARCHITECTURE.md`、`docs/LOOP-LOG.md`（L10 条目）

- [ ] **Step 1: `docker-compose.yml`**

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
    restart: unless-stopped
    environment:
      POSTGRES_DB: eight
      POSTGRES_USER: eight
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-eight}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U eight -d eight']
      interval: 5s
      timeout: 3s
      retries: 20
  ai-service:
    build: .
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    ports:
      - '${API_PORT:-8787}:8787'
    env_file: .env
    environment:
      SERVE_WEB: '1'
      DATABASE_URL: postgres://eight:${POSTGRES_PASSWORD:-eight}@postgres:5432/eight
    volumes:
      - ./data:/app/data
volumes:
  pgdata:
```

- [ ] **Step 2: `scripts/backup-db.sh`**

```bash
#!/usr/bin/env bash
# 每日备份：pg_dump 自定义格式 → backups/eight-YYYYMMDD-HHMM.dump，保留 30 天；
# 可选上传 COS：设置 COS_BUCKET 且已安装 coscli 时执行。
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p backups
STAMP=$(date +%Y%m%d-%H%M)
FILE="backups/eight-${STAMP}.dump"
docker compose exec -T postgres pg_dump -U eight -d eight -Fc > "$FILE"
find backups -name 'eight-*.dump' -mtime +30 -delete
echo "backup written: $FILE ($(du -h "$FILE" | cut -f1))"
if [[ -n "${COS_BUCKET:-}" ]] && command -v coscli >/dev/null; then
  coscli cp "$FILE" "cos://${COS_BUCKET}/eight-backups/$(basename "$FILE")"
fi
```

- [ ] **Step 3: `scripts/restore-db.sh`**

```bash
#!/usr/bin/env bash
# 恢复演练：./scripts/restore-db.sh backups/eight-xxxx.dump
set -euo pipefail
cd "$(dirname "$0")/.."
FILE="${1:?用法: restore-db.sh <dump 文件>}"
docker compose stop ai-service
docker compose exec -T postgres psql -U eight -d postgres -c "DROP DATABASE IF EXISTS eight_restore;" -c "CREATE DATABASE eight_restore OWNER eight;"
docker compose exec -T postgres pg_restore -U eight -d eight_restore --no-owner < "$FILE"
docker compose exec -T postgres psql -U eight -d postgres -c "ALTER DATABASE eight RENAME TO eight_old_$(date +%s);" -c "ALTER DATABASE eight_restore RENAME TO eight;"
docker compose start ai-service
echo "restored from $FILE; old database kept as eight_old_*"
```

- [ ] **Step 4: `docs/RUNBOOK.md`**

内容：启动/停止；查看健康（`/api/health` 的 `db`、`llm.providers`）；备份（crontab `0 3 * * * /opt/eight/scripts/backup-db.sh`）；恢复演练步骤与验收（恢复后 `/api/overview` 计数与备份时一致）；故障处理（Postgres 不可用 → API 返回 500，重启顺序 postgres → ai-service；LLM 全挂 → 规则降级，无需操作）；升级（`docker compose pull && up -d --build`，先备份）。

- [ ] **Step 5: 文档更新**

README「快速开始」加：默认零依赖（PGlite）；生产 `DATABASE_URL`；备份命令。ARCHITECTURE「发布形态」加 PostgreSQL + pgvector + pg-boss（pg-boss 于队列计划接入）。LOOP-LOG 新增 L10：迁移动因（CS-013）、方言问题清单（ROUND(double)、子查询别名、OR REPLACE、LIKE 大小写、int8 字符串）、验证结果。

- [ ] **Step 6: 校验 compose 语法**

Run: `docker compose config >/dev/null && echo ok`
Expected: `ok`（本机 Docker 守护进程未运行时此步跳过，记录到 LOOP-LOG 待服务器验证）。

- [ ] **Step 7: 提交**

```bash
chmod +x scripts/backup-db.sh scripts/restore-db.sh
git add docker-compose.yml scripts/backup-db.sh scripts/restore-db.sh docs/RUNBOOK.md README.md docs/ARCHITECTURE.md docs/LOOP-LOG.md
git commit -m "chore(deploy): compose with pgvector Postgres, backup/restore scripts, runbook; docs L10"
```

---

## Self-Review

- 覆盖：CS-013 三项（PostgreSQL 唯一存储 ✔ Task 1/7；pgvector ✔ Task 1 `CREATE EXTENSION` + 镜像；pg-boss ✗——不在本计划，属于后续「异步作业」计划，已在 ARCHITECTURE 标注）。
- 方言清单：`INSERT OR REPLACE`×3、`INSERT OR IGNORE`×1、`PRAGMA`×2、`ROUND(double)`、子查询别名、`LIKE`、int8/numeric 字符串——均有对应 Task。
- 类型一致性：`Db.tx(fn:(t:Db)=>Promise<T>)` 在 Task 1 定义、Task 2 seed 使用；`rowToConversation` 返回 Promise 在 Task 2 定义、Task 3 使用 `Promise.all`；`COUNT(*)::int n` 用法在 Task 1 测试与 Task 2 server 一致。
