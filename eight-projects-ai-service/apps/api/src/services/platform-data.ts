import { createHash } from 'node:crypto';

/**
 * 电商平台只读业务数据源（CS-018）：订单 / 物流 / 退款作为执行链证据来源。
 * - 只读；收件人字段在映射层脱敏，原始手机号 / 详细地址不进入系统
 * - TmallSandboxSource：内置样例 + 失败注入（企业认证通过前的开发/演示/测试用）
 * - TmallTopSource：淘宝开放平台 TOP（sign_method=md5，POST router/rest），与沙箱共用映射器
 */
export type PlatformId = 'tmall';
export type PlatformSource = 'tmall-sandbox' | 'tmall-live';

export interface PlatformOrder {
  platform: PlatformId;
  orderId: string;
  status: string;
  statusText: string;
  createdAt: string;
  paidAt: string | null;
  shippedAt: string | null;
  amount: number;
  paidAmount: number;
  items: { title: string; skuText: string; qty: number; price: number }[];
  receiver: { nameMasked: string; phoneMasked: string; addressMasked: string };
  buyerNickMasked: string;
  source: PlatformSource;
  fetchedAt: string;
}
export interface PlatformLogistics {
  orderId: string;
  company: string;
  trackingNo: string;
  status: string;
  lastUpdate: string | null;
  hoursSinceUpdate: number | null;
  stalled: boolean;
  events: { time: string; desc: string }[];
  source: PlatformSource;
  fetchedAt: string;
}
export interface PlatformRefund {
  refundId: string;
  orderId: string;
  status: string;
  statusText: string;
  amount: number;
  reason: string;
  createdAt: string;
  modifiedAt: string;
  source: PlatformSource;
  fetchedAt: string;
}
export interface PlatformDataSource {
  readonly platform: PlatformId;
  readonly mode: 'sandbox' | 'live';
  getOrder(orderId: string): Promise<PlatformOrder | null>;
  getLogistics(orderId: string): Promise<PlatformLogistics | null>;
  getRefunds(orderId: string): Promise<PlatformRefund[]>;
  health(): Promise<{ ok: boolean; mode: 'sandbox' | 'live'; detail: string }>;
}

export class PlatformUnavailable extends Error {
  constructor(readonly kind: 'unavailable' | 'auth_expired' | 'rate_limited' | 'timeout', detail: string) {
    super(`${kind}: ${detail}`);
    this.name = 'PlatformUnavailable';
  }
}

/** 16~19 位数字视为天猫/淘宝订单号（本地演示订单为 14 位、手机号 11 位） */
export const detectPlatformOrder = (id: string): PlatformId | null => (/^\d{16,19}$/.test(id) ? 'tmall' : null);

/* ───────────── 脱敏与文案 ───────────── */
const maskName = (s: string) => (s ? s[0] + '*'.repeat(Math.max(1, Math.min(2, s.length - 1))) : '');
const maskPhone = (s: string) => (s && s.length >= 7 ? `${s.slice(0, 3)}****${s.slice(-4)}` : s ? '***' : '');
const maskNick = (s: string) => (s.length <= 2 ? `${s[0] ?? ''}*` : `${s[0]}**${s.slice(-2)}`);
const TRADE_STATUS: Record<string, string> = {
  WAIT_BUYER_PAY: '等待买家付款',
  WAIT_SELLER_SEND_GOODS: '已付款，等待卖家发货',
  WAIT_BUYER_CONFIRM_GOODS: '已发货，待买家确认收货',
  TRADE_BUYER_SIGNED: '买家已签收',
  TRADE_FINISHED: '交易成功',
  TRADE_CLOSED: '交易关闭（退款成功）',
  TRADE_CLOSED_BY_TAOBAO: '交易关闭（付款前关闭）',
};
const REFUND_STATUS: Record<string, string> = {
  WAIT_SELLER_AGREE: '买家已申请，等待卖家同意',
  WAIT_BUYER_RETURN_GOODS: '卖家已同意，等待买家退货',
  WAIT_SELLER_CONFIRM_GOODS: '买家已退货，等待卖家确认收货',
  SELLER_REFUSE_BUYER: '卖家拒绝退款',
  CLOSED: '退款关闭',
  SUCCESS: '退款成功',
};
const LOGISTICS_STATUS: Record<string, string> = { WAIT_ACCEPT: '待揽收', ACCEPT: '已揽收', TRANSPORT: '运输中', DELIVERING: '派送中', SIGN: '已签收', FAILED: '派送失败', REJECT: '拒签' };

