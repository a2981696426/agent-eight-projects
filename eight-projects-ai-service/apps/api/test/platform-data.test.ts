import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PlatformUnavailable, TmallSandboxSource, TmallTopSource, detectPlatformOrder, mapLogisticsTrace, mapRefunds, mapTradeFullinfo, platformSourceFromEnv, topSign } from '../src/services/platform-data.ts';

test('detectPlatformOrder：16~19 位为天猫订单；14 位本地订单与手机号不是', () => {
  assert.equal(detectPlatformOrder('2026091800012345678'), 'tmall');
  assert.equal(detectPlatformOrder('1234567890123456'), 'tmall');
  assert.equal(detectPlatformOrder('20260918000123'), null);
  assert.equal(detectPlatformOrder('13812340001'), null);
});

test('topSign：MD5(secret + 按 key 排序拼接 + secret) 大写，与参数顺序无关，忽略 sign 自身', () => {
  const params = { method: 'taobao.trade.fullinfo.get', app_key: 'test', timestamp: '2026-09-19 10:00:00', format: 'json', v: '2.0', sign_method: 'md5', tid: '2026091800012345678' };
  const expected = createHash('md5').update(`secret${['app_key', 'format', 'method', 'sign_method', 'tid', 'timestamp', 'v'].map((k) => k + (params as Record<string, string>)[k]).join('')}secret`).digest('hex').toUpperCase();
  assert.equal(topSign(params, 'secret'), expected);
  assert.equal(topSign({ ...params, sign: 'ignored' }, 'secret'), expected);
  assert.match(topSign(params, 'secret'), /^[0-9A-F]{32}$/);
});

const TRADE_JSON = {
  trade_fullinfo_get_response: {
    trade: {
      tid: 2026091800012345678n.toString(),
      status: 'WAIT_BUYER_CONFIRM_GOODS',
      created: '2026-09-15 20:11:02',
      pay_time: '2026-09-15 20:12:40',
      consign_time: '2026-09-16 09:30:00',
      total_fee: '1299.00',
      payment: '1199.00',
      buyer_nick: 't**b1234',
      receiver_name: '张三',
      receiver_mobile: '13812340001',
      receiver_state: '浙江省',
      receiver_city: '杭州市',
      receiver_district: '西湖区',
      receiver_address: '文三路 100 号 3 单元 502',
      orders: { order: [{ title: 'M8 动态血糖仪 标准装', sku_properties_name: '颜色:白色;套餐:传感器×2', num: 1, price: '1299.00' }] },
    },
  },
};

test('mapTradeFullinfo：映射状态文案与金额，收件人脱敏，不保留原始手机号/详细地址', () => {
  const o = mapTradeFullinfo(TRADE_JSON, 'tmall-live');
  assert.equal(o.orderId, '2026091800012345678');
  assert.equal(o.status, 'WAIT_BUYER_CONFIRM_GOODS');
  assert.equal(o.statusText, '已发货，待买家确认收货');
  assert.equal(o.amount, 1299);
  assert.equal(o.paidAmount, 1199);
  assert.equal(o.items[0].title, 'M8 动态血糖仪 标准装');
  assert.equal(o.receiver.nameMasked, '张*');
  assert.equal(o.receiver.phoneMasked, '138****0001');
  assert.equal(o.receiver.addressMasked, '浙江省杭州市西湖区**');
  assert.equal(o.source, 'tmall-live');
  assert.ok(!JSON.stringify(o).includes('13812340001') && !JSON.stringify(o).includes('文三路'));
});

