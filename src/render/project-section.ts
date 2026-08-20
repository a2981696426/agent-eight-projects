import type { ArchitecturePositionId, Claim, ProjectContent, SourceRecord } from '../types.ts'
import { escapeAttribute, escapeHtml } from './escape.ts'
import { renderEvidence } from './evidence.ts'
import { renderClaimSources } from './source-reference.ts'

const positionLabels: Record<ArchitecturePositionId, string> = {
  'business-entry': '业务入口',
  'ai-applications': 'AI 应用与工作流',
  'knowledge-assets': '知识与内容资产',
  'data-governance': '数据治理与处理',
  'source-systems': '业务源系统',
  'capability-connection': '能力连接',
  'runtime-governance': '运行治理',
}

function renderClaim(claim: Claim): string {
  return `${renderEvidence(claim.evidence.level)} ${escapeHtml(claim.text)}`
}

function renderSystemPosition(project: ProjectContent): string {
  const primaryPositions = project.primaryPositions
    .map((position) => `<li>${escapeHtml(positionLabels[position])}</li>`)
    .join('')
  const layerTouchpoints = project.layerTouchpoints
    .map((layer) => `<li>${escapeHtml(positionLabels[layer])}</li>`)
    .join('')

  return `<section class="project__position" data-system-position data-primary-positions="${escapeAttribute(project.primaryPositions.join(','))}" data-layer-touchpoints="${escapeAttribute(project.layerTouchpoints.join(','))}" aria-labelledby="${escapeAttribute(`${project.anchor}-position-title`)}">
  <h3 id="${escapeAttribute(`${project.anchor}-position-title`)}">系统定位</h3>
  <h4>主要架构位置</h4>
  <ul data-primary-position-list>${primaryPositions}</ul>
  <h4>五层触点（非主要位置）</h4>
  <ul data-layer-touchpoint-list>${layerTouchpoints}</ul>
</section>`
}

export function renderProjectSection(project: ProjectContent, sources: readonly SourceRecord[]): string {
  const contextList = (items: readonly string[]): string => items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')
  const pipeline = project.pipeline.map((step) => `<li>
  <strong>${escapeHtml(step.label)}</strong>
  <span>${renderClaim(step.detail)}</span>
</li>`).join('\n')
  const questions = project.interviewQuestions.map(({ question, answer }) => `<dt>${escapeHtml(question)}</dt><dd>${escapeHtml(answer)}</dd>`).join('\n')

  return `<section id="${escapeAttribute(project.anchor)}" class="project" data-project-id="${project.id}" data-primary-positions="${escapeAttribute(project.primaryPositions.join(','))}" data-layer-touchpoints="${escapeAttribute(project.layerTouchpoints.join(','))}" aria-labelledby="${escapeAttribute(`${project.anchor}-title`)}">
  <header class="project__header">
    <p class="project__number">项目 ${project.id}</p>
    <h2 id="${escapeAttribute(`${project.anchor}-title`)}">${escapeHtml(project.title)}</h2>
    <p class="project__subtitle">${escapeHtml(project.subtitle)}</p>
    <p class="project__thesis">${renderClaim(project.thesis)}</p>
  </header>
  ${renderSystemPosition(project)}
  <div class="project__context">
    <h3>业务上下文</h3>
    <p>${renderClaim(project.businessProblem)}</p>
    <div class="project__dependencies">
      <h4>上游输入</h4><ul>${contextList(project.upstream)}</ul>
      <h4>下游消费者</h4><ul>${contextList(project.downstream)}</ul>
    </div>
  </div>
  <h3>核心 Pipeline</h3>
  <ol class="pipeline" data-project-pipeline>
${pipeline}
  </ol>
  <p class="feedback-loop"><strong>审校后的反馈回流：</strong>${renderClaim(project.feedbackLoop)}</p>
  <details class="audit-note">
    <summary>为什么这点需要审校？</summary>
    <p>${renderClaim(project.misconception)}</p>
    <p>审校依据：${escapeHtml(project.misconception.evidence.rationale)}</p>
    ${renderClaimSources(project.misconception, sources, '本条为编辑性工程判断，未主张存在可直接支持它的原始来源。')}
  </details>
  <h3>面试追问</h3>
  <dl class="interview-questions">
${questions}
  </dl>
</section>`
}
