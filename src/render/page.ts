import { siteContent } from '../content/index.ts'
import type { SiteContent } from '../types.ts'
import { renderEvolution } from './evolution.ts'
import { renderHero } from './hero.ts'
import { renderProjectSection } from './project-section.ts'
import { renderSupportingSections } from './supporting-sections.ts'
import { renderSystemMap } from './system-map.ts'
import { escapeAttribute, escapeHtml, safeHref } from './escape.ts'

function renderChapterNavigation(content: SiteContent): string {
  const projectLinks = content.projects.map((project) => {
    const href = safeHref(`#${project.anchor}`)
    if (!href) throw new Error(`Project ${project.id} has an unsafe chapter anchor.`)
    return `<li><a href="${escapeAttribute(href)}">项目 ${project.id}：${escapeHtml(project.title)}</a></li>`
  }).join('')
  return `<nav class="chapter-nav" aria-label="文章章节">
  <ul>
    <li><a href="#system-map">五层系统</a></li>
    <li><a href="#evolution">演进路线</a></li>
    ${projectLinks}
    <li><a href="#core-insight">核心洞察</a></li>
    <li><a href="#interview-script">面试表达</a></li>
    <li><a href="#audit-summary">审校结论</a></li>
    <li><a href="#sources">来源与恢复边界</a></li>
  </ul>
</nav>`
}

export function renderPage(content: SiteContent = siteContent): string {
  return `<article class="knowledge-page">
${renderChapterNavigation(content)}
${renderHero(content.hero, content.sources)}
${renderSystemMap(content)}
${renderEvolution(content.evolution)}
${content.projects.map((project) => renderProjectSection(project, content.sources)).join('\n')}
${renderSupportingSections(content)}
</article>`
}
