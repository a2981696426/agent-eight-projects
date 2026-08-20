import type { SiteContent } from '../types.ts'
import { escapeHtml } from './escape.ts'

const routeLabels = ['01 客服切入', '02 数据成资产', '03–07 复用与反馈', '08 连接与治理'] as const

export function renderEvolution(evolution: SiteContent['evolution']): string {
  const stages = evolution.map((stage, index) => `<li>
  <h3>${routeLabels[index] ?? escapeHtml(stage.label)}</h3>
  <p>${escapeHtml(stage.description)}</p>
</li>`).join('\n')

  return `<section class="evolution" id="evolution" aria-labelledby="evolution-title">
  <h2 id="evolution-title">八个项目的演进路线</h2>
  <ol>${stages}</ol>
</section>`
}