const num = (v: unknown) => Number(v ?? 0) || 0;
const asArray = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : v ? [v as T] : []);

/* ───────────── 映射器（沙箱与 live 共用） ───────────── */
export function mapTradeFullinfo(json: Record<string, unknown>, source: PlatformSource): PlatformOrder {
  const t = ((json.trade_fullinfo_get_response as Record<string, unknown>)?.trade ?? json.trade ?? json) as Record<string, unknown>;
  const orders = asArray<Record<string, unknown>>((t.orders as Record<string, unknown>)?.order);
  const status = String(t.status ?? '');
  return {
    platform: 'tmall',
    orderId: String(t.tid ?? ''),
    status,
    statusText: TRADE_STATUS[status] ?? status,
    createdAt: String(t.created ?? ''),
    paidAt: t.pay_time ? String(t.pay_time) : null,
    shippedAt: t.consign_time ? String(t.consign_time) : null,
    amount: num(t.total_fee),
    paidAmount: num(t.payment),
    items: orders.map((o) => ({ title: String(o.title ?? ''), skuText: String(o.sku_properties_name ?? ''), qty: num(o.num), price: num(o.price) })),
    receiver: {
      nameMasked: maskName(String(t.receiver_name ?? '')),
      phoneMasked: maskPhone(String(t.receiver_mobile ?? t.receiver_phone ?? '')),
      addressMasked: `${t.receiver_state ?? ''}${t.receiver_city ?? ''}${t.receiver_district ?? ''}**`,
    },
    buyerNickMasked: maskNick(String(t.buyer_nick ?? '')),
    source,
    fetchedAt: new Date().toISOString(),
  };
}

export function mapLogisticsTrace(json: Record<string, unknown>, source: PlatformSource, now = new Date()): PlatformLogistics | null {
  const r = (json.logistics_trace_search_response ?? json) as Record<string, unknown>;
  if (!r || !r.out_sid) return null;
  const steps = asArray<Record<string, unknown>>((r.trace_list as Record<string, unknown>)?.transit_step_info)
    .map((s) => ({ time: String(s.status_time ?? ''), desc: String(s.status_desc ?? '') }))
    .sort((a, b) => (a.time < b.time ? 1 : -1));
  const last = steps[0]?.time ?? null;
  const hours = last ? Math.round((now.getTime() - new Date(last.replace(' ', 'T') + '+08:00').getTime()) / 36e5) : null;
  const status = String(r.status ?? '');
  return {
    orderId: String(r.tid ?? ''),
    company: String(r.company_name ?? ''),
    trackingNo: String(r.out_sid ?? ''),
    status: LOGISTICS_STATUS[status] ?? status,
    lastUpdate: last,
    hoursSinceUpdate: hours,
    stalled: hours != null && hours >= 72 && !['SIGN', 'REJECT'].includes(status),
    events: steps,
    source,
    fetchedAt: new Date().toISOString(),
  };
}

export function mapRefunds(json: Record<string, unknown>, source: PlatformSource): PlatformRefund[] {
  const r = (json.rp_refunds_receive_get_response ?? json) as Record<string, unknown>;
  return asArray<Record<string, unknown>>((r.refunds as Record<string, unknown>)?.refund).map((x) => ({
    refundId: String(x.refund_id ?? ''),
    orderId: String(x.tid ?? ''),
    status: String(x.status ?? ''),
    statusText: REFUND_STATUS[String(x.status ?? '')] ?? String(x.status ?? ''),
    amount: num(x.refund_fee),
    reason: String(x.reason ?? ''),
    createdAt: String(x.created ?? ''),
    modifiedAt: String(x.modified ?? ''),
    source,
    fetchedAt: new Date().toISOString(),
  }));
}

