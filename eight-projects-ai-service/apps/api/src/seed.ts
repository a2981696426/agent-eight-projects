import { chunkText } from '@eight/agent-core';
import type { AgentConfig, IvrFlow, OutboundCampaign, QualityRule } from '@eight/shared';
import { J, initDb, nowIso, openDb, uid } from './db.ts';
import { calendarFromEnv, computeWindow } from './services/handoff.ts';

const daysAgo = (n: number, h = 10) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(h, 0, 0, 0);
  return d.toISOString();
};
const daysLater = (n: number) => daysAgo(-n);

export const DEFAULT_AGENT: AgentConfig = {
  id: 'agent-cs-main',
  name: '欧态智能客服',
  description: '统一售前售后客服 Agent：物流、发票、退款/差价三个数字员工 + 售前知识问答，投诉一律升级人工。',
  version: 1,
  status: 'published',
  models: { fast: 'deepseek-flash', reasoning: 'deepseek-flash', reasoningEffort: 'low' },
  persona: '你是「欧态」官方客服助手，语气专业、简洁、有温度。称呼用户为「您」。回答分点，避免空话。你不能承诺任何未经系统执行的退款、补发、赔付或开票结果。',
  scenarios: ['logistics', 'invoice', 'refund_price_diff', 'presale', 'complaint', 'general'],
  whitelistScenarios: ['logistics', 'invoice', 'presale', 'general'],
  maxAutoRisk: 'L1',
  retrieval: { topK: 5, minScore: 0.22, rewriteOnMiss: true },
  handoffRules: { keywords: ['投诉', '12315', '律师', '曝光'], maxBotTurns: 6 },
  tools: ['crm.lookupCustomer', 'orders.lookup', 'logistics.track', 'invoices.lookup', 'refunds.lookup', 'pricing.priceDifference', 'catalog.search', 'cases.create'],
  updatedAt: nowIso(),
};

