import type { EvidenceLevel } from '../types.ts'

const evidenceLabels: Record<EvidenceLevel, string> = {
  confirmed: '已确认',
  inferred: '合理推断',
  editorial: '编辑补全',
}

export function renderEvidence(level: EvidenceLevel): string {
  return `<span class="evidence evidence--${level}" data-evidence="${level}">${evidenceLabels[level]}</span>`
}
