import type { ScenarioPack } from '@eight/shared';

/**
 * 内置场景包 = 售后数字员工。
 * 同一条执行链依据场景包切换：必填槽位、可用工具、知识标签、允许自动执行的动作与自治风险上限。
 */
export const SCENARIO_PACKS: ScenarioPack[] = [
  {
    id: 'logistics',
    name: '物流智能体',
    description: '物流进度查询、发货时效、地址修改、异常件（停滞/破损/丢件）处理。',
    requiredSlots: [{ key: 'orderId', label: '订单号', ask: '为了帮您查询物流，请提供订单号（例如 2026091800xx）。' }],
    tools: ['orders.lookup', 'logistics.track'],
    knowledgeTags: ['物流', '发货', '配送'],
    allowedAutoActions: ['none', 'clarify', 'create_ticket'],
    maxAutoRisk: 'L1',
    examples: ['我的快递到哪了', '什么时候发货', '物流三天没更新了', '地址填错了能改吗'],
  },
  {
    id: 'invoice',
    name: '发票智能体',
    description: '发票开具进度、抬头/税号修改、换开重开、电子发票获取。',
    requiredSlots: [{ key: 'orderId', label: '订单号', ask: '请提供需要处理发票的订单号，我来核对开票状态。' }],
    tools: ['orders.lookup', 'invoices.lookup'],
    knowledgeTags: ['发票', '开票', '税号'],
    allowedAutoActions: ['none', 'clarify', 'create_ticket', 'invoice_reissue'],
    maxAutoRisk: 'L1',
    examples: ['发票什么时候开', '抬头写错了要换开', '电子发票在哪下载', '能开专票吗'],
  },
  {
    id: 'refund_price_diff',
    name: '退款/差价智能体',
    description: '退款进度、退款金额核对、大促保价与退差价、退货退款规则。',
    requiredSlots: [{ key: 'orderId', label: '订单号', ask: '请提供订单号，我来核对退款/保价信息。' }],
    tools: ['orders.lookup', 'refunds.lookup', 'pricing.priceDifference'],
    knowledgeTags: ['退款', '保价', '差价', '退货'],
    allowedAutoActions: ['none', 'clarify', 'create_ticket'],
    maxAutoRisk: 'L1',
    examples: ['退款怎么还没到账', '刚买就降价了能退差价吗', '退货运费谁承担', '申请退款多久处理'],
  },
  {
    id: 'presale',
    name: '售前咨询',
    description: '商品参数、适配、库存、优惠与购买方式等知识型问答。',
    requiredSlots: [],
    tools: ['catalog.search'],
    knowledgeTags: ['产品', '售前', '规格', '优惠'],
    allowedAutoActions: ['none', 'clarify'],
    maxAutoRisk: 'L1',
    examples: ['这个型号支持哪些手机', '防水吗', '现在有什么优惠', '和竞品比有什么区别'],
  },
  {
    id: 'complaint',
    name: '投诉与升级',
    description: '服务投诉、纠纷、赔偿诉求、监管/舆情风险，一律进入人工优先队列。',
    requiredSlots: [],
    tools: ['orders.lookup'],
    knowledgeTags: ['投诉', '服务规范'],
    allowedAutoActions: ['none'],
    maxAutoRisk: 'L0',
    examples: ['我要投诉', '你们态度太差了', '我要去12315', '必须赔偿'],
  },
  {
    id: 'general',
    name: '通用咨询',
    description: '寒暄、账号、使用说明等未命中其他场景的问题。',
    requiredSlots: [],
    tools: [],
    knowledgeTags: [],
    allowedAutoActions: ['none', 'clarify'],
    maxAutoRisk: 'L1',
    examples: ['你好', '人工客服', '怎么注册账号'],
  },
];

export const scenarioById = (id: string | null | undefined) => SCENARIO_PACKS.find((s) => s.id === id) ?? SCENARIO_PACKS.find((s) => s.id === 'general')!;
