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

/* ───────────── 驱动：pg（生产，连接 PostgreSQL 16 + pgvector） ───────────── */
class PgDriver implements SqlDriver {
  readonly kind = 'pg' as const;
  private readonly pool: Pool;
  constructor(readonly connectionString: string) {
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

/* ───────────── 驱动：PGlite（本机/测试，进程内 Postgres，零外部依赖） ───────────── */
class PgliteDriver implements SqlDriver {
  readonly kind = 'pglite' as const;
  private constructor(readonly pg: PGlite) {}
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

/* ───────────── Db：业务代码使用的薄封装（保留 ? 占位符写法） ───────────── */
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
CREATE TABLE IF NOT EXISTS cases(id TEXT PRIMARY KEY, title TEXT, type TEXT, status TEXT, priority TEXT, conversation_id TEXT, customer_id TEXT, customer_name TEXT, assignee TEXT, description TEXT, evidence TEXT, source TEXT, dms_ticket_no TEXT, dms_status TEXT, dms_synced_at TEXT, dms_pending INTEGER DEFAULT 0, dms_last_error TEXT, created_at TEXT, updated_at TEXT, history TEXT);
CREATE INDEX IF NOT EXISTS idx_cases_conv ON cases(conversation_id);
CREATE TABLE IF NOT EXISTS handoff_tasks(id TEXT PRIMARY KEY, conversation_id TEXT, case_id TEXT, channel TEXT, priority TEXT, status TEXT, reason TEXT, progress TEXT, trace_id TEXT, window_text TEXT, due_at TEXT, created_at TEXT, claimed_by TEXT, claimed_at TEXT, done_at TEXT, alert TEXT, history TEXT);
CREATE INDEX IF NOT EXISTS idx_handoff_conv ON handoff_tasks(conversation_id, status);
CREATE TABLE IF NOT EXISTS dms_mock_tickets(ticket_no TEXT PRIMARY KEY, idem_key TEXT UNIQUE, case_id TEXT, payload TEXT, status TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS channel_identities(channel TEXT, external_user_id TEXT, customer_id TEXT, display_name TEXT, created_at TEXT, last_seen_at TEXT, PRIMARY KEY(channel, external_user_id));
CREATE TABLE IF NOT EXISTS channel_messages(channel TEXT, external_msg_id TEXT, conversation_id TEXT, message_id TEXT, received_at TEXT, PRIMARY KEY(channel, external_msg_id));
CREATE TABLE IF NOT EXISTS whitelists(id TEXT PRIMARY KEY, scope TEXT, version INTEGER, status TEXT, items TEXT, note TEXT, created_by TEXT, created_at TEXT, signed_by TEXT, signed_at TEXT, published_by TEXT, published_at TEXT, disabled_by TEXT, disabled_at TEXT, disabled_reason TEXT);
CREATE INDEX IF NOT EXISTS idx_whitelists_scope ON whitelists(scope, status);
DROP TABLE IF EXISTS tickets;
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

let vectorReady = false;
/** pgvector 是否可用（决定混合检索能否启用） */
export const hasVector = () => vectorReady;

async function migrate(driver: SqlDriver) {
  try {
    await driver.query('CREATE EXTENSION IF NOT EXISTS vector', []);
    vectorReady = true;
  } catch (e) {
    vectorReady = false;
    console.warn(`[db] pgvector 不可用，向量检索将不可用：${(e as Error).message}`);
  }
  for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) await driver.query(stmt, []);
  if (vectorReady) {
    // 知识向量表：维度来自 EMBEDDING_DIMS；换维度需 DROP 后重建并全量重嵌入
    const dims = Math.max(8, Number(process.env.EMBEDDING_DIMS ?? 1024) || 1024);
    await driver.query(`CREATE TABLE IF NOT EXISTS knowledge_vectors(chunk_id TEXT PRIMARY KEY, doc_id TEXT, provider TEXT, model TEXT, dims INTEGER, embedding vector(${dims}), updated_at TEXT)`, []);
    await driver.query('CREATE INDEX IF NOT EXISTS idx_kv_doc ON knowledge_vectors(doc_id)', []);
  }
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

/** 启动时调用一次：DATABASE_URL 非空 → pg；否则 PGlite（dataDir=null 为内存库） */
export async function initDb(opts: { url?: string; dataDir?: string | null } = {}): Promise<Db> {
  if (instance) return instance;
  const url = opts.url ?? env.databaseUrl;
  const dataDir = opts.dataDir === undefined ? env.pgliteDir : opts.dataDir;
  driver = url ? new PgDriver(url) : await PgliteDriver.create(dataDir);
  await migrate(driver);
  instance = new Db(driver, driver);
  return instance;
}
/** 供 pg-boss 等需要原生连接的组件使用：pg → 连接串；PGlite → 实例（单进程共享） */
export function driverHandle(): { kind: 'pg'; connectionString: string } | { kind: 'pglite'; pglite: PGlite } {
  if (!driver) throw new Error('数据库未初始化：请先 await initDb()');
  return driver instanceof PgDriver ? { kind: 'pg', connectionString: driver.connectionString } : { kind: 'pglite', pglite: (driver as PgliteDriver).pg };
}
/** 同步访问器：initDb 之后可在任意位置使用 */
export function openDb(): Db {
  if (!instance) throw new Error('数据库未初始化：请先 await initDb()');
  return instance;
}
export async function closeDb() {
  await driver?.close();
  driver = null;
  instance = null;
}