/* ───────────── 沙箱 ───────────── */
type SimMode = 'normal' | 'unavailable' | 'auth_expired' | 'rate_limited';
const hoursAgo = (h: number) => new Date(Date.now() - h * 36e5).toISOString().slice(0, 19).replace('T', ' ');

const SANDBOX_TRADES: Record<string, Record<string, unknown>> = {
  // 已发货 4 天、轨迹停滞 → 催件场景
  '2026091800012345678': {
    trade: { tid: '2026091800012345678', status: 'WAIT_BUYER_CONFIRM_GOODS', created: hoursAgo(120), pay_time: hoursAgo(119), consign_time: hoursAgo(100), total_fee: '1299.00', payment: '1199.00', buyer_nick: 'tb_ouy88', receiver_name: '李四', receiver_mobile: '13900001111', receiver_state: '广东省', receiver_city: '深圳市', receiver_district: '南山区', receiver_address: '科技园路 1 号', orders: { order: [{ title: 'M8 动态血糖仪 标准装', sku_properties_name: '颜色:白色;套餐:传感器×2', num: 1, price: '1299.00' }] } },
    logistics: { tid: '2026091800012345678', company_name: '顺丰速运', out_sid: 'SF1388000123456', status: 'TRANSPORT', trace_list: { transit_step_info: [{ status_time: hoursAgo(99), status_desc: '顺丰已收取快件' }, { status_time: hoursAgo(90), status_desc: '快件到达【杭州转运中心】' }, { status_time: hoursAgo(84), status_desc: '快件已发往【深圳转运中心】' }] } },
    refunds: [],
  },
  // 已付款待发货
  '2026091900023456789': {
    trade: { tid: '2026091900023456789', status: 'WAIT_SELLER_SEND_GOODS', created: hoursAgo(20), pay_time: hoursAgo(19.5), total_fee: '399.00', payment: '399.00', buyer_nick: 'wxy_2020', receiver_name: '王五', receiver_mobile: '13700002222', receiver_state: '上海', receiver_city: '上海市', receiver_district: '浦东新区', receiver_address: '张江路 88 号', orders: { order: [{ title: 'M8 传感器 单只装', sku_properties_name: '规格:14 天', num: 1, price: '399.00' }] } },
    logistics: null,
    refunds: [],
  },
  // 已完成，有一笔待卖家同意的退款
  '2026091600098765432': {
    trade: { tid: '2026091600098765432', status: 'TRADE_FINISHED', created: hoursAgo(240), pay_time: hoursAgo(239), consign_time: hoursAgo(230), total_fee: '1299.00', payment: '1299.00', buyer_nick: 'zh_lin', receiver_name: '赵六', receiver_mobile: '13600003333', receiver_state: '浙江省', receiver_city: '宁波市', receiver_district: '鄞州区', receiver_address: '天童北路 9 号', orders: { order: [{ title: 'M8 动态血糖仪 标准装', sku_properties_name: '颜色:黑色;套餐:传感器×2', num: 1, price: '1299.00' }] } },
    logistics: { tid: '2026091600098765432', company_name: '中通快递', out_sid: 'ZT7788990011', status: 'SIGN', trace_list: { transit_step_info: [{ status_time: hoursAgo(229), status_desc: '已揽收' }, { status_time: hoursAgo(180), status_desc: '已签收，签收人：本人' }] } },
    refunds: [{ refund_id: '99001', tid: '2026091600098765432', status: 'WAIT_SELLER_AGREE', refund_fee: '1299.00', reason: '七天无理由', created: hoursAgo(30), modified: hoursAgo(30) }],
  },
};

