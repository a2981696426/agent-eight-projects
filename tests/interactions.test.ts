import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  initArchitectureLinks,
  initEnhancements,
  initReadingProgress,
  initSectionTracker,
} from '../src/interactions'

afterEach(() => {
  vi.useRealTimers()
})

describe('progressive enhancements', () => {
  it('updates the document reading-progress property', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0)
      return 1
    })
    Object.defineProperties(document.documentElement, {
      scrollHeight: { value: 2000, configurable: true },
      clientHeight: { value: 1000, configurable: true },
    })
    Object.defineProperty(window, 'scrollY', { value: 500, configurable: true })

    const cleanup = initReadingProgress(document, window)
    window.dispatchEvent(new Event('scroll'))

    expect(document.documentElement.style.getPropertyValue('--reading-progress')).toBe('0.5')
    cleanup()
  })

  it('clamps reading progress and handles documents without scrollable overflow', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0)
      return 1
    })
    Object.defineProperties(document.documentElement, {
      scrollHeight: { value: 1000, configurable: true },
      clientHeight: { value: 1000, configurable: true },
    })
    Object.defineProperty(window, 'scrollY', { value: 300, configurable: true })

    const cleanup = initReadingProgress(document, window)

    expect(document.documentElement.style.getPropertyValue('--reading-progress')).toBe('0')
    cleanup()
  })

  it('updates progress synchronously when requestAnimationFrame is unavailable', () => {
    vi.stubGlobal('requestAnimationFrame', undefined)
    Object.defineProperties(document.documentElement, {
      scrollHeight: { value: 2000, configurable: true },
      clientHeight: { value: 1000, configurable: true },
    })
    Object.defineProperty(window, 'scrollY', { value: 250, configurable: true })

    const cleanup = initReadingProgress(document, window)

    expect(document.documentElement.style.getPropertyValue('--reading-progress')).toBe('0.25')
    cleanup()
  })

  it('focuses related project sections from a system-map anchor', () => {
    document.body.innerHTML = '<a href="#project-1" data-related-projects="1,3">Apps</a><section id="project-1" data-project-id="1"></section><section id="project-3" data-project-id="3"></section>'
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView

    const cleanup = initArchitectureLinks(document, window)
    document.querySelector<HTMLElement>('[data-related-projects]')?.click()

    expect(document.querySelector('[data-project-id="1"]')?.classList.contains('is-related')).toBe(true)
    expect(document.querySelector('[data-project-id="3"]')?.classList.contains('is-related')).toBe(true)
    expect(scrollIntoView).toHaveBeenCalledOnce()
    cleanup()
  })

  it('removes related project highlighting when cleaned up', () => {
    document.body.innerHTML = '<a href="#project-1" data-related-projects="1">Apps</a><section id="project-1" data-project-id="1"></section>'
    Element.prototype.scrollIntoView = vi.fn()

    const cleanup = initArchitectureLinks(document, window)
    document.querySelector<HTMLElement>('[data-related-projects]')?.click()
    cleanup()

    expect(document.querySelector('[data-project-id="1"]')?.classList.contains('is-related')).toBe(false)
  })

  it('uses declared project order for the stable architecture target and ignores malformed duplicate IDs', () => {
    document.body.innerHTML = '<a href="#project-3" data-related-projects="3,not-a-number,3,1">Apps</a><section id="project-1" data-project-id="1"></section><section id="project-3" data-project-id="3"></section>'
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    const originalHistoryLength = window.history.length
    window.history.replaceState(null, '', '#before')

    const cleanup = initArchitectureLinks(document, window)
    document.querySelector<HTMLElement>('[data-related-projects]')?.click()

    expect(scrollIntoView.mock.instances[0]).toBe(document.querySelector('#project-3'))
    expect(window.location.hash).toBe('#project-3')
    expect(window.history.length).toBe(originalHistoryLength)
    cleanup()
  })

  it('uses automatic scrolling when reduced motion is requested', () => {
    document.body.innerHTML = '<a href="#project-1" data-related-projects="1">Apps</a><section id="project-1" data-project-id="1"></section>'
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))

    const cleanup = initArchitectureLinks(document, window)
    document.querySelector<HTMLElement>('[data-related-projects]')?.click()

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' })
    cleanup()
  })

  it('removes related highlighting after its temporary timeout expires', () => {
    vi.useFakeTimers()
    document.body.innerHTML = '<a href="#project-1" data-related-projects="1">Apps</a><section id="project-1" data-project-id="1"></section>'
    Element.prototype.scrollIntoView = vi.fn()

    const cleanup = initArchitectureLinks(document, window)
    document.querySelector<HTMLElement>('[data-related-projects]')?.click()
    vi.advanceTimersByTime(1800)

    expect(document.querySelector('[data-project-id="1"]')?.classList.contains('is-related')).toBe(false)
    cleanup()
  })

  it('highlights and clears every duplicate project section for a referenced ID', () => {
    document.body.innerHTML = '<a href="#project-3" data-related-projects="3">Apps</a><section id="project-3" data-project-id="3"></section><section id="project-3-duplicate" data-project-id="3"></section>'
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView

    const cleanup = initArchitectureLinks(document, window)
    document.querySelector<HTMLElement>('[data-related-projects]')?.click()

    expect(document.querySelector('#project-3')?.classList.contains('is-related')).toBe(true)
    expect(document.querySelector('#project-3-duplicate')?.classList.contains('is-related')).toBe(true)
    expect(scrollIntoView.mock.instances[0]).toBe(document.querySelector('#project-3'))
    cleanup()
    expect(document.querySelector('#project-3')?.classList.contains('is-related')).toBe(false)
    expect(document.querySelector('#project-3-duplicate')?.classList.contains('is-related')).toBe(false)
  })

  it('marks the matching chapter link as the current location when a section intersects', () => {
    document.body.innerHTML = '<nav class="chapter-nav"><a href="#first">First</a><a href="#second">Second</a></nav><section id="first"></section><section id="second"></section>'
    let callback: IntersectionObserverCallback | undefined
    const observer = { observe: vi.fn(), disconnect: vi.fn() }

    const cleanup = initSectionTracker(document, (nextCallback) => {
      callback = nextCallback
      return observer
    })
    const second = document.querySelector<HTMLElement>('#second')
    callback?.([{ isIntersecting: true, target: second! } as unknown as IntersectionObserverEntry], observer as unknown as IntersectionObserver)

    expect(document.querySelector<HTMLAnchorElement>('a[href="#first"]')?.getAttribute('aria-current')).toBeNull()
    expect(document.querySelector<HTMLAnchorElement>('a[href="#second"]')?.getAttribute('aria-current')).toBe('location')
    cleanup()
    expect(observer.disconnect).toHaveBeenCalledOnce()
    expect(document.querySelector<HTMLAnchorElement>('a[href="#second"]')?.getAttribute('aria-current')).toBeNull()
  })

  it('leaves native chapter navigation intact when section observation is unavailable', () => {
    document.body.innerHTML = '<nav class="chapter-nav"><a href="#first">First</a></nav><section id="first"></section>'

    const cleanup = initSectionTracker(document)

    expect(document.querySelector('a')?.getAttribute('aria-current')).toBeNull()
    cleanup()
  })

  it('can initialize and clean up twice without duplicate effects', () => {
    const cleanupA = initEnhancements(document, window)
    cleanupA()
    const cleanupB = initEnhancements(document, window)

    expect(cleanupB).toBeTypeOf('function')
    cleanupB()
  })
})
