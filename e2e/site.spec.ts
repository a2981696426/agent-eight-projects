import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { mkdir } from 'node:fs/promises'

type Rgb = readonly [number, number, number]

function parseRgb(color: string): Rgb {
  const channels = color.match(/[\d.]+/g)?.slice(0, 3).map(Number)
  if (!channels || channels.length !== 3 || channels.some(Number.isNaN)) {
    throw new Error(`Expected an RGB color, received ${color}`)
  }
  return channels as unknown as Rgb
}

function relativeLuminance([red, green, blue]: Rgb): number {
  const linear = [red, green, blue].map((channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return (0.2126 * linear[0]!) + (0.7152 * linear[1]!) + (0.0722 * linear[2]!)
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(parseRgb(foreground))
  const backgroundLuminance = relativeLuminance(parseRgb(background))
  const lighter = Math.max(foregroundLuminance, backgroundLuminance)
  const darker = Math.min(foregroundLuminance, backgroundLuminance)
  return (lighter + 0.05) / (darker + 0.05)
}

const contrastSamples = [
  { label: 'hero confirmed fact', foreground: '.hero__confirmed-fact > p', background: '.knowledge-page' },
  { label: 'audit note summary', foreground: '.audit-note summary', background: '.audit-note' },
  { label: 'project subtitle', foreground: '.project__subtitle', background: '.knowledge-page' },
  { label: 'evolution description', foreground: '.evolution p', background: '.knowledge-page' },
  { label: 'audit conclusion', foreground: '.audit-summary li', background: '.knowledge-page' },
] as const

const targetViewports = [
  { width: 1440, height: 1000 },
  { width: 768, height: 900 },
  { width: 390, height: 844 },
  { width: 320, height: 720 },
] as const

async function tabTo(page: import('@playwright/test').Page, selector: string, limit = 80): Promise<void> {
  for (let index = 0; index < limit; index += 1) {
    await page.keyboard.press('Tab')
    if (await page.locator(selector).first().evaluate((target) => target === document.activeElement)) return
  }
  throw new Error(`Keyboard Tab did not reach ${selector} within ${limit} presses.`)
}

test('keeps the complete learning path and anchors when JavaScript is disabled', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false })
  const page = await context.newPage()
  await page.goto('http://127.0.0.1:4173/')

  await expect(page.locator('section[data-project-id]')).toHaveCount(8)
  await expect(page.locator('#interview-script')).toContainText('90 秒')
  await expect(page.locator('#sources')).toContainText('原页面已删除')

  const unresolvedAnchors = await page.locator('a[href^="#"]').evaluateAll((links) => links
    .map((link) => link.getAttribute('href'))
    .filter((href): href is string => Boolean(href))
    .filter((href) => !document.getElementById(decodeURIComponent(href.slice(1)))))
  expect(unresolvedAnchors).toEqual([])

  const architectureLink = page.locator('a[data-architecture-layer]').first()
  await architectureLink.focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/#project-/)
  await context.close()
})

test('makes no runtime requests to external origins', async ({ page }) => {
  const external: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.origin !== 'http://127.0.0.1:4173') external.push(request.url())
  })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  expect(external).toEqual([])
})

test('has no serious or critical accessibility violations', async ({ page }) => {
  await page.goto('/')
  const results = await new AxeBuilder({ page }).analyze()
  const blocking = results.violations.filter((item) => item.impact === 'serious' || item.impact === 'critical')
  expect(blocking).toEqual([])
})

test('has semantic landmarks, named architecture links, source statuses, and a footer', async ({ page }) => {
  await page.goto('/')

  await expect(page.locator('main')).toHaveCount(1)
  await expect(page.locator('h1')).toHaveCount(1)
  await expect(page.getByRole('navigation', { name: '文章章节' })).toBeVisible()
  await expect(page.locator('a[data-architecture-layer]')).toHaveCount(5)
  for (const link of await page.locator('a[data-architecture-layer]').all()) {
    await expect(link).toHaveAccessibleName(/\S/)
  }
  await expect(page.locator('#sources')).toContainText('原页面已删除')
  await expect(page.locator('#sources a[href^="https://"]')).not.toHaveCount(0)
  await expect(page.locator('.capability-connection a[data-related-projects="8"]')).toHaveAttribute('href', '#project-8-mcp-governance')
  await expect(page.locator('.governance-rail a[data-related-projects="8"]')).toHaveAttribute('href', '#project-8-mcp-governance')
  await expect(page.locator('[data-project-id="8"] [data-system-position]')).toHaveAttribute('data-primary-positions', 'capability-connection,runtime-governance')
  await expect(page.locator('[data-project-id="8"] [data-primary-position-list]')).not.toContainText('AI 应用与工作流')
  await expect(page.locator('footer')).toBeVisible()
})

test('confirmed hero fact keeps its sources in a visible audit treatment', async ({ page }) => {
  await page.goto('/')
  const fact = page.locator('[data-hero-confirmed-fact]')

  await expect(fact).toContainText('已确认')
  await expect(fact).toContainText('编程导航 / Codefather')
  await expect(fact).toContainText('鱼皮 AI 导航')
  await expect(fact).toHaveCSS('border-left-width', '4px')
})

