import type { DmsFailure, DmsMockMode, DmsTicket, DmsTicketStatus, Priority } from '@eight/shared';
import { J, nowIso, openDb } from '../db.ts';

/**
 * DMS 适配器契约（CS-003 / CS-016）：DMS 是正式售后工单的唯一权威，本平台只创建/关联并回读状态。
 * - 失败语义是业务结果（unavailable / rejected / not_found / account_cancelled），不是异常
 * - createTicket 以子案件 id 作幂等键：重试不得产生第二张工单
 * 真实适配器在接口授权可得后按同一契约实现，业务代码不改。
 */
export type DmsResult<T> = { ok: true; data: T } | { ok: false; kind: DmsFailure; message: string };

export interface DmsTicketInput {
  caseId: string;
  title: string;
  type: string;
  priority: Priority;
  customerName: string;
  orderId?: string | null;
  description: string;
  evidence: unknown;
}

export interface DmsAdapter {
  readonly kind: 'mock' | 'real';
  createTicket(input: DmsTicketInput): Promise<DmsResult<DmsTicket>>;
  getTicket(ticketNo: string): Promise<DmsResult<DmsTicket>>;
  health(): Promise<{ ok: boolean; kind: 'mock' | 'real'; mode: DmsMockMode | 'live' }>;
}

const NEXT: Record<DmsTicketStatus, DmsTicketStatus> = { received: 'processing', processing: 'resolved', resolved: 'closed', closed: 'closed' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 模拟 DMS：落库 dms_mock_tickets，可注入失败模式与推进状态 */
export class MockDmsAdapter implements DmsAdapter {
  readonly kind = 'mock' as const;
  mode: DmsMockMode = 'normal';
  private readonly db = () => openDb();

  private toTicket(r: Record<string, unknown>): DmsTicket {
    return { ticketNo: String(r.ticket_no), status: r.status as DmsTicketStatus, updatedAt: String(r.updated_at) };
  }

  private failure(): DmsResult<never> | null {
    if (this.mode === 'unavailable') return { ok: false, kind: 'unavailable', message: 'DMS 不可用：连接超时（模拟）' };
    if (this.mode === 'reject') return { ok: false, kind: 'rejected', message: 'DMS 拒绝建单：缺少必填字段 phone（模拟）' };
    if (this.mode === 'account_cancelled') return { ok: false, kind: 'account_cancelled', message: '激活账号已注销，DMS 拒绝展示/建单（模拟）' };
    return null;
  }

  private async nextTicketNo(): Promise<string> {
    const day = nowIso().slice(0, 10).replace(/-/g, '');
    const n = await this.db().get<{ n: number }>('SELECT COUNT(*)::int n FROM dms_mock_tickets WHERE ticket_no LIKE ?', `DMS-${day}-%`);
    return `DMS-${day}-${String((n?.n ?? 0) + 1).padStart(4, '0')}`;
  }

  async createTicket(input: DmsTicketInput): Promise<DmsResult<DmsTicket>> {
    if (this.mode === 'slow') await sleep(1500);
    const f = this.failure();
    if (f) return f;
    const existing = await this.db().get('SELECT * FROM dms_mock_tickets WHERE idem_key=?', input.caseId);
    if (existing) return { ok: true, data: this.toTicket(existing) };
    const no = await this.nextTicketNo();
    const now = nowIso();
    await this.db().run('INSERT INTO dms_mock_tickets VALUES (?,?,?,?,?,?,?) ON CONFLICT (idem_key) DO NOTHING', no, input.caseId, input.caseId, J.str(input), 'received', now, now);
    const row = await this.db().get('SELECT * FROM dms_mock_tickets WHERE idem_key=?', input.caseId);
    return { ok: true, data: this.toTicket(row!) };
  }

  async getTicket(ticketNo: string): Promise<DmsResult<DmsTicket>> {
    if (this.mode === 'slow') await sleep(800);
    if (this.mode === 'unavailable') return { ok: false, kind: 'unavailable', message: 'DMS 不可用：连接超时（模拟）' };
    const row = await this.db().get('SELECT * FROM dms_mock_tickets WHERE ticket_no=?', ticketNo);
    if (!row) return { ok: false, kind: 'not_found', message: `DMS 中不存在工单 ${ticketNo}` };
    return { ok: true, data: this.toTicket(row) };
  }

  /** 演示/测试用：推进状态机 */
  async advance(ticketNo: string): Promise<DmsResult<DmsTicket>> {
    const row = await this.db().get('SELECT * FROM dms_mock_tickets WHERE ticket_no=?', ticketNo);
    if (!row) return { ok: false, kind: 'not_found', message: `DMS 中不存在工单 ${ticketNo}` };
    const next = NEXT[row.status as DmsTicketStatus] ?? 'closed';
    await this.db().run('UPDATE dms_mock_tickets SET status=?, updated_at=? WHERE ticket_no=?', next, nowIso(), ticketNo);
    return this.getTicket(ticketNo);
  }

  async list(): Promise<(DmsTicket & { caseId: string; createdAt: string })[]> {
    const rows = await this.db().all('SELECT * FROM dms_mock_tickets ORDER BY created_at DESC LIMIT 200');
    return rows.map((r) => ({ ...this.toTicket(r), caseId: String(r.case_id), createdAt: String(r.created_at) }));
  }

  async health() {
    return { ok: this.mode !== 'unavailable', kind: this.kind, mode: this.mode };
  }
}

/** 真实适配器占位：接口授权可得后实现（建单 / 查询），契约不变 */
class RealDmsAdapter implements DmsAdapter {
  readonly kind = 'real' as const;
  async createTicket(): Promise<DmsResult<DmsTicket>> {
    return { ok: false, kind: 'unavailable', message: '真实 DMS 适配器尚未实现（接口授权中），请使用 DMS_MODE=mock' };
  }
  async getTicket(): Promise<DmsResult<DmsTicket>> {
    return { ok: false, kind: 'unavailable', message: '真实 DMS 适配器尚未实现' };
  }
  async health() {
    return { ok: false, kind: this.kind, mode: 'live' as const };
  }
}

export const dms: DmsAdapter = process.env.DMS_MODE === 'real' ? new RealDmsAdapter() : new MockDmsAdapter();
export const dmsMock = dms instanceof MockDmsAdapter ? dms : null;
