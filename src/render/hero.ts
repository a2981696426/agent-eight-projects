import type { SiteContent, SourceRecord } from '../types.ts'
import { escapeHtml } from './escape.ts'
import { renderEvidence } from './evidence.ts'
import { renderClaimSources } from './source-reference.ts'

export function renderHero(hero: SiteContent['hero'], sources: readonly SourceRecord[]): string {
  return `<header class="hero" id="top">
  <p class="hero__kicker">${escapeHtml(hero.kicker)}</p>
  <h1>${escapeHtml(hero.title)}</h1>
  <p class="hero__summary">${escapeHtml(hero.summary)}</p>
  <div class="hero__confirmed-fact" data-hero-confirmed-fact>
    <p>${renderEvidence(hero.confirmedFact.evidence.level)} ${escapeHtml(hero.confirmedFact.text)}</p>
    ${renderClaimSources(hero.confirmedFact, sources, '本条没有登记直接来源。')}
  </div>
  <div class="evidence-legend" aria-label="证据强度说明">
    ${renderEvidence('confirmed')}
    ${renderEvidence('inferred')}
    ${renderEvidence('editorial')}
  </div>
</header>`
}