export class TmallSandboxSource implements PlatformDataSource {
  readonly platform = 'tmall' as const;
  readonly mode = 'sandbox' as const;
  private sim: SimMode = 'normal';
  simulate(mode: SimMode) {
    this.sim = mode;
  }
  get simulation() {
    return this.sim;
  }
  private gate() {
    if (this.sim === 'unavailable') throw new PlatformUnavailable('unavailable', '模拟：淘宝开放平台网关不可达');
    if (this.sim === 'auth_expired') throw new PlatformUnavailable('auth_expired', '模拟：商家授权 session 已过期（TOP code 27）');
    if (this.sim === 'rate_limited') throw new PlatformUnavailable('rate_limited', '模拟：应用调用频率超限（TOP code 7）');
  }
  async getOrder(orderId: string) {
    this.gate();
    const t = SANDBOX_TRADES[orderId];
    return t ? mapTradeFullinfo({ trade: t.trade } as Record<string, unknown>, 'tmall-sandbox') : null;
  }
  async getLogistics(orderId: string) {
    this.gate();
    const t = SANDBOX_TRADES[orderId];
    return t?.logistics ? mapLogisticsTrace(t.logistics as Record<string, unknown>, 'tmall-sandbox') : null;
  }
  async getRefunds(orderId: string) {
    this.gate();
    const t = SANDBOX_TRADES[orderId];
    return t ? mapRefunds({ refunds: { refund: t.refunds } }, 'tmall-sandbox') : [];
  }
  async health() {
    return { ok: this.sim === 'normal', mode: this.mode, detail: this.sim === 'normal' ? `沙箱正常（${Object.keys(SANDBOX_TRADES).length} 笔样例订单）` : `沙箱模拟故障：${this.sim}` };
  }
  static sampleOrderIds() {
    return Object.keys(SANDBOX_TRADES);
  }
}

/* ───────────── 淘宝开放平台 TOP ───────────── */
/** sign_method=md5：MD5(appSecret + 参数按 key 升序拼接 key+value + appSecret) 大写 */
export function topSign(params: Record<string, string>, appSecret: string): string {
  const s = Object.keys(params)
    .filter((k) => k !== 'sign' && params[k] != null && params[k] !== '')
    .sort()
    .map((k) => k + params[k])
    .join('');
  return createHash('md5').update(`${appSecret}${s}${appSecret}`, 'utf8').digest('hex').toUpperCase();
}

const fmtTopTime = (d = new Date()) => {
  // TOP 要求北京时间 yyyy-MM-dd HH:mm:ss
  const cn = new Date(d.getTime() + 8 * 36e5);
  return cn.toISOString().slice(0, 19).replace('T', ' ');
};