test('keyboard Tab and activation operate architecture links and audit details', async ({ page }) => {
  await page.goto('/')

  const architectureSelector = 'a[data-architecture-layer="business-entry"]'
  await tabTo(page, architectureSelector)
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/#project-/)
  await expect(page.locator('section[data-project-id].is-related')).not.toHaveCount(0)

  await page.goto('/')
  const detailsSelector = 'details.audit-note summary'
  await tabTo(page, detailsSelector)
  await page.keyboard.press('Space')
  await expect(page.locator('details.audit-note').first()).toHaveAttribute('open', '')
})

test('loads without console or page errors', async ({ page }) => {
  const errors: string[] = []
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await page.locator('footer').scrollIntoViewIfNeeded()
  expect(errors).toEqual([])
})

test('captures approved verification screenshots', async ({ page }) => {
  await mkdir('artifacts/visual', { recursive: true })
  const shots = [
    { name: 'desktop-light', width: 1440, height: 1000, colorScheme: 'light' as const },
    { name: 'tablet-light', width: 768, height: 900, colorScheme: 'light' as const },
    { name: 'mobile-light', width: 390, height: 844, colorScheme: 'light' as const },
    { name: 'narrow-light', width: 320, height: 720, colorScheme: 'light' as const },
    { name: 'desktop-dark', width: 1440, height: 1000, colorScheme: 'dark' as const },
  ]

  for (const shot of shots) {
    await page.setViewportSize({ width: shot.width, height: shot.height })
    await page.emulateMedia({ colorScheme: shot.colorScheme, reducedMotion: 'reduce' })
    await page.goto('/')
    await page.screenshot({
      path: `artifacts/visual/${shot.name}.png`,
      fullPage: true,
      animations: 'disabled',
    })
  }
})

for (const viewport of targetViewports) {
  test(`technical archive fits ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.goto('/')

    await expect(page.locator('h1')).toBeVisible()
    const overflow = await page.evaluate(() => (
      document.documentElement.scrollWidth - document.documentElement.clientWidth
    ))
    expect(overflow).toBeLessThanOrEqual(1)
    await expect(page.locator('.knowledge-page')).toHaveCSS('background-color', 'rgb(243, 239, 227)')
  })
}

test('system dark mode uses the dark archive palette', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/')

  await expect(page.locator('.knowledge-page')).toHaveCSS('background-color', 'rgb(21, 26, 23)')
})

test('mobile architecture becomes a readable vertical sequence', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')

  await expect(page.locator('.system-map > ol')).toHaveCSS('grid-template-columns', '342px')
})

test('keyboard focus is visibly distinct', async ({ page }) => {
  await page.goto('/')
  await page.locator('.chapter-nav a').first().focus()

  const outlineWidth = await page.locator('.chapter-nav a').first().evaluate((link) => (
    Number.parseFloat(getComputedStyle(link).outlineWidth)
  ))
  expect(outlineWidth).toBeGreaterThanOrEqual(3)
})

test('reduced motion removes smooth scrolling and transitions', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('html')).toHaveCSS('scroll-behavior', 'smooth')
  await expect(page.locator('.project').first()).not.toHaveCSS('transition-duration', '0s')

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.reload()

  await expect(page.locator('html')).toHaveCSS('scroll-behavior', 'auto')
  await expect(page.locator('.project').first()).toHaveCSS('transition-duration', '0s')
})

for (const width of [390, 320]) {
  test(`mobile readable type stays at least 14px at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await page.goto('/')

    const offenders = await page.evaluate(() => {
      const found = new Map<string, { target: string; fontSize: number }>()
      const labelFor = (element: Element): string => {
        const id = element.id ? `#${element.id}` : ''
        const classes = [...element.classList].map((name) => `.${name}`).join('')
        return `${element.tagName.toLowerCase()}${id}${classes}`
      }
      const record = (target: string, fontSize: string): void => {
        const value = Number.parseFloat(fontSize)
        if (value < 14) found.set(`${target}:${value}`, { target, fontSize: value })
      }

      for (const element of document.body.querySelectorAll('*')) {
        if (element.getClientRects().length === 0) continue
        const style = getComputedStyle(element)
        if (style.visibility === 'hidden' || style.display === 'none') continue

        const hasDirectText = [...element.childNodes].some((node) => (
          node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim())
        ))
        if (hasDirectText) record(labelFor(element), style.fontSize)

        for (const pseudo of ['::before', '::after'] as const) {
          const pseudoStyle = getComputedStyle(element, pseudo)
          const content = pseudoStyle.content
          if (content !== 'none' && content !== 'normal' && content !== '""') {
            record(`${labelFor(element)}${pseudo}`, pseudoStyle.fontSize)
          }
        }
      }

      return [...found.values()]
    })

    expect(offenders, JSON.stringify(offenders.slice(0, 20))).toEqual([])
    const overflow = await page.evaluate(() => (
      document.documentElement.scrollWidth - document.documentElement.clientWidth
    ))
    expect(overflow).toBeLessThanOrEqual(1)
  })
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`${colorScheme} normal text meets 4.5 to 1 contrast`, async ({ page }) => {
    await page.emulateMedia({ colorScheme })
    await page.goto('/')

    for (const sample of contrastSamples) {
      const colors = await page.evaluate(({ foreground, background }) => ({
        foreground: getComputedStyle(document.querySelector(foreground)!).color,
        background: getComputedStyle(document.querySelector(background)!).backgroundColor,
      }), sample)
      expect(
        contrastRatio(colors.foreground, colors.background),
        `${sample.label}: ${colors.foreground} on ${colors.background}`,
      ).toBeGreaterThanOrEqual(4.5)
    }
  })
}
