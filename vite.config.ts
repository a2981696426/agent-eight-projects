import { defineConfig, defaultExclude } from 'vitest/config'
import { siteContent } from './src/content/index.ts'
import { renderPage } from './src/render/page.ts'

const staticContentPlugin = {
  name: 'static-content-injection',
  transformIndexHtml(html: string): string {
    const marker = '<!--app-content-->'
    if (!html.includes(marker)) {
      throw new Error('Static content injection marker <!--app-content--> is missing from index.html.')
    }
    return html.replace(marker, renderPage(siteContent))
  },
}

export default defineConfig({
  base: './',
  build: { outDir: 'dist', emptyOutDir: true },
  plugins: [staticContentPlugin],
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    exclude: [...defaultExclude, '.superpowers/**', 'e2e/**'],
    coverage: { provider: 'v8', reporter: ['text', 'html'] },
  },
})
