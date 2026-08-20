import type { SiteContent } from '../types.ts'
import { projects } from './projects.ts'
import { architecture, evolution, hero } from './site-copy.ts'
import { sources } from './sources.ts'

export { projects, sources }

export const siteContent: SiteContent = Object.freeze({
  hero,
  architecture,
  evolution,
  projects,
  sources,
})