test('mapLogisticsTrace / mapRefunds：轨迹按时间倒序、停滞判定；退款状态文案', () => {
  const l = mapLogisticsTrace({ logistics_trace_search_response: { tid: '2026091800012345678', company_name: '顺丰速运', out_sid: 'SF1234567890', status: 'TRANSPORT', trace_list: { transit_step_info: [{ status_time: '2026-09-16 10:00:00', status_desc: '已揽收' }, { status_time: '2026-09-16 18:00:00', status_desc: '到达杭州转运中心' }] } } }, 'tmall-live', new Date('2026-09-20T10:00:00+08:00'));
  assert.ok(l);
  assert.equal(l!.company, '顺丰速运');
  assert.equal(l!.events[0].desc, '到达杭州转运中心');
  assert.equal(l!.stalled, true);
  assert.ok((l!.hoursSinceUpdate ?? 0) >= 72);
  const r = mapRefunds({ rp_refunds_receive_get_response: { refunds: { refund: [{ refund_id: '99001', tid: '2026091800012345678', status: 'WAIT_SELLER_AGREE', refund_fee: '1199.00', reason: '七天无理由', created: '2026-09-18 09:00:00', modified: '2026-09-18 09:00:00' }] } } }, 'tmall-live');
  assert.equal(r.length, 1);
  assert.equal(r[0].statusText, '买家已申请，等待卖家同意');
  assert.equal(r[0].amount, 1199);
});

test('TmallSandboxSource：三笔固定订单；simulate unavailable / auth_expired 抛 PlatformUnavailable', async () => {
  const s = new TmallSandboxSource();
  assert.equal(s.mode, 'sandbox');
  const o = await s.getOrder('2026091800012345678');
  assert.equal(o?.source, 'tmall-sandbox');
  const l = await s.getLogistics('2026091800012345678');
  assert.equal(l?.stalled, true);
  assert.equal((await s.getRefunds('2026091600098765432')).length, 1);
  assert.equal(await s.getOrder('9999999999999999'), null);
  s.simulate('unavailable');
  await assert.rejects(s.getOrder('2026091800012345678'), PlatformUnavailable);
  s.simulate('auth_expired');
  await assert.rejects(s.getLogistics('2026091800012345678'), /auth_expired/);
  assert.equal((await s.health()).ok, false);
  s.simulate('normal');
  assert.equal((await s.health()).ok, true);
});

test('TmallTopSource.call：请求体含 method/app_key/session/sign；error_response 27 → auth_expired；网络错误一次重试', async () => {
  const bodies: URLSearchParams[] = [];
  let failOnce = true;
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = new URLSearchParams(String(init?.body));
    bodies.push(body);
    if (failOnce) {
      failOnce = false;
      throw new Error('ECONNRESET');
    }
    if (body.get('tid') === 'bad') return new Response(JSON.stringify({ error_response: { code: 27, msg: 'Invalid session' } }), { status: 200 });
    return new Response(JSON.stringify(TRADE_JSON), { status: 200 });
  };
  const src = new TmallTopSource({ appKey: 'k', appSecret: 's', session: 'sess', fetchImpl });
  const o = await src.getOrder('2026091800012345678');
  assert.equal(o?.receiver.phoneMasked, '138****0001');
  assert.equal(bodies.length, 2, '第一次网络错误后重试一次');
  assert.equal(bodies[1].get('method'), 'taobao.trade.fullinfo.get');
  assert.equal(bodies[1].get('app_key'), 'k');
  assert.equal(bodies[1].get('session'), 'sess');
  assert.match(bodies[1].get('sign') ?? '', /^[0-9A-F]{32}$/);
  await assert.rejects(src.getOrder('bad'), /auth_expired/);
});

test('platformSourceFromEnv：off → null；sandbox → 沙箱；live 缺配置 → 降级 null', () => {
  process.env.TAOBAO_MODE = 'off';
  assert.equal(platformSourceFromEnv(), null);
  process.env.TAOBAO_MODE = 'sandbox';
  assert.ok(platformSourceFromEnv() instanceof TmallSandboxSource);
  process.env.TAOBAO_MODE = 'live';
  delete process.env.TAOBAO_APP_KEY;
  assert.equal(platformSourceFromEnv(), null);
  process.env.TAOBAO_APP_KEY = 'k';
  process.env.TAOBAO_APP_SECRET = 's';
  process.env.TAOBAO_SESSION = 't';
  assert.ok(platformSourceFromEnv() instanceof TmallTopSource);
  process.env.TAOBAO_MODE = 'sandbox';
});
