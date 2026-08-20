function clampProgress(value: number): number {
  return Math.min(1, Math.max(0, value))
}

export function initReadingProgress(doc: Document, win: Window): () => void {
  let frame: number | undefined

  const update = (): void => {
    frame = undefined
    const root = doc.documentElement
    const scrollableHeight = root.scrollHeight - root.clientHeight
    const progress = scrollableHeight > 0 ? clampProgress(win.scrollY / scrollableHeight) : 0
    root.style.setProperty('--reading-progress', String(progress))
  }

  const scheduleUpdate = (): void => {
    if (frame !== undefined) return

    if (typeof win.requestAnimationFrame === 'function') {
      frame = win.requestAnimationFrame(update)
      return
    }

    update()
  }

  win.addEventListener('scroll', scheduleUpdate, { passive: true })
  win.addEventListener('resize', scheduleUpdate)
  scheduleUpdate()

  return () => {
    win.removeEventListener('scroll', scheduleUpdate)
    win.removeEventListener('resize', scheduleUpdate)
    if (frame !== undefined && typeof win.cancelAnimationFrame === 'function') {
      win.cancelAnimationFrame(frame)
    }
    frame = undefined
  }
}