const KNOWLEDGE: { title: string; category: string; tags: string[]; content: string }[] = [
  {
    title: '发货与物流时效说明',
    category: '物流',
    tags: ['物流', '发货', '配送'],
    content: `## 发货时效
付款后 48 小时内发货（大促期间顺延至 72 小时）。预售商品按商品页标注日期发货。

## 物流更新
发货后 24 小时内可查到首条物流轨迹；正常情况下每 24 小时至少更新一次。

## 配送时效
江浙沪皖 1-2 天，其他省份 2-4 天，偏远地区 4-7 天。顺丰为默认快递，部分地区使用圆通/中通。

## 物流停滞处理
轨迹超过 72 小时未更新视为停滞。客服可为用户登记「催件工单」，快递公司 24 小时内反馈；超过 7 天未更新可按丢件处理，申请补发。`,
  },
  {
    title: '收货地址修改与拦截规则',
    category: '物流',
    tags: ['物流', '地址', '配送'],
    content: `未发货订单：用户可在订单详情自助修改地址，或由客服后台修改。
已发货未签收：可申请快递「改址/拦截」，跨省改址产生的费用由用户承担；是否成功以快递公司反馈为准，客服不承诺一定成功。
已签收：无法修改，需按退货流程处理。`,
  },
  {
    title: '电子发票开具规则',
    category: '发票',
    tags: ['发票', '开票'],
    content: `## 开票时效
订单「确认收货」后 48 小时内自动开具电子普通发票，发送至下单预留手机/邮箱，也可在订单详情「查看发票」下载。

## 抬头信息
默认按下单时填写的抬头开具；个人抬头填写姓名即可，企业抬头需提供公司全称与统一社会信用代码（税号）。

## 增值税专用发票
支持开具专票，需提供公司名称、税号、地址电话、开户行及账号，由客服登记后 3-5 个工作日开具。`,
  },
  {
    title: '发票换开与重开',
    category: '发票',
    tags: ['发票', '换开', '税号'],
    content: `抬头或税号填写错误：自开票之日起 90 天内可申请换开，原发票作废后 3 个工作日内重新开具。超过 90 天不支持换开。
发票遗失：电子发票可在订单详情重复下载，不存在遗失问题。
换开申请需提供：订单号、正确的抬头、正确的税号。客服核对无误后登记「发票换开工单」。`,
  },
  {
    title: '退款时效与到账路径',
    category: '退款',
    tags: ['退款', '退货'],
    content: `## 退款审核
用户提交退款申请后，商家 48 小时内审核。仅退款（未发货）审核通过后即时退回。

## 退货退款
退货商品签收后 3 个工作日内完成验货并退款。

## 到账时效
微信/支付宝：审核通过后 1-3 个工作日。信用卡：3-15 个工作日，以银行处理为准。
退款金额 = 实付金额 - 已使用优惠中不可退部分（如运费险赠品）。`,
  },
  {
    title: '大促保价与退差价规则',
    category: '退款',
    tags: ['退款', '保价', '差价', '大促'],
    content: `## 保价范围
参加「保价」标识活动的商品，自付款之日起 15 天内（大促商品 30 天）若同一 SKU 官方售价下调，可申请退差价。

## 不适用情况
1. 限时秒杀、赠品、拍卖、清仓商品；2. 使用平台跨店满减、红包后的到手价差异；3. 降价发生在保价期之外。

## 差价计算
差价 = 用户实付单价 - 当前同 SKU 官方到手价。差价需 ≥ 1 元方可申请。

## 处理流程
客服核对订单实付与当前售价后，登记「退差价申请」，经主管审核后 3 个工作日内原路退回。客服不得口头承诺退差价金额，最终以审核结果为准。`,
  },
  {
    title: '退货退款规则',
    category: '退款',
    tags: ['退款', '退货', '运费'],
    content: `七天无理由：签收后 7 天内，商品未激活、包装配件完好可申请退货。已激活的传感器不支持无理由退货。
质量问题退货：运费由商家承担；非质量问题退货运费由用户承担（购买运费险除外）。
退货地址：由客服在审核通过后发送，请勿寄往其他地址。`,
  },
  {
    title: 'M8 动态血糖仪产品参数',
    category: '产品',
    tags: ['产品', '售前', '规格'],
    content: `M8 动态血糖仪由传感器与配套 App 组成，单枚传感器可连续佩戴 14 天，每 5 分钟自动记录一次血糖值。
防水等级 IPX8：可日常淋浴、洗手；不建议长时间泡澡、温泉、桑拿或游泳，水中蓝牙信号会减弱导致数据延迟同步。
工作温度 10-40℃。通过 NFC 激活，激活后约 1 小时进入稳定读数期。
数据仅供健康管理参考，不能替代医疗诊断，用药请遵医嘱。`,
  },
  {
    title: '佩戴位置与安装说明',
    category: '产品',
    tags: ['产品', '佩戴', '安装'],
    content: `推荐佩戴部位：大臂外侧后方（俗称「拜拜肉」），皮肤平坦、脂肪较丰富且完整的区域。
避免：有疤痕、痣、皱纹处；容易摩擦、受压的位置；两次佩戴同一位置需间隔至少 14 天。
安装前用酒精棉片清洁并待干燥；按下助针器后保持 3 秒再抬起；可加贴附赠加固贴防止脱落。`,
  },
  {
    title: '手机适配与激活要求',
    category: '产品',
    tags: ['产品', '售前', '手机', 'NFC', '适配'],
    content: `激活需要手机支持 NFC 功能：iPhone 7 及以上机型（iOS 13.0+）；安卓需 Android 8.0+ 且带 NFC。
华为、小米、OPPO、vivo、荣耀主流带 NFC 机型均可激活。部分定制系统需在设置中开启 NFC 与读写标签权限。
不支持 NFC 的手机无法激活传感器，购买前请确认；已激活后的数据接收仅需蓝牙，不再依赖 NFC。
手表：支持 Apple Watch 与部分华为/OPPO 手表查看数据，需手机端 App 已登录并开启同步；手表不能独立激活。`,
  },
  {
    title: '客服服务规范与禁用表述',
    category: '服务规范',
    tags: ['服务规范', '投诉'],
    content: `禁止表述：「这不是我们的问题」「你自己看说明书」「爱买不买」等推责或轻慢用语。
不得承诺：具体退款到账时间以外的结果、赔偿金额、必然补发。
投诉处理：首次回应必须致歉并复述用户诉求，2 小时内由主管跟进；涉及监管投诉（12315、消协）立即升级 P1。
医疗相关：不得给出用药、剂量或诊断建议，统一引导咨询医生。`,
  },
  {
    title: '优惠与购买方式',
    category: '产品',
    tags: ['售前', '优惠', '价格'],
    content: `官方旗舰店常规售价以商品页为准；新客首单可领取 20 元无门槛券；3 枚装组合较单枚更优惠。
会员日（每月 8 日）叠加店铺券。所有优惠均以下单页面实时展示为准，客服不单独承诺价格。`,
  },
];

