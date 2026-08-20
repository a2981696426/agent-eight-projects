import type { SiteContent } from '../types.ts'

export const hero: SiteContent['hero'] = {
  kicker: '审校型知识重建 · 10–15 分钟系统学习',
  title: '《Agent 面试必备的 8 个项目》',
  summary: '基于残留材料与公开资料重建的学习页：标明证据强度，保留八项目叙事，并修正工程边界；不是已删除文章的逐字全文。',
  confirmedFact: {
    text: '残存页面地址与站内索引确认标题《Agent 面试必备的 8 个项目》；原页面已删除。',
    evidence: {
      level: 'confirmed',
      sourceIds: ['deleted-codefather', 'codefather-index'],
      rationale: '删除页地址与仍可访问的站内索引可直接支持标题和删除状态。',
    },
  },
}

export const architecture: SiteContent['architecture'] = {
  layers: [
    { id: 'business-entry', label: '业务入口', description: '客服渠道、运营工作台、培训终端和内容审核入口。', relatedProjectIds: [1, 3, 6] },
    { id: 'ai-applications', label: 'AI 应用与工作流', description: 'AI 客服、运营内容工作流、直播切片、销售陪练与评分。', relatedProjectIds: [1, 3, 5, 6] },
    { id: 'knowledge-assets', label: '知识与内容资产', description: '知识库、评测集、训练集、偏好数据、素材中心及其版本和元数据。', relatedProjectIds: [1, 2, 4, 6, 7] },
    { id: 'data-governance', label: '数据治理与处理', description: '数据接入、清洗、脱敏、标注、多模态理解、血缘、质量和数据产品生成。', relatedProjectIds: [2, 4, 5, 7] },
    { id: 'source-systems', label: '业务源系统', description: '商品、ERP、订单、客服、运营和直播等原始系统。', relatedProjectIds: [2, 4] },
  ],
  capabilityConnection: {
    id: 'capability-connection',
    label: '能力连接',
    description: 'AI 应用通过 MCP 或工具网关调用企业能力；MCP 负责互操作边界，不承担完整运行平台职责。',
    relatedProjectIds: [8],
  },
  runtimeGovernance: {
    id: 'runtime-governance',
    label: '运行治理',
    description: '鉴权、租户隔离、最小权限、审计、可观测性、成本、幂等写入与重放、版本发布、实验和回滚横切全部五层。',
    relatedProjectIds: [8],
  },
  feedbackLoop: {
    text: '回答、审核和实验结果须经质量检查与人工审核；回流写入必须幂等，训练候选与固定评测集分区隔离，防止评测污染。',
    evidence: {
      level: 'editorial',
      sourceIds: [],
      rationale: '这是为保证反馈闭环可审计、可重放且不污染评测基准而补充的治理约束。',
    },
  },
}

export const evolution: SiteContent['evolution'] = [
  { range: '项目 1', label: '客服切入', description: '先用受约束检索和转人工建立面向用户的 AI 应用边界。' },
  { range: '项目 2', label: '数据成资产', description: '把多源业务事实加工为可治理、可版本化的数据产品。' },
  { range: '项目 3–6', label: '内容与培训复用', description: '将素材、内容生产、视频理解和销售陪练接入同一资产与审核闭环。' },
  { range: '项目 7–8', label: '模型优化与连接治理', description: '用评测、实验、MCP 能力连接和横切治理控制版本演进。' },
]
