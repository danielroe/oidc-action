import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { extractRepoAndRef, normalizeRefToBranch, normalizeRepository, parseRepoRefFromUri } from '../lib/provenance.ts'

test('normalizeRepository handles owner/repo and URLs', () => {
  assert.equal(normalizeRepository('owner/repo'), 'owner/repo')
  assert.equal(normalizeRepository('https://github.com/owner/repo'), 'owner/repo')
  assert.equal(normalizeRepository('git+https://github.com/owner/repo.git'), 'owner/repo')
})

test('parseRepoRefFromUri extracts repository and ref', () => {
  const p = parseRepoRefFromUri('git+https://github.com/owner/repo@refs/heads/main')
  assert.ok(p)
  assert.equal(p?.repository, 'owner/repo')
  assert.equal(p?.ref, 'refs/heads/main')
})

test('normalizeRefToBranch extracts branch from refs/heads', () => {
  assert.equal(normalizeRefToBranch('refs/heads/main'), 'main')
  assert.equal(normalizeRefToBranch('refs/tags/v1.0.0'), undefined)
  assert.equal(normalizeRefToBranch(undefined), undefined)
})

test('extractRepoAndRef reads from workflow, configSource and dependencies', () => {
  // workflow fields
  const att1 = { predicate: { buildDefinition: { externalParameters: { workflow: { repository: 'owner/repo', ref: 'refs/heads/dev' } } } } }
  const r1 = extractRepoAndRef(att1)
  assert.equal(r1.repository, 'owner/repo')
  assert.equal(r1.ref, 'refs/heads/dev')

  // configSource.uri
  const att2 = { predicate: { invocation: { configSource: { uri: 'git+https://github.com/me/proj@refs/heads/feat' } } } }
  const r2 = extractRepoAndRef(att2)
  assert.equal(r2.repository, 'me/proj')
  assert.equal(r2.ref, 'refs/heads/feat')

  // resolvedDependencies uri fallback
  const att3 = { predicate: { buildDefinition: { resolvedDependencies: [{ uri: 'https://github.com/acme/pkg.git' }] } } }
  const r3 = extractRepoAndRef(att3)
  assert.equal(r3.repository, 'acme/pkg')
  assert.equal(r3.ref, undefined)
})
