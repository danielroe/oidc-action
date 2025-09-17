import { describe, expect, it } from 'vitest'
import { extractRepoAndRef, normalizeRefToBranch, normalizeRepository, parseRepoRefFromUri } from '../lib/provenance.ts'

describe('provenance utils', () => {
  it('normalizeRepository handles owner/repo and URLs', () => {
    expect(normalizeRepository('owner/repo')).toBe('owner/repo')
    expect(normalizeRepository('https://github.com/owner/repo')).toBe('owner/repo')
    expect(normalizeRepository('git+https://github.com/owner/repo.git')).toBe('owner/repo')
  })

  it('parseRepoRefFromUri extracts repository and ref', () => {
    const p = parseRepoRefFromUri('git+https://github.com/owner/repo@refs/heads/main')
    expect(p).toBeTruthy()
    expect(p?.repository).toBe('owner/repo')
    expect(p?.ref).toBe('refs/heads/main')
  })

  it('normalizeRefToBranch extracts branch from refs/heads', () => {
    expect(normalizeRefToBranch('refs/heads/main')).toBe('main')
    expect(normalizeRefToBranch('refs/tags/v1.0.0')).toBe(undefined)
    expect(normalizeRefToBranch(undefined)).toBe(undefined)
  })

  it('extractRepoAndRef reads from workflow, configSource and dependencies', () => {
    // workflow fields
    const att1 = { predicate: { buildDefinition: { externalParameters: { workflow: { repository: 'owner/repo', ref: 'refs/heads/dev' } } } } }
    const r1 = extractRepoAndRef(att1)
    expect(r1.repository).toBe('owner/repo')
    expect(r1.ref).toBe('refs/heads/dev')

    // configSource.uri
    const att2 = { predicate: { invocation: { configSource: { uri: 'git+https://github.com/me/proj@refs/heads/feat' } } } }
    const r2 = extractRepoAndRef(att2)
    expect(r2.repository).toBe('me/proj')
    expect(r2.ref).toBe('refs/heads/feat')

    // resolvedDependencies uri fallback
    const att3 = { predicate: { buildDefinition: { resolvedDependencies: [{ uri: 'https://github.com/acme/pkg.git' }] } } }
    const r3 = extractRepoAndRef(att3)
    expect(r3.repository).toBe('acme/pkg')
    expect(r3.ref).toBe(undefined)
  })
})
