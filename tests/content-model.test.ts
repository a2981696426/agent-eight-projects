import { describe, expect, it } from 'vitest'
import { projects, siteContent, sources } from '../src/content'
import type { Claim, EvidenceLevel } from '../src/types'

const levels = new Set<EvidenceLevel>(['confirmed', 'inferred', 'editorial'])

const expectedProjects = [
  { id: 1, title: 'AI 客服', slug: 'ai-customer-service', anchor: 'project-1-ai-customer-service', pipeline: ['意图与边界', '混合召回', '去重与重排', '受约束生成', '引用校验与转人工'] },
  { id: 2, title: '数据中台', slug: 'data-platform', anchor: 'project-2-data-platform', pipeline: ['全量/增量接入', '清洗脱敏', '人工标注', '多模态理解', '数据产品与版本'] },
  { id: 3, title: '运营 Agent', slug: 'operations-agent', anchor: 'project-3-operations-agent', pipeline: ['商品与人群分析', '任务编排', '文案/图片/视频生成', '合规检查', '人工审核'] },
  { id: 4, title: 'AI 素材中心', slug: 'ai-asset-center', anchor: 'project-4-ai-asset-center', pipeline: ['文件入库', '元数据绑定', '审核与版本', '组合检索', '事件通知与派生语义'] },
  { id: 5, title: '直播切片', slug: 'livestream-clipping', anchor: 'project-5-livestream-clipping', pipeline: ['ASR 与视觉理解', '商品时间轴', '候选片段', '多信号高光评分', '合成与审核'] },
  { id: 6, title: 'AI 销售考核', slug: 'ai-sales-assessment', anchor: 'project-6-ai-sales-assessment', pipeline: ['真实场景抽取', '难度化出题', '多轮陪练', '规则评分', 'LLM 评分与校准'] },
  { id: 7, title: '模型优化', slug: 'model-optimization', anchor: 'project-7-model-optimization', pipeline: ['数据筛选', 'SFT/偏好数据构造', '离线评测', '小流量实验', '扩量或回滚'] },
  { id: 8, title: 'MCP 与运行治理', slug: 'mcp-governance', anchor: 'project-8-mcp-governance', pipeline: ['工具边界设计', 'MCP/网关暴露', '身份权限', '调用观测', '版本实验与回滚'] },
] as const

const expectedProvenance = [
  {
    thesis: ['inferred', ['local-draft']],
    businessProblem: ['inferred', ['local-draft']],
    feedbackLoop: ['editorial', []],
    pipelineSources: [[], [], [], [], []],
    misconception: ['editorial', ['ragas-metrics']],
  },
  {
    thesis: ['editorial', []],
    businessProblem: ['inferred', ['local-draft']],
    feedbackLoop: ['editorial', []],
    pipelineSources: [['debezium-docs'], [], [], [], []],
    misconception: ['editorial', ['debezium-docs']],
  },
  {
    thesis: ['editorial', ['langgraph-workflows']],
    businessProblem: ['inferred', ['local-draft']],
    feedbackLoop: ['editorial', []],
    pipelineSources: [[], ['langgraph-workflows'], [], [], []],
    misconception: ['editorial', ['langgraph-workflows']],
  },
  {
    thesis: ['editorial', []],
    businessProblem: ['inferred', ['local-draft']],
    feedbackLoop: ['editorial', []],
    pipelineSources: [[], [], [], [], []],
    misconception: ['editorial', []],
  },
  {
    thesis: ['editorial', []],
    businessProblem: ['inferred', ['local-draft']],
    feedbackLoop: ['editorial', []],
    pipelineSources: [[], [], [], [], []],
    misconception: ['editorial', []],
  },
  {
    thesis: ['editorial', []],
    businessProblem: ['inferred', ['local-draft']],
    feedbackLoop: ['editorial', []],
    pipelineSources: [[], [], [], [], []],
    misconception: ['editorial', []],
  },
  {
    thesis: ['editorial', []],
    businessProblem: ['inferred', ['local-draft']],
    feedbackLoop: ['editorial', []],
    pipelineSources: [[], [], [], [], []],
    misconception: ['editorial', []],
  },
  {
    thesis: ['editorial', ['mcp-intro', 'mcp-architecture']],
    businessProblem: ['inferred', ['local-draft']],
    feedbackLoop: ['editorial', []],
    pipelineSources: [['mcp-architecture'], ['mcp-intro', 'mcp-architecture'], [], [], []],
    misconception: ['editorial', ['mcp-intro', 'mcp-architecture']],
  },
] as const

function expectProvenance(
  claim: Claim,
  expected: readonly [EvidenceLevel, readonly string[]],
): void {
  expect([claim.evidence.level, claim.evidence.sourceIds]).toEqual(expected)
  if (claim.evidence.level === 'editorial') {
    expect(claim.evidence.sourceIds).not.toContain('local-draft')
  }
}

function assertClaim(claim: Claim, sourceIds: Set<string>): void {
  expect(claim.text.trim().length).toBeGreaterThan(12)
  expect(levels.has(claim.evidence.level)).toBe(true)
  expect(claim.evidence.rationale.trim().length).toBeGreaterThan(8)
  for (const sourceId of claim.evidence.sourceIds) expect(sourceIds.has(sourceId)).toBe(true)
}

