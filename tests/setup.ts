import { afterEach, vi } from 'vitest'

const scrollIntoViewDescriptor = typeof Element === 'undefined'
  ? undefined
  : Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')

afterEach(() => {
  if (typeof document !== 'undefined') {
    document.body.innerHTML = ''
    document.documentElement.removeAttribute('style')
    window.history.replaceState(null, '', '/')
  }
  if (typeof Element !== 'undefined') {
    if (scrollIntoViewDescriptor) Object.defineProperty(Element.prototype, 'scrollIntoView', scrollIntoViewDescriptor)
    else Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
  }
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.clearAllTimers()
})
