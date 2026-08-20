import { describe, expect, it } from 'vitest'
import { siteContent } from '../src/content'
import { renderPage } from '../src/render/page'
import { renderSupportingSections } from '../src/render/supporting-sections.js'
import type { SiteContent } from '../src/types.js'

function parse(markup: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = markup
  return root
}

describe('static page rendering', () => {
  it('renders the reconstruction identity and five-layer system before enhancement', () => {
    const root = parse(renderPage(siteContent))
    expect(root.querySelector('h1')?.textContent).toContain('8 个项目')
    expect(root.textContent).toContain('审校型知识重建')
    expect(root.querySelectorAll('[data-architecture-layer]')).toHaveLength(5)
    expect(root.textContent).toContain('MCP')
    expect(root.textContent).toContain('横切治理')
  })

  it('uses real anchors for architecture navigation without JavaScript', () => {
    const root = parse(renderPage(siteContent))
    const links = [...root.querySelectorAll<HTMLAnchorElement>('[data-related-projects]')]
    expect(links.length).toBeGreaterThanOrEqual(7)
    expect(links.every((link) => link.hash.startsWith('#project-'))).toBe(true)
  })

  it('links capability connection and runtime governance directly to project 8', () => {
    const root = parse(renderPage(siteContent))
    const projectEightHash = `#${siteContent.projects[7]?.anchor}`
    const capabilityLink = root.querySelector<HTMLAnchorElement>('.capability-connection a[data-related-projects="8"]')
    const governanceLink = root.querySelector<HTMLAnchorElement>('.governance-rail a[data-related-projects="8"]')

    expect(capabilityLink?.getAttribute('data-architecture-position')).toBe('capability-connection')
    expect(capabilityLink?.hash).toBe(projectEightHash)
    expect(governanceLink?.getAttribute('data-architecture-position')).toBe('runtime-governance')
    expect(governanceLink?.hash).toBe(projectEightHash)
    for (const layer of root.querySelectorAll('[data-architecture-layer]')) {
      expect(layer.getAttribute('data-related-projects')?.split(',')).not.toContain('8')
    }
  })

  it('renders eight complete project learning units', () => {
    const root = parse(renderPage(siteContent))
    const sections = [...root.querySelectorAll<HTMLElement>('section[data-project-id]')]
    expect(sections).toHaveLength(8)
    for (const section of sections) {
      expect(section.querySelector('[data-project-pipeline]')).not.toBeNull()
      expect(section.querySelector('details.audit-note')).not.toBeNull()
      expect(section.querySelectorAll('dt')).toHaveLength(2)
      expect(section.querySelector('[data-evidence]')).not.toBeNull()
    }
  })

  it('renders the insight, interview, audit, and source sections', () => {
    const root = parse(renderPage(siteContent))
    expect(root.querySelector('#core-insight')?.textContent).toContain('数据复用')
    expect(root.querySelector('#interview-script')?.textContent).toContain('30 秒')
    expect(root.querySelector('#audit-summary')?.textContent).toContain('MCP')
    expect(root.querySelector('#sources')?.textContent).toContain('原页面已删除')
  })

  it('renders primary positions separately from ordinary layer touchpoints', () => {
    const positionLabels = {
      'business-entry': '业务入口',
      'ai-applications': 'AI 应用与工作流',
      'knowledge-assets': '知识与内容资产',
      'data-governance': '数据治理与处理',
      'source-systems': '业务源系统',
      'capability-connection': '能力连接',
      'runtime-governance': '运行治理',
    } as const
    const root = parse(renderPage(siteContent))

    for (const project of siteContent.projects) {
      const section = root.querySelector<HTMLElement>(`section[data-project-id="${project.id}"]`)
      const position = section?.querySelector<HTMLElement>('[data-system-position]')
      expect(position).not.toBeNull()
      expect(position?.dataset.primaryPositions).toBe(project.primaryPositions.join(','))
      expect(position?.dataset.layerTouchpoints).toBe(project.layerTouchpoints.join(','))
      for (const primaryPosition of project.primaryPositions) {
        expect(position?.querySelector('[data-primary-position-list]')?.textContent).toContain(positionLabels[primaryPosition])
      }
      for (const layer of project.layerTouchpoints) {
        expect(position?.querySelector('[data-layer-touchpoint-list]')?.textContent).toContain(positionLabels[layer])
      }
    }

    const projectEightPosition = root.querySelector<HTMLElement>('[data-project-id="8"] [data-system-position]')
    expect(projectEightPosition?.querySelector('[data-primary-position-list]')?.textContent).toContain('能力连接')
    expect(projectEightPosition?.querySelector('[data-primary-position-list]')?.textContent).toContain('运行治理')
    expect(projectEightPosition?.querySelector('[data-primary-position-list]')?.textContent).not.toContain('AI 应用与工作流')
    expect(projectEightPosition?.querySelector('[data-primary-position-list]')?.textContent).not.toContain('数据治理与处理')
    expect(projectEightPosition?.querySelector('[data-primary-position-list]')?.textContent).not.toContain('业务源系统')
  })

  it('renders the confirmed hero fact with its registered deleted and index sources', () => {
    const root = parse(renderPage(siteContent))
    const fact = root.querySelector<HTMLElement>('[data-hero-confirmed-fact]')
    expect(fact?.querySelector('[data-evidence="confirmed"]')).not.toBeNull()
    expect(fact?.textContent).toContain('原页面已删除')
    expect(fact?.textContent).toContain('编程导航 / Codefather')
    expect(fact?.textContent).toContain('鱼皮 AI 导航')
  })

  it('renders visible editorial governance constraints for idempotency and evaluation isolation', () => {
    const root = parse(renderPage(siteContent))
    const governance = root.querySelector<HTMLElement>('.governance-rail')
    const feedback = root.querySelector<HTMLElement>('.system-map > .feedback-loop')
    expect(governance?.textContent).toContain('幂等')
    expect(feedback?.querySelector('[data-evidence="editorial"]')).not.toBeNull()
    expect(feedback?.textContent).toContain('评测污染')
    expect(feedback?.textContent).toContain('隔离')
  })

  it('keeps chapter navigation targets resolvable and escapes hostile project navigation values', () => {
    const root = parse(renderPage(siteContent))
    for (const link of root.querySelectorAll<HTMLAnchorElement>('.chapter-nav a[href^="#"]')) {
      const id = link.getAttribute('href')?.slice(1)
      expect(id).toBeTruthy()
      expect(root.querySelector(`[id="${id}"]`)).not.toBeNull()
    }

    const hostileContent: SiteContent = {
      ...siteContent,
      projects: siteContent.projects.map((project) => project.id === 1
        ? { ...project, anchor: 'project-1" data-nav-injected="true', title: '<svg data-nav-title="true">unsafe</svg>' }
        : project),
    }
    const hostileMarkup = renderPage(hostileContent)
    const hostileRoot = parse(hostileMarkup)
    expect(hostileMarkup).toContain('&quot; data-nav-injected=&quot;true')
    expect(hostileMarkup).toContain('&lt;svg data-nav-title=&quot;true&quot;&gt;unsafe&lt;/svg&gt;')
    expect(hostileRoot.querySelector('[data-nav-injected], [data-nav-title]')).toBeNull()
  })

  it('renders safe source links with visible status and leaves javascript URLs non-clickable', () => {
    const sources: SiteContent['sources'] = [
      { id: 'deleted-safe', title: '已删除来源', url: 'https://example.test/deleted', status: 'deleted', publisher: '测试发布者', purpose: '验证删除状态' },
      { id: 'unsafe', title: '不安全来源', url: 'javascript:alert(1)', status: 'live', publisher: '测试发布者', purpose: '验证链接策略' },
    ]
    const root = parse(renderSupportingSections({ ...siteContent, sources }))
    const safeLink = root.querySelector<HTMLAnchorElement>('a[href="https://example.test/deleted"]')
    expect(safeLink?.textContent).toContain('测试发布者 · 已删除来源')
    expect(safeLink?.getAttribute('rel')).toBe('noreferrer')
    expect(root.textContent).toContain('原页面已删除')
    expect(root.querySelector('a[href^="javascript:"]')).toBeNull()
    expect(root.querySelectorAll('a')).toHaveLength(1)
    expect(root.textContent).toContain('不安全来源')
  })

  it('resolves project audit sources from the custom SiteContent aggregate', () => {
    const customSources: SiteContent['sources'] = siteContent.sources.map((source) => (
      source.id === 'ragas-metrics'
        ? {
            ...source,
            title: '聚合内评测来源',
            publisher: '自定义来源注册表',
            url: 'https://example.test/custom-ragas',
          }
        : source
    ))
    const root = parse(renderPage({ ...siteContent, sources: customSources }))
    const projectOneAudit = root.querySelector<HTMLElement>('[data-project-id="1"] .audit-note')

    expect(projectOneAudit?.textContent).toContain('自定义来源注册表 · 聚合内评测来源')
    expect(projectOneAudit?.querySelector('a')?.href).toBe('https://example.test/custom-ragas')
    expect(projectOneAudit?.textContent).not.toContain('Ragas · List of available metrics')
  })
})
