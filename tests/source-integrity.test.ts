/** @vitest-environment node */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SOURCE_ARTIFACT } from '../src/content/source-integrity'

describe('protected reconstruction draft', () => {
  it('retains the approved byte-level SHA-256', async () => {
    const bytes = await readFile(resolve(process.cwd(), SOURCE_ARTIFACT.fileName))
    const actual = createHash('sha256').update(bytes).digest('hex').toUpperCase()
    expect(actual).toBe(SOURCE_ARTIFACT.sha256)
  })
})