describe('audited site content', () => {
  it('contains exactly eight uniquely addressable projects', () => {
    expect(projects).toHaveLength(8)
    expect(projects.map(({ id, title, slug, anchor }) => ({ id, title, slug, anchor }))).toEqual(
      expectedProjects.map(({ id, title, slug, anchor }) => ({ id, title, slug, anchor })),
    )
    expect(new Set(projects.map((project) => project.slug)).size).toBe(8)
    expect(new Set(projects.map((project) => project.anchor)).size).toBe(8)
  })

  it('retains every approved pipeline label sequence', () => {
    expect(projects.map((project) => project.pipeline.map((step) => step.label))).toEqual(
      expectedProjects.map((project) => project.pipeline),
    )
  })

  it('gives every project a complete learning unit and valid evidence', () => {
    const sourceIds = new Set<string>(sources.map((source) => source.id))
    for (const project of projects) {
      assertClaim(project.thesis, sourceIds)
      assertClaim(project.businessProblem, sourceIds)
      assertClaim(project.feedbackLoop, sourceIds)
      assertClaim(project.misconception, sourceIds)
      expect(project.pipeline.length).toBeGreaterThanOrEqual(4)
      project.pipeline.forEach((step) => assertClaim(step.detail, sourceIds))
      expect(project.interviewQuestions).toHaveLength(2)
      expect(project.primaryPositions.length).toBeGreaterThan(0)
      expect(project.layerTouchpoints.length).toBeGreaterThan(0)
      expect(project.upstream.length).toBeGreaterThan(0)
      expect(project.downstream.length).toBeGreaterThan(0)
    }
  })

  it('exposes the approved five-layer architecture and reconstruction label', () => {
    expect(siteContent.architecture.layers).toHaveLength(5)
    expect(siteContent.hero.kicker).toContain('审校型知识重建')
    expect(siteContent.architecture.capabilityConnection.description).toContain('MCP')
    expect(siteContent.architecture.runtimeGovernance.description).toContain('鉴权')
  })

  it('separates project 8 cross-cutting primary positions from five-layer touchpoints', () => {
    const projectEight = projects[7]
    expect(projectEight?.primaryPositions).toEqual(['capability-connection', 'runtime-governance'])
    expect(projectEight?.layerTouchpoints).toEqual(['ai-applications', 'data-governance', 'source-systems'])
    expect(projectEight?.primaryPositions).not.toContain('ai-applications')
    expect(projectEight?.primaryPositions).not.toContain('data-governance')
    expect(projectEight?.primaryPositions).not.toContain('source-systems')

    expect(siteContent.architecture.capabilityConnection).toMatchObject({
      id: 'capability-connection',
      relatedProjectIds: [8],
    })
    expect(siteContent.architecture.runtimeGovernance).toMatchObject({
      id: 'runtime-governance',
      relatedProjectIds: [8],
    })
    for (const layer of siteContent.architecture.layers) {
      expect(layer.relatedProjectIds).not.toContain(8)
    }
  })

  it('assigns explicit honest provenance to every project claim', () => {
    const sourceIds = new Set<string>(sources.map((source) => source.id))
    for (const [index, project] of projects.entries()) {
      const expected = expectedProvenance[index]
      expect(expected).toBeDefined()
      expectProvenance(project.thesis, expected!.thesis)
      expectProvenance(project.businessProblem, expected!.businessProblem)
      expectProvenance(project.feedbackLoop, expected!.feedbackLoop)
      expectProvenance(project.misconception, expected!.misconception)
      expect(project.pipeline).toHaveLength(expected!.pipelineSources.length)
      for (const [stepIndex, step] of project.pipeline.entries()) {
        expectProvenance(step.detail, ['editorial', expected!.pipelineSources[stepIndex] ?? []])
      }
      for (const claim of [project.thesis, project.businessProblem, project.feedbackLoop, project.misconception, ...project.pipeline.map((step) => step.detail)]) {
        for (const sourceId of claim.evidence.sourceIds) expect(sourceIds.has(sourceId)).toBe(true)
      }
    }
  })

  it('registers the confirmed hero fact against the deleted page and residual index', () => {
    expectProvenance(siteContent.hero.confirmedFact, [
      'confirmed',
      ['deleted-codefather', 'codefather-index'],
    ])
    expect(siteContent.hero.confirmedFact.text).toContain('原页面已删除')
    expect(siteContent.hero.confirmedFact.text).toContain('Agent 面试必备的 8 个项目')
  })

  it('replaces the forty generic pipeline explanations with distinct operational boundaries', () => {
    const details = projects.flatMap((project) => project.pipeline.map((step) => step.detail.text))
    expect(details).toHaveLength(40)
    expect(new Set(details)).toHaveLength(40)
    for (const detail of details) {
      expect(detail).not.toContain('是该学习单元中的一个受审查流程步骤')
      expect(detail.length).toBeGreaterThanOrEqual(28)
      expect(detail).toMatch(/输入|输出|状态|记录|命中|失败|拒绝|阻断|回滚|审核|人工|版本|告警|超时|差异|指标|样本|偏移量|信号/)
    }
  })

  it('makes idempotency and evaluation-contamination isolation visible editorial constraints', () => {
    expect(siteContent.architecture.runtimeGovernance.description).toContain('幂等')
    expect(siteContent.architecture.feedbackLoop.evidence.level).toBe('editorial')
    expect(siteContent.architecture.feedbackLoop.evidence.sourceIds).not.toContain('local-draft')
    expect(siteContent.architecture.feedbackLoop.text).toContain('评测污染')
    expect(siteContent.architecture.feedbackLoop.text).toContain('隔离')
  })
})
