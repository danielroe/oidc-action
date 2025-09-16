import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseLockfile, parseNpmLock, parsePnpmLock, parseYarnLockV1, yarnSpecifierToName, diffDependencySets, type VersionsSet } from '../lib/index.ts'

function toSorted(obj: VersionsSet): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [k, v] of obj) out[k] = Array.from(v).sort()
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)))
}

test('parse npm package-lock.json', () => {
  const content = JSON.stringify({
    name: 'example',
    lockfileVersion: 3,
    packages: {
      '': { name: 'example', version: '1.0.0' },
      'node_modules/lodash': { version: '4.17.21' },
      'node_modules/@scope/name': { version: '2.3.4' },
    },
  })
  const res = parseNpmLock(content)
  assert.deepEqual(toSorted(res), {
    '@scope/name': ['2.3.4'],
    'lodash': ['4.17.21'],
  })
})

test('parse pnpm pnpm-lock.yaml minimal', () => {
  const content = [
    'lockfileVersion: 9.0',
    'packages:',
    '  /lodash@4.17.21:',
    '    resolution: {integrity: sha512-...}',
    '  /@scope/name@2.3.4(peer@1):',
    '    resolution: {integrity: sha512-...}',
  ].join('\n')
  const res = parsePnpmLock(content)
  assert.deepEqual(toSorted(res), {
    '@scope/name': ['2.3.4'],
    'lodash': ['4.17.21'],
  })
})

test('parse yarn v1 yarn.lock minimal', () => {
  const content = [
    'lodash@^4.17.21:',
    '  version "4.17.21"',
    '  resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.21.tgz"',
    '',
    '"@scope/name@^2.3.4":',
    '  version "2.3.4"',
  ].join('\n')
  const res = parseYarnLockV1(content)
  assert.deepEqual(toSorted(res), {
    '@scope/name': ['2.3.4'],
    'lodash': ['4.17.21'],
  })
})

test('parseLockfile dispatch', () => {
  const npm = parseLockfile('package-lock.json', '{"packages":{}}')
  const pnpm = parseLockfile('pnpm-lock.yaml', 'packages:\n')
  const yarn = parseLockfile('yarn.lock', 'pkg@^1:\n  version "1.0.0"')
  assert.ok(npm instanceof Map && pnpm instanceof Map && yarn instanceof Map)
})

test('yarn specifier to name', () => {
  assert.equal(yarnSpecifierToName('lodash@^4.17.21'), 'lodash')
  assert.equal(yarnSpecifierToName('@scope/name@^1.0.0'), '@scope/name')
  assert.equal(yarnSpecifierToName('name@npm:^1.0.0'), 'name')
})

test('diffDependencySets identifies changes', () => {
  const a: VersionsSet = new Map([['lodash', new Set(['4.17.21'])]])
  const b: VersionsSet = new Map([['lodash', new Set(['4.17.21', '4.17.22'])]])
  const diff = diffDependencySets(a, b)
  assert.equal(diff.length, 1)
  assert.equal(diff[0].name, 'lodash')
})


