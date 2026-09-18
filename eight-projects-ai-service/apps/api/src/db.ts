import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { env } from './env.ts';

export const uid = (prefix = '') => `${prefix}${randomUUID().slice(0, 8)}`;
export const nowIso = () => new Date().toISOString();

type Row = Record<string, unknown>;

export class Db {
  readonly sqlite: DatabaseSync;
  constructor(file: string) {
    this.sqlite = new DatabaseSync(file);
    this.sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
    this.migrate();
  }
  all<T = Row>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.sqlite.prepare(sql).all(...params) as T[];
  }
  get<T = Row>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.sqlite.prepare(sql).get(...params) as T | undefined;
  }
  run(sql: string, ...params: SQLInputValue[]) {
    return this.sqlite.prepare(sql).run(...params);
  }
  tx<T>(fn: () => T): T {
    this.sqlite.exec('BEGIN');
    try {
      const r = fn();
      this.sqlite.exec('COMMIT');
      return r;
    } catch (e) {
      this.sqlite.exec('ROLLBACK');
      throw e;
    }
  }
  count(table: string) {
    return (this.get<{ n: number }>(`SELECT COUNT(*) n FROM ${table}`)?.n ?? 0) as number;
  }
  private migrate() {
    this.sqlite.exec(`
CREATE TABLE IF NOT EXISTS customers(id TEXT PRIMARY KEY, name TEXT, phone TEXT, level TEXT, channel TEXT, tags TEXT, note TEXT);
CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY, customer_id TEXT, product TEXT, sku TEXT, amount REAL, paid_amount REAL, status TEXT, created_at TEXT, paid_at TEXT, shipped_at TEXT, address TEXT, promo_price REAL, promo_start TEXT, promo_end TEXT, price_protect_days INTEGER);
CREATE TABLE IF NOT EXISTS logistics(order_id TEXT PRIMARY KEY, carrier TEXT, tracking_no TEXT, status TEXT, last_update TEXT, eta TEXT, events TEXT);
CREATE TABLE IF NOT EXISTS invoices(order_id TEXT PRIMARY KEY, status TEXT, title TEXT, tax_id TEXT, type TEXT, issued_at TEXT, url TEXT, note TEXT);
CREATE TABLE IF NOT EXISTS refunds(id TEXT PRIMARY KEY, order_id TEXT, type TEXT, amount REAL, status TEXT, applied_at TEXT, processed_at TEXT, reason TEXT, channel_eta TEXT);
CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, title TEXT, channel TEXT, customer_id TEXT, status TEXT, controller TEXT, assignee TEXT, scenario TEXT, priority TEXT, last_message_at TEXT, created_at TEXT, summary TEXT, agent_id TEXT, satisfaction INTEGER);
CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, conversation_id TEXT, role TEXT, text TEXT, at TEXT, trace_id TEXT, meta TEXT);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, at);
CREATE TABLE IF NOT EXISTS traces(id TEXT PRIMARY KEY, conversation_id TEXT, agent_id TEXT, agent_version INTEGER, created_at TEXT, scenario TEXT, intent TEXT, decision TEXT, risk_level TEXT, duration_ms INTEGER, status TEXT, doc TEXT);
CREATE INDEX IF NOT EXISTS idx_traces_conv ON traces(conversation_id, created_at);
CREATE TABLE IF NOT EXISTS tickets(id TEXT PRIMARY KEY, title TEXT, type TEXT, status TEXT, priority TEXT, conversation_id TEXT, customer_id TEXT, customer_name TEXT, assignee TEXT, description TEXT, sla_due_at TEXT, created_at TEXT, updated_at TEXT, source TEXT, history TEXT);
CREATE TABLE IF NOT EXISTS knowledge_docs(id TEXT PRIMARY KEY, title TEXT, category TEXT, tags TEXT, content TEXT, status TEXT, version INTEGER, updated_at TEXT, source TEXT);
CREATE TABLE IF NOT EXISTS knowledge_chunks(id TEXT PRIMARY KEY, doc_id TEXT, seq INTEGER, text TEXT, tags TEXT);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON knowledge_chunks(doc_id);
CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY, name TEXT, version INTEGER, status TEXT, doc TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS agent_versions(id TEXT PRIMARY KEY, agent_id TEXT, version INTEGER, doc TEXT, published_at TEXT, note TEXT);
CREATE TABLE IF NOT EXISTS quality_rules(id TEXT PRIMARY KEY, doc TEXT);
CREATE TABLE IF NOT EXISTS quality_results(id TEXT PRIMARY KEY, conversation_id TEXT, agent TEXT, score REAL, doc TEXT, created_at TEXT, reviewed_by TEXT, review_note TEXT);
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
`);
    // 增量列（幂等）
    for (const [table, column, ddl] of [
      ['traces', 'degraded', 'INTEGER DEFAULT 0'],
      ['traces', 'failed_over', 'INTEGER DEFAULT 0'],
      ['traces', 'llm_calls', 'INTEGER DEFAULT 0'],
    ] as const) {
      const cols = this.all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name);
      if (!cols.includes(column)) this.sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
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

let instance: Db | null = null;
export function openDb() {
  if (instance) return instance;
  mkdirSync(env.dataDir, { recursive: true });
  instance = new Db(join(env.dataDir, 'platform.sqlite'));
  return instance;
}
