import { initArchitectureLinks } from './architecture-links.js'
import { initReadingProgress } from './progress.js'
import { initSectionTracker } from './section-tracker.js'

export { initArchitectureLinks } from './architecture-links.js'
export { initReadingProgress } from './progress.js'
export { initSectionTracker } from './section-tracker.js'
export type { SectionObserverFactory } from './section-tracker.js'

export function initEnhancements(doc: Document = document, win: Window = window): () => void {
  const cleanups = [
    initReadingProgress(doc, win),
    initSectionTracker(doc),
    initArchitectureLinks(doc, win),
  ]

  return () => {
    for (const cleanup of cleanups.reverse()) cleanup()
  }
}