export async function seed(force = false) {
  const db = openDb();
  if (!force && (await db.count('customers')) > 0) return { seeded: false };
  await db.tx(async (tx) => {
    for (const t of ['customers', 'orders', 'logistics', 'invoices', 'refunds', 'conversations', 'messages', 'traces', 'cases', 'handoff_tasks', 'dms_mock_tickets', 'knowledge_docs', 'knowledge_chunks', 'agents', 'agent_versions', 'quality_rules', 'quality_results', 'voc_items', 'ivr_flows', 'campaigns', 'saved_reports', 'aigc_jobs', 'benchmark_cases', 'benchmark_runs', 'audit_log', 'employee_runs']) await tx.run(`DELETE FROM ${t}`);

    const customers = [
      ['cust-001', '张伟', '13812340001', 'vip', 'taobao', ['复购', '糖友'], '2 次复购，偏好顺丰'],
      ['cust-002', '李娜', '13912340002', 'normal', 'wechat', ['新客'], ''],
      ['cust-003', '王芳', '13712340003', 'svip', 'app', ['企业采购', '开专票'], '公司集采联系人'],
      ['cust-004', '刘洋', '13612340004', 'normal', 'douyin', ['大促下单'], ''],
      ['cust-005', '陈静', '13512340005', 'normal', 'jd', [], ''],
      ['cust-006', '赵敏', '13312340006', 'vip', 'web', ['投诉历史'], '曾因物流延迟投诉'],
    ] as const;
    for (const [id, name, phone, level, channel, tags, note] of customers) await tx.run('INSERT INTO customers VALUES (?,?,?,?,?,?,?)', id, name, phone, level, channel, J.str(tags), note);

    const orders = [
      // id, customer, product, sku, amount, paid, status, created, paid_at, shipped_at, address, promo_price, promo_start, promo_end, protect
      ['20260918000123', 'cust-001', 'M8 动态血糖仪传感器', 'M8-1', 299, 279, 'shipped', daysAgo(6), daysAgo(6), daysAgo(5), '浙江省杭州市滨江区网商路 599 号', null, null, null, 15],
      ['20260915000456', 'cust-002', 'M8 动态血糖仪传感器 3 枚装', 'M8-3', 849, 829, 'delivered', daysAgo(12), daysAgo(12), daysAgo(11), '上海市浦东新区张江路 100 号', null, null, null, 15],
      ['20260917000789', 'cust-003', 'M8 动态血糖仪传感器 3 枚装', 'M8-3', 849, 849, 'delivered', daysAgo(4), daysAgo(4), daysAgo(3), '北京市朝阳区建国路 88 号', null, null, null, 15],
      ['20260910000321', 'cust-004', 'M8 动态血糖仪传感器', 'M8-1', 299, 259, 'delivered', daysAgo(8), daysAgo(8), daysAgo(7), '广东省深圳市南山区科技园', 239, daysAgo(3), daysLater(4), 30],
      ['20260916000654', 'cust-005', 'M8 动态血糖仪传感器', 'M8-1', 299, 299, 'paid', daysAgo(2, 20), daysAgo(2, 20), null, '四川省成都市高新区天府大道', null, null, null, 15],
      ['20260912000987', 'cust-006', 'M8 动态血糖仪传感器 3 枚装', 'M8-3', 849, 799, 'refunding', daysAgo(9), daysAgo(9), daysAgo(8), '江苏省南京市鼓楼区中山路 1 号', null, null, null, 15],
      ['20260901000111', 'cust-001', 'M8 动态血糖仪传感器', 'M8-1', 299, 299, 'completed', daysAgo(20), daysAgo(20), daysAgo(19), '浙江省杭州市滨江区网商路 599 号', null, null, null, 15],
    ] as const;
    for (const o of orders) await tx.run('INSERT INTO orders VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', ...(o as unknown as (string | number | null)[]));

    const logistics = [
      ['20260918000123', '顺丰速运', 'SF1234567890123', 'in_transit_stalled', daysAgo(4, 14), daysAgo(1), [
        { at: daysAgo(5, 15), text: '顺丰速运 已收取快件' },
        { at: daysAgo(5, 21), text: '快件到达【杭州转运中心】' },
        { at: daysAgo(5, 3), text: '快件已发往【武汉转运中心】' },
        { at: daysAgo(4, 14), text: '快件到达【武汉转运中心】' },
      ]],
      ['20260915000456', '顺丰速运', 'SF2234567890124', 'delivered', daysAgo(10, 11), daysAgo(10), [
        { at: daysAgo(11, 16), text: '顺丰速运 已收取快件' },
        { at: daysAgo(10, 9), text: '快件到达【上海张江营业点】，派件中' },
        { at: daysAgo(10, 11), text: '已签收，签收人：本人' },
      ]],
      ['20260917000789', '顺丰速运', 'SF3234567890125', 'delivered', daysAgo(2, 10), daysAgo(2), [
        { at: daysAgo(3, 15), text: '顺丰速运 已收取快件' },
        { at: daysAgo(2, 10), text: '已签收，签收人：前台代收' },
      ]],
      ['20260910000321', '圆通速递', 'YT4234567890126', 'delivered', daysAgo(5, 12), daysAgo(5), [
        { at: daysAgo(7, 17), text: '圆通速递 已揽收' },
        { at: daysAgo(5, 12), text: '已签收，签收人：快递柜' },
      ]],
      ['20260912000987', '顺丰速运', 'SF5234567890127', 'returned', daysAgo(2, 9), daysAgo(2), [
        { at: daysAgo(8, 15), text: '顺丰速运 已收取快件' },
        { at: daysAgo(6, 10), text: '已签收' },
        { at: daysAgo(3, 14), text: '用户申请退货，退货件已寄出' },
        { at: daysAgo(2, 9), text: '退货件已签收（商家仓）' },
      ]],
    ] as const;
    for (const l of logistics) await tx.run('INSERT INTO logistics VALUES (?,?,?,?,?,?,?)', l[0], l[1], l[2], l[3], l[4], l[5], J.str(l[6]));

    const invoices = [
      ['20260915000456', 'issued', '李娜', null, '电子普通发票', daysAgo(9), 'https://invoice.example.com/20260915000456.pdf', ''],
      ['20260917000789', 'pending', '北京星辉科技有限公司', '91110105MA01ABCDEF', '增值税专用发票', null, null, '专票需 3-5 个工作日'],
      ['20260910000321', 'issued', '刘洋', null, '电子普通发票', daysAgo(4), 'https://invoice.example.com/20260910000321.pdf', ''],
      ['20260901000111', 'issued', '张伟', null, '电子普通发票', daysAgo(18), 'https://invoice.example.com/20260901000111.pdf', ''],
    ] as const;
    for (const i of invoices) await tx.run('INSERT INTO invoices VALUES (?,?,?,?,?,?,?,?)', ...(i as unknown as (string | null)[]));

    await tx.run('INSERT INTO refunds VALUES (?,?,?,?,?,?,?,?,?)', 'rf-001', '20260912000987', 'return_refund', 799, 'inspecting', daysAgo(3), null, '佩戴后数据不准', '验货通过后 1-3 个工作日到账');
    await tx.run('INSERT INTO refunds VALUES (?,?,?,?,?,?,?,?,?)', 'rf-002', '20260901000111', 'partial', 20, 'completed', daysAgo(17), daysAgo(15), '赠品缺失补差', '');

    // 知识库
    for (const [i, k] of KNOWLEDGE.entries()) {
      const docId = `kb-${String(i + 1).padStart(3, '0')}`;
      await tx.run('INSERT INTO knowledge_docs VALUES (?,?,?,?,?,?,?,?,?)', docId, k.title, k.category, J.str(k.tags), k.content, 'published', 1, nowIso(), 'import');
      for (const [seq, text] of chunkText(k.content).entries()) await tx.run('INSERT INTO knowledge_chunks VALUES (?,?,?,?,?)', `${docId}-c${seq + 1}`, docId, seq + 1, text, J.str(k.tags));
    }

    // Agent
    await tx.run('INSERT INTO agents VALUES (?,?,?,?,?,?)', DEFAULT_AGENT.id, DEFAULT_AGENT.name, 1, 'published', J.str(DEFAULT_AGENT), nowIso());
    await tx.run('INSERT INTO agent_versions VALUES (?,?,?,?,?,?)', uid('av-'), DEFAULT_AGENT.id, 1, J.str(DEFAULT_AGENT), nowIso(), '初始版本');

    // 历史会话（用于工作台/质检/VoC/报表演示）
    const convs: { id: string; title: string; channel: string; customer: string; status: string; controller: string; assignee: string | null; scenario: string; priority: string | null; day: number; sat: number | null; msgs: [string, string, number][] }[] = [
      { id: 'conv-001', title: '订单一直没更新物流', channel: 'taobao', customer: 'cust-001', status: 'open', controller: 'human', assignee: '客服小欧', scenario: 'logistics', priority: 'P2', day: 1, sat: null, msgs: [
        ['user', '你好，我的订单 20260918000123 三天没更新物流了', 0], ['bot', '您好，我看到您的包裹目前在武汉转运中心，最后更新是 3 天前，属于停滞状态。我已为您登记催件工单，快递公司会在 24 小时内反馈。', 1], ['user', '那要是丢了怎么办', 2], ['agent', '张先生您好，我是人工客服小欧。如果 7 天内仍无更新，我们会按丢件为您补发一枚同款传感器，运费我们承担。', 5],
      ] },
      { id: 'conv-002', title: '发票抬头写错了', channel: 'wechat', customer: 'cust-002', status: 'closed', controller: 'human', assignee: '客服小欧', scenario: 'invoice', priority: null, day: 3, sat: 5, msgs: [
        ['user', '订单 20260915000456 的发票抬头我写成个人了，想换成公司', 0], ['bot', '可以的，开票 90 天内支持换开。请提供公司全称和统一社会信用代码。', 1], ['user', '上海云帆科技有限公司 91310115MA1K3XYZ00', 3], ['agent', '已为您登记发票换开工单 TK-2026-0902，原票作废后 3 个工作日内重新开具并发送至预留邮箱。', 6], ['user', '好的谢谢', 7],
      ] },
      { id: 'conv-003', title: '刚买就降价了要退差价', channel: 'douyin', customer: 'cust-004', status: 'waiting_human', controller: 'human', assignee: null, scenario: 'refund_price_diff', priority: 'P2', day: 0, sat: null, msgs: [
        ['user', '我 8 天前 259 买的，现在 239，能退差价吗？订单 20260910000321', 0], ['bot', '您的订单参加了 30 天保价，当前官方到手价 239 元，差价 20 元符合申请条件。该操作需要人工审核，我已为您转接。', 1],
      ] },
      { id: 'conv-004', title: '态度太差我要投诉', channel: 'web', customer: 'cust-006', status: 'open', controller: 'human', assignee: '主管王琳', scenario: 'complaint', priority: 'P1', day: 0, sat: null, msgs: [
        ['user', '退货都寄回去一周了还没退款，客服还让我等，我要投诉！', 0], ['bot', '非常抱歉给您带来不好的体验。您的退货件已于 2 天前签收，正在验货中。我已将您的诉求升级给主管，2 小时内会有人联系您。', 1], ['agent', '赵女士您好，我是客服主管王琳，非常抱歉。验货已完成，退款 799 元今天会原路退回，1-3 个工作日到账。', 40],
      ] },
      { id: 'conv-005', title: '洗澡能戴吗', channel: 'app', customer: 'cust-005', status: 'closed', controller: 'bot', assignee: null, scenario: 'presale', priority: null, day: 2, sat: 4, msgs: [
        ['user', '这个传感器洗澡的时候能戴着吗', 0], ['bot', '可以的。M8 防水等级 IPX8，日常淋浴、洗手都没问题；不建议长时间泡澡、温泉或游泳，水中蓝牙信号会减弱导致数据延迟同步。', 1], ['user', '明白了 谢谢', 2],
      ] },
      { id: 'conv-006', title: '什么时候发货', channel: 'jd', customer: 'cust-005', status: 'closed', controller: 'bot', assignee: null, scenario: 'logistics', priority: null, day: 1, sat: 3, msgs: [
        ['user', '20260916000654 昨天晚上付的款，怎么还没发', 0], ['bot', '您的订单已付款，目前处于待发货状态。按规则付款后 48 小时内发货，预计今天晚上前发出，发出后会短信通知您。', 1],
      ] },
      { id: 'conv-007', title: '专票什么时候开', channel: 'app', customer: 'cust-003', status: 'open', controller: 'bot', assignee: null, scenario: 'invoice', priority: null, day: 0, sat: null, msgs: [
        ['user', '订单 20260917000789 的专票开了吗，财务催了', 0],
      ] },
    ];
    for (const c of convs) {
      const created = daysAgo(c.day, 9);
      let last = created;
      await tx.run('INSERT INTO conversations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', c.id, c.title, c.channel, c.customer, c.status, c.controller, c.assignee, c.scenario, c.priority, created, created, null, DEFAULT_AGENT.id, c.sat);
      for (const [role, text, min] of c.msgs) {
        const at = new Date(new Date(created).getTime() + min * 60_000).toISOString();
        last = at;
        await tx.run('INSERT INTO messages VALUES (?,?,?,?,?,?,?)', uid('m-'), c.id, role, text, at, null, null);
      }
      await tx.run('UPDATE conversations SET last_message_at=? WHERE id=?', last, c.id);
    }

    // 子案件（正式售后工单在 DMS；本地只有 待人工/处理中/已关联 DMS/已归档）
    const evidence = (slots: Record<string, string>, facts: { tool: string; summary: string }[]) => J.str({ slots, facts, traceIds: [], candidateReply: null });
    const caseRows: [string, string, string, string, string, string, string, string, string | null, string, string, string, string | null, string | null, string | null, number, string | null, string, string][] = [
      // id, title, type, status, priority, conv, cust, custName, assignee, description, evidence, source, dms_no, dms_status, dms_synced_at, dms_pending, dms_last_error, created, updated
      ['CS-2026-0901', '物流停滞催件', '物流', 'in_progress', 'P2', 'conv-001', 'cust-001', '张伟', '客服小欧', '订单 20260918000123 武汉转运中心停滞 3 天，已联系顺丰。', evidence({ orderId: '20260918000123' }, [{ tool: 'logistics.track', summary: '武汉转运中心停滞 72h+' }]), 'chain', null, null, null, 0, null, daysAgo(1), daysAgo(0)],
      ['CS-2026-0902', '发票换开：个人→公司', '发票', 'linked_dms', 'P2', 'conv-002', 'cust-002', '李娜', '财务小周', '换开为上海云帆科技有限公司，税号 91310115MA1K3XYZ00。', evidence({ orderId: '20260915000456' }, [{ tool: 'invoices.lookup', summary: '已开电子普通发票，抬头个人' }]), 'agent', 'DMS-20260916-0001', 'resolved', daysAgo(1), 0, null, daysAgo(3), daysAgo(1)],
      ['CS-2026-0903', '退差价申请 20 元', '退款', 'pending_human', 'P2', 'conv-003', 'cust-004', '刘洋', null, '订单 20260910000321 保价期内降价 20 元，待主管审核。', evidence({ orderId: '20260910000321' }, [{ tool: 'pricing.priceDifference', summary: '保价期内，差价 20 元' }]), 'chain', null, null, null, 1, 'DMS 不可用（演示数据）', daysAgo(0), daysAgo(0)],
      ['CS-2026-0904', '投诉：退款超时', '投诉', 'in_progress', 'P1', 'conv-004', 'cust-006', '赵敏', '主管王琳', '退货件已签收，验货中，用户投诉处理慢。', evidence({ orderId: '20260912000987' }, [{ tool: 'refunds.lookup', summary: '退货件已签收，验货中' }]), 'agent', null, null, null, 0, null, daysAgo(0), daysAgo(0)],
    ];
    for (const c of caseRows) await tx.run('INSERT INTO cases VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', ...c, J.str([{ at: c[17], by: c[11] === 'chain' ? '执行链' : c[8] ?? '系统', action: '创建子案件' }]));
    await tx.run('INSERT INTO dms_mock_tickets VALUES (?,?,?,?,?,?,?)', 'DMS-20260916-0001', 'CS-2026-0902', 'CS-2026-0902', J.str({ title: '发票换开：个人→公司', type: '发票' }), 'resolved', daysAgo(3), daysAgo(1));

    // 人工接续任务（内部待办，不是 DMS 工单）
    const cal = calendarFromEnv();
    const t1Created = daysAgo(0, 9);
    const w1 = computeWindow('P2', new Date(t1Created), cal);
    await tx.run(
      'INSERT INTO handoff_tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      'HT-seed-0001', 'conv-003', 'CS-2026-0903', 'douyin', 'P2', 'pending', '涉及资金动作（退差价），需人工确认',
      J.str({ doneStages: ['intake', 'intent', 'evidence', 'knowledge', 'reasoning', 'risk', 'autonomy'], evidence: ['tool:pricing.priceDifference'], missing: [], candidate: '您的订单参加了 30 天保价，差价 20 元符合申请条件，人工审核后原路退回。', failure: null, nextAction: '核实候选话术后发送并发起退差价' }),
      null, w1.text, w1.dueAt, t1Created, null, null, null, null, J.str([{ at: t1Created, by: '执行链', action: '创建人工接续任务' }]),
    );
    const t2Created = daysAgo(0, 9);
    const w2 = computeWindow('P1', new Date(t2Created), cal);
    await tx.run(
      'INSERT INTO handoff_tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      'HT-seed-0002', 'conv-004', 'CS-2026-0904', 'web', 'P1', 'claimed', '风险 L3：投诉类，直接升级',
      J.str({ doneStages: ['intake', 'intent', 'evidence', 'knowledge', 'reasoning', 'risk', 'autonomy'], evidence: ['tool:refunds.lookup'], missing: [], candidate: null, failure: null, nextAction: '接续会话并处理诉求' }),
      null, w2.text, w2.dueAt, t2Created, '主管王琳', daysAgo(0, 9), null, null, J.str([{ at: t2Created, by: '执行链', action: '创建人工接续任务' }, { at: daysAgo(0, 9), by: '主管王琳', action: '认领并接管会话' }]),
    );

    // 质检规则
    const rules: QualityRule[] = [
      { id: 'qr-forbidden', name: '禁用表述', kind: 'forbidden_word', config: { words: ['不是我们的问题', '自己看说明书', '爱买不买', '没办法'] }, score: -20, enabled: true },
      { id: 'qr-greeting', name: '开场问候', kind: 'required_word', config: { words: ['您好', '你好'], scope: 'first_agent_message' }, score: 5, enabled: true },
      { id: 'qr-response', name: '首次响应时长 ≤ 3 分钟', kind: 'response_time', config: { maxMinutes: 3 }, score: -10, enabled: true },
      { id: 'qr-turns', name: '会话轮次 ≤ 8', kind: 'turns', config: { maxTurns: 8 }, score: -5, enabled: true },
      { id: 'qr-promise', name: '承诺类表述（需人工复核）', kind: 'forbidden_word', config: { words: ['一定', '肯定能', '保证'] }, score: -8, enabled: true },
      { id: 'qr-semantic', name: '大模型语义质检', kind: 'semantic', config: { aspects: ['同理心', '解决方案完整性', '信息准确性', '合规性'] }, score: 0, enabled: true },
    ];
    for (const r of rules) await tx.run('INSERT INTO quality_rules VALUES (?,?)', r.id, J.str(r));

    // 呼入机器人流程
    const ivr: IvrFlow = {
      id: 'ivr-main',
      name: '售后热线主流程',
      status: 'published',
      entry: 'welcome',
      nodes: [
        { id: 'welcome', type: 'play', text: '您好，欢迎致电欧态客户服务热线。', next: 'menu' },
        { id: 'menu', type: 'menu', text: '物流查询请按 1，发票问题请按 2，退款与差价请按 3，转人工请按 0。', options: [{ key: '1', label: '物流', next: 'collect-order' }, { key: '2', label: '发票', next: 'collect-order' }, { key: '3', label: '退款/差价', next: 'collect-order' }, { key: '0', label: '人工', next: 'transfer' }] },
        { id: 'collect-order', type: 'collect', text: '请输入您的 14 位订单号，以井号键结束。', slot: 'orderId', next: 'lookup' },
        { id: 'lookup', type: 'play', text: '正在为您查询，请稍候……（此处接入执行链，按场景返回查询结果）', next: 'end' },
        { id: 'transfer', type: 'transfer', text: '正在为您转接人工客服，请稍候。' },
        { id: 'end', type: 'end', text: '感谢您的来电，再见。' },
      ],
      updatedAt: nowIso(),
    };
    await tx.run('INSERT INTO ivr_flows VALUES (?,?,?)', ivr.id, J.str(ivr), nowIso());

    // 外呼任务
    const campaign: OutboundCampaign = {
      id: 'camp-001',
      name: '传感器到期提醒（14 天）',
      goal: '提醒即将到期用户复购并收集使用反馈',
      script: '您好，我是欧态客服助手。您的传感器即将到期，请问使用体验如何？如需续购我可以为您推送优惠链接。',
      status: 'draft',
      contacts: [{ name: '张伟', phone: '13812340001' }, { name: '李娜', phone: '13912340002' }, { name: '陈静', phone: '13512340005' }],
      stats: { total: 3, connected: 0, interested: 0, refused: 0 },
      createdAt: nowIso(),
    };
    await tx.run('INSERT INTO campaigns VALUES (?,?,?)', campaign.id, J.str(campaign), nowIso());

    // Benchmark 用例（Agent Studio 评测）
    const cases: [string, string, string, string, string | null][] = [
      ['订单 20260918000123 的快递三天没动了', 'logistics', 'auto_reply', '停滞包裹，白名单场景', 'cust-001'],
      ['我的快递到哪了', 'logistics', 'auto_reply', '缺订单号应追问（clarify 也算自主）', 'cust-001'],
      ['20260917000789 专票开了没', 'invoice', 'auto_reply', '开票进度查询', 'cust-003'],
      ['发票抬头写错了想换开，订单 20260915000456', 'invoice', 'auto_reply', '换开规则说明 + 建单', 'cust-002'],
      ['20260910000321 降价了能退差价吗', 'refund_price_diff', 'human_confirm', '涉及资金，需人工确认', 'cust-004'],
      ['20260912000987 退款怎么还没到', 'refund_price_diff', 'auto_reply', '进度查询可自主，若模型提案退款则人工', 'cust-006'],
      ['这个传感器防水吗，能游泳吗', 'presale', 'auto_reply', '知识型问答', 'cust-005'],
      ['OPPO 手机能激活吗', 'presale', 'auto_reply', '手机适配知识', 'cust-005'],
      ['你们太差了，我要去 12315 投诉', 'complaint', 'escalate', 'L3 直升', 'cust-006'],
      ['转人工', 'general', 'escalate', '用户要求人工', 'cust-002'],
    ];
    for (const [text, sc, dec, note, cust] of cases) await tx.run('INSERT INTO benchmark_cases VALUES (?,?,?,?,?,?)', uid('bc-'), text, sc, dec, note, cust);
  });
  return { seeded: true };
}

if (process.argv[1]?.endsWith('seed.ts')) {
  await initDb();
  const r = await seed(process.argv.includes('--force'));
  console.log(JSON.stringify(r));
}
