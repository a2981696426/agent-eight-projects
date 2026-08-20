function relatedProjectIds(value: string | null): number[] {
  if (!value) return []

  return [...new Set(value.split(',')
    .map((id) => Number(id.trim()))
    .filter((id) => Number.isSafeInteger(id) && id > 0))]
}

export function initArchitectureLinks(doc: Document, win: Window): () => void {
  let highlightTimeout: number | undefined
  let highlighted: HTMLElement[] = []

  const clearHighlights = (): void => {
    for (const section of highlighted) section.classList.remove('is-related')
    highlighted = []
    if (highlightTimeout !== undefined) win.clearTimeout(highlightTimeout)
    highlightTimeout = undefined
  }

  const activate = (event: Event): void => {
    const link = event.currentTarget
    if (!(link instanceof HTMLAnchorElement)) return

    const ids = relatedProjectIds(link.getAttribute('data-related-projects'))
    if (ids.length === 0) return

    clearHighlights()
    const sectionsByProjectId = new Map<number, HTMLElement[]>()
    for (const section of doc.querySelectorAll<HTMLElement>('[data-project-id]')) {
      const projectId = Number(section.dataset.projectId)
      const sections = sectionsByProjectId.get(projectId) ?? []
      sections.push(section)
      sectionsByProjectId.set(projectId, sections)
    }
    highlighted = ids.flatMap((id) => sectionsByProjectId.get(id) ?? [])

    for (const section of highlighted) section.classList.add('is-related')
    const firstTarget = highlighted[0]
    if (!firstTarget) return

    const reducedMotion = typeof win.matchMedia === 'function'
      && win.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (typeof firstTarget.scrollIntoView === 'function') {
      firstTarget.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' })
    }
    if (firstTarget.id) {
      try {
        win.history.replaceState(null, '', `#${firstTarget.id}`)
      } catch {
        // A static anchor still provides usable navigation when history replacement is unavailable.
      }
    }

    highlightTimeout = win.setTimeout(clearHighlights, 1800)
  }

  const links = [...doc.querySelectorAll<HTMLAnchorElement>('a[data-related-projects]')]
  for (const link of links) link.addEventListener('click', activate)

  return () => {
    for (const link of links) link.removeEventListener('click', activate)
    clearHighlights()
  }
}