export interface TmallTopConfig {
  appKey: string;
  appSecret: string;
  /** 商家授权后的 access token */
  session: string;
  apiUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class TmallTopSource implements PlatformDataSource {
  readonly platform = 'tmall' as const;
  readonly mode = 'live' as const;
  private readonly cfg: TmallTopConfig;
  private lastError: string | null = null;
  constructor(cfg: TmallTopConfig) {
    this.cfg = { apiUrl: 'https://eco.taobao.com/router/rest', timeoutMs: 5000, ...cfg };
  }
  async call(method: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    const base: Record<string, string> = { method, app_key: this.cfg.appKey, session: this.cfg.session, timestamp: fmtTopTime(), format: 'json', v: '2.0', sign_method: 'md5', ...params };
    base.sign = topSign(base, this.cfg.appSecret);
    const f = this.cfg.fetchImpl ?? fetch;
    const once = async () => {
      const res = await f(this.cfg.apiUrl!, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' }, body: new URLSearchParams(base).toString(), signal: AbortSignal.timeout(this.cfg.timeoutMs!) });
      if (!res.ok) throw new PlatformUnavailable('unavailable', `TOP HTTP ${res.status}`);
      const json = (await res.json()) as Record<string, unknown>;
      const err = json.error_response as { code?: number; msg?: string; sub_code?: string; sub_msg?: string } | undefined;
      if (err) {
        const code = Number(err.code);
        if (code === 27 || code === 26 || /session/i.test(String(err.sub_code ?? ''))) throw new PlatformUnavailable('auth_expired', `TOP ${code} ${err.msg ?? ''} ${err.sub_msg ?? ''}`.trim());
        if (code === 7) throw new PlatformUnavailable('rate_limited', `TOP 7 ${err.msg ?? ''}`.trim());
        throw new Error(`TOP ${code} ${err.msg ?? ''} ${err.sub_code ?? ''} ${err.sub_msg ?? ''}`.trim());
      }
      return json;
    };
    try {
      const j = await once();
      this.lastError = null;
      return j;
    } catch (e) {
      // 业务错误（含 auth_expired / rate_limited）直接抛；网络类错误重试一次
      if (e instanceof PlatformUnavailable && e.kind !== 'unavailable') throw e;
      if (e instanceof Error && /^TOP \d+/.test(e.message)) throw e;
      try {
        const j = await once();
        this.lastError = null;
        return j;
      } catch (e2) {
        this.lastError = (e2 as Error).message;
        if (e2 instanceof PlatformUnavailable) throw e2;
        throw new PlatformUnavailable(/timeout|abort/i.test(String((e2 as Error).name + (e2 as Error).message)) ? 'timeout' : 'unavailable', (e2 as Error).message);
      }
    }
  }
  async getOrder(orderId: string) {
    const j = await this.call('taobao.trade.fullinfo.get', { tid: orderId, fields: 'tid,status,created,pay_time,consign_time,total_fee,payment,buyer_nick,receiver_name,receiver_mobile,receiver_phone,receiver_state,receiver_city,receiver_district,orders.title,orders.sku_properties_name,orders.num,orders.price' });
    const trade = (j.trade_fullinfo_get_response as Record<string, unknown>)?.trade;
    return trade ? mapTradeFullinfo(j, 'tmall-live') : null;
  }
  async getLogistics(orderId: string) {
    const j = await this.call('taobao.logistics.trace.search', { tid: orderId, seller_nick: '' });
    return mapLogisticsTrace(j, 'tmall-live');
  }
  async getRefunds(orderId: string) {
    const j = await this.call('taobao.rp.refunds.receive.get', { fields: 'refund_id,tid,status,refund_fee,reason,created,modified', page_size: '20', page_no: '1', type: 'fixed', tid: orderId });
    return mapRefunds(j, 'tmall-live').filter((r) => !r.orderId || r.orderId === orderId);
  }
  async health() {
    return { ok: !!(this.cfg.appKey && this.cfg.session) && !this.lastError, mode: this.mode, detail: this.lastError ? `最近一次调用失败：${this.lastError}` : `TOP live（app_key ${this.cfg.appKey.slice(0, 4)}…）` };
  }
}

/** TAOBAO_MODE=off|sandbox|live；live 缺配置时降级为 null（不阻塞服务） */
export function platformSourceFromEnv(): PlatformDataSource | null {
  const mode = (process.env.TAOBAO_MODE ?? 'sandbox').toLowerCase();
  if (mode === 'off') return null;
  if (mode === 'sandbox') return new TmallSandboxSource();
  const appKey = process.env.TAOBAO_APP_KEY ?? '';
  const appSecret = process.env.TAOBAO_APP_SECRET ?? '';
  const session = process.env.TAOBAO_SESSION ?? '';
  if (!appKey || !appSecret || !session) {
    console.warn('[platform] TAOBAO_MODE=live 但缺少 TAOBAO_APP_KEY / TAOBAO_APP_SECRET / TAOBAO_SESSION，平台数据源已关闭');
    return null;
  }
  return new TmallTopSource({ appKey, appSecret, session, apiUrl: process.env.TAOBAO_API_URL || undefined });
}
