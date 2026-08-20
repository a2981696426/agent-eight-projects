import type { Claim, SourceRecord } from '../types.ts'
import { escapeAttribute, escapeHtml, safeHref } from './escape.ts'

export function sourceFor(sourceId: string, sources: readonly SourceRecord[]): SourceRecord {
  const source = sources.find(({ id }) => id === sourceId)
  if (!source) throw new Error(`Claim references missing source ${sourceId}.`)
  return source
}

export function renderSourceReference(source: SourceRecord): string {
  const status = source.status === 'deleted' ? '（已删除）' : ''
  const label = `${source.publisher} · ${source.title}${status}`
  const href = source.url ? safeHref(source.url) : undefined
  if (!href) return `<span class="source-reference">${escapeHtml(label)}</span>`

  return `<a class="source-reference" href="${escapeAttribute(href)}" rel="noreferrer">${escapeHtml(label)}</a>`
}

export function renderClaimSources(
  claim: Claim,
  sources: readonly SourceRecord[],
  emptyMessage: string,
): string {
  if (claim.evidence.sourceIds.length === 0) return `<p>${escapeHtml(emptyMessage)}</p>`

  const references = claim.evidence.sourceIds
    .map((sourceId) => renderSourceReference(sourceFor(sourceId, sources)))
    .join('；')
  return `<p class="claim-sources">来源：${references}</p>`
}
