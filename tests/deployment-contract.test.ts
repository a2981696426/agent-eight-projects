/** @vitest-environment node */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { build } from 'vite'
import { parse } from 'yaml'

type WorkflowStep = {
  run?: string
  uses?: string
  with?: Record<string, unknown>
}

type WorkflowJob = {
  environment?: string | { name?: string; url?: string }
  if?: string
  needs?: string | string[]
  permissions?: Record<string, string>
  steps?: WorkflowStep[]
}

type Workflow = {
  on?: Record<string, unknown>
  permissions?: Record<string, string>
  jobs?: Record<string, WorkflowJob>
}

function isIgnored(path: string): boolean {
  const result = spawnSync('git', ['check-ignore', '--quiet', '--', path], {
    cwd: process.cwd(),
    shell: false,
  })

  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`git check-ignore failed with exit code ${result.status ?? 'unknown'}`)
  }

  return result.status === 0
}

function readPagesWorkflow(): Workflow | null {
  const path = resolve(process.cwd(), '.github/workflows/pages.yml')
  return existsSync(path) ? (parse(readFileSync(path, 'utf8')) as Workflow) : null
}

function jobSteps(job: WorkflowJob | undefined): WorkflowStep[] {
  return job?.steps ?? []
}

describe('public repository boundary', () => {
  it('keeps local-only material private while retaining approved visual evidence', () => {
    const privatePaths = [
      'CONTEXT.md',
      'docs/adr/0003-publish-from-a-public-github-repository.md',
      '.superpowers/sdd/review.diff',
      '.firecrawl/search-agent-eight-projects.json',
      '.env',
      'dist/index.html',
      'coverage/index.html',
      'test-results/results.json',
      'playwright-report/index.html',
      'node_modules/unpublished-package/package.json',
    ]
    const publicPaths = [
      '《Agent 面试必备的 8 个项目》内容还原稿.md',
      'artifacts/visual/desktop-dark.png',
      'artifacts/visual/desktop-light.png',
      'artifacts/visual/mobile-light.png',
      'artifacts/visual/narrow-light.png',
      'artifacts/visual/tablet-light.png',
    ]

    expect(privatePaths.every(isIgnored)).toBe(true)
    expect(publicPaths.every((path) => !isIgnored(path))).toBe(true)
  })

  it('disables Git text normalization for the byte-protected source', () => {
    const fileName = '《Agent 面试必备的 8 个项目》内容还原稿.md'
    const result = spawnSync('git', ['-c', 'core.quotePath=false', 'check-attr', 'text', '--', fileName], {
      cwd: process.cwd(),
      encoding: 'utf8',
      shell: false,
    })

    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe(`${fileName}: text: unset`)
  })
})

describe('GitHub Pages delivery contract', () => {
  it('verifies pull requests and main revisions with read-only repository access', () => {
    const workflow = readPagesWorkflow()

    expect(workflow).not.toBeNull()
    expect(workflow?.on).toMatchObject({
      pull_request: {},
      push: { branches: ['main'] },
      workflow_dispatch: {},
    })
    expect(workflow?.permissions).toEqual({ contents: 'read' })
    expect(jobSteps(workflow?.jobs?.verify).some((step) => step.run === 'pnpm verify')).toBe(true)
    expect(workflow?.jobs?.verify?.permissions).toBeUndefined()
  })

  it('packages only dist after verification and never on pull requests', () => {
    const workflow = readPagesWorkflow()
    const packageJob = workflow?.jobs?.package
    const upload = jobSteps(packageJob).find((step) => step.uses?.startsWith('actions/upload-pages-artifact@'))

    expect(packageJob?.needs).toBe('verify')
    expect(packageJob?.if).toContain("github.event_name != 'pull_request'")
    expect(packageJob?.if).toContain("github.ref == 'refs/heads/main'")
    expect(packageJob?.permissions).toEqual({ contents: 'read', pages: 'write' })
    expect(upload?.with?.path).toBe('./dist')
  })

  it('deploys the verified artifact through the github-pages environment with OIDC', () => {
    const workflow = readPagesWorkflow()
    const deployJob = workflow?.jobs?.deploy

    expect(deployJob?.needs).toBe('package')
    expect(deployJob?.if).toContain("github.event_name != 'pull_request'")
    expect(deployJob?.if).toContain("github.ref == 'refs/heads/main'")
    expect(deployJob?.permissions).toEqual({ pages: 'write', 'id-token': 'write' })
    expect(deployJob?.environment).toMatchObject({ name: 'github-pages' })
    expect(jobSteps(deployJob).some((step) => step.uses?.startsWith('actions/deploy-pages@'))).toBe(true)
  })

  it('pins every third-party action to an immutable commit', () => {
    const workflow = readPagesWorkflow()
    const actionRefs = Object.values(workflow?.jobs ?? {}).flatMap((job) =>
      jobSteps(job).flatMap((step) => (step.uses ? [step.uses] : [])),
    )

    expect(actionRefs.length).toBeGreaterThan(0)
    expect(actionRefs.every((reference) => /@[0-9a-f]{40}$/.test(reference))).toBe(true)
    expect(new Set(actionRefs)).toEqual(
      new Set([
        'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
        'pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86',
        'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
        'actions/configure-pages@45bfe0192ca1faeb007ade9deae92b16b8254a0d',
        'actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9',
        'actions/deploy-pages@cd2ce8fcbc39b97be8ca5fce6e763baed58fa128',
      ]),
    )
  })
})

describe('project-site production output', () => {
  it('keeps every emitted local asset beneath the project path', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'agent-eight-projects-pages-'))
    const siteUrl = new URL('https://a2981696426.github.io/agent-eight-projects/')

    try {
      await build({
        configFile: resolve(process.cwd(), 'vite.config.ts'),
        build: { outDir: outputDirectory, emptyOutDir: true },
        logLevel: 'silent',
      })

      const html = await readFile(join(outputDirectory, 'index.html'), 'utf8')
      const references = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
        .map((match) => match[1])
        .filter((reference): reference is string =>
          Boolean(reference && (reference.startsWith('./') || reference.startsWith('/'))),
        )

      expect(references.length).toBeGreaterThan(0)

      for (const reference of references) {
        const url = new URL(reference, siteUrl)
        expect(url.origin).toBe(siteUrl.origin)
        expect(url.pathname.startsWith(siteUrl.pathname)).toBe(true)

        const outputPath = resolve(outputDirectory, relative(siteUrl.pathname, url.pathname))
        expect(outputPath.startsWith(outputDirectory)).toBe(true)
        await expect(stat(outputPath)).resolves.toMatchObject({ size: expect.any(Number) })
      }
    } finally {
      await rm(outputDirectory, { recursive: true, force: true })
    }
  })
})
