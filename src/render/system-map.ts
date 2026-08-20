import type { SiteContent } from '../types.ts'
import { escapeAttribute, escapeHtml } from './escape.ts'
import { renderEvidence } from './evidence.ts'

function projectAnchor(content: SiteContent, projectId: number): string {
  const project = content.projects.find(({ id }) => id === projectId)
  if (!project) throw new Error(`Architecture layer references missing project ${projectId}.`)
  return project.anchor
}

export function renderSystemMap(content: SiteContent): string {
  const layers = content.architecture.layers.map((layer) => {
    const relatedProjects = layer.relatedProjectIds.join(',')
    const firstProjectId = layer.relatedProjectIds[0]
    if (firstProjectId === undefined) throw new Error(`Architecture layer ${layer.id} has no related projects.`)

    return `<li>
  <a data-architecture-layer="${escapeAttribute(layer.id)}" data-related-projects="${escapeAttribute(relatedProjects)}" href="#${escapeAttribute(projectAnchor(content, firstProjectId))}">
    <strong>${escapeHtml(layer.label)}</strong>
    <span>${escapeHtml(layer.description)}</span>
  </a>
</li>`
  }).join('\n')
  const relatedProjectLinks = [...new Set(content.architecture.layers.flatMap((layer) => layer.relatedProjectIds))]
    .map((projectId) => {
      const project = content.projects.find(({ id }) => id === projectId)
      if (!project) throw new Error(`Architecture layer references missing project ${projectId}.`)
      return `<li><a data-related-projects="${projectId}" href="#${escapeAttribute(project.anchor)}">${escapeHtml(project.title)}</a></li>`
    })
    .join('\n')
  const projectEightAnchor = projectAnchor(content, 8)
  const capability = content.architecture.capabilityConnection
  const governance = content.architecture.runtimeGovernance

  return `<section class="system-map" id="system-map" aria-labelledby="system-map-title">
  <h2 id="system-map-title">五层系统</h2>
  <ol>${layers}</ol>
  <nav aria-label="相关项目">
    <ul>${relatedProjectLinks}</ul>
  </nav>
  <section class="capability-connection" aria-labelledby="capability-connection-title">
    <h3 id="capability-connection-title"><a data-architecture-position="${capability.id}" data-related-projects="${capability.relatedProjectIds.join(',')}" href="#${escapeAttribute(projectEightAnchor)}">${escapeHtml(capability.label)} → 项目 8</a></h3>
    <p>MCP / Tool Gateway：标准化能力连接，不等同于运行治理</p>
    <p>${escapeHtml(capability.description)}</p>
  </section>
  <section class="governance-rail" aria-labelledby="governance-rail-title">
    <h3 id="governance-rail-title"><a data-architecture-position="${governance.id}" data-related-projects="${governance.relatedProjectIds.join(',')}" href="#${escapeAttribute(projectEightAnchor)}">横切${escapeHtml(governance.label)} → 项目 8</a></h3>
    <p>鉴权 · 租户隔离 · 审计 · 可观测性 · 成本 · 幂等 · 发布 · 回滚</p>
    <p>${escapeHtml(governance.description)}</p>
  </section>
  <p class="feedback-loop">${renderEvidence(content.architecture.feedbackLoop.evidence.level)} ${escapeHtml(content.architecture.feedbackLoop.text)}</p>
</section>`
}
