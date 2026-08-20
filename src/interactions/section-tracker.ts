type SectionObserver = Pick<IntersectionObserver, 'disconnect' | 'observe'>

export type SectionObserverFactory = (callback: IntersectionObserverCallback) => SectionObserver

function defaultObserverFactory(doc: Document): SectionObserverFactory | undefined {
  const Observer = doc.defaultView?.IntersectionObserver
  return Observer ? (callback) => new Observer(callback) : undefined
}

export function initSectionTracker(doc: Document, observerFactory = defaultObserverFactory(doc)): () => void {
  if (!observerFactory) return () => {}

  const linksById = new Map<string, HTMLAnchorElement>()
  for (const link of doc.querySelectorAll<HTMLAnchorElement>('.chapter-nav a[href^="#"]')) {
    const id = link.getAttribute('href')?.slice(1)
    if (id && doc.getElementById(id)) linksById.set(id, link)
  }

  if (linksById.size === 0) return () => {}

  const observer = observerFactory((entries) => {
    const intersectingEntry = entries.find((entry) => entry.isIntersecting)
    if (!intersectingEntry) return

    const activeLink = linksById.get(intersectingEntry.target.id)
    if (!activeLink) return

    for (const link of linksById.values()) link.removeAttribute('aria-current')
    activeLink.setAttribute('aria-current', 'location')
  })

  for (const id of linksById.keys()) {
    const target = doc.getElementById(id)
    if (target) observer.observe(target)
  }

  return () => {
    observer.disconnect()
    for (const link of linksById.values()) link.removeAttribute('aria-current')
  }
}
