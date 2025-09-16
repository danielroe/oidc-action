import type { VersionsSet } from '../lib/lockfile.ts'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { diffDependencySets, findLockfileLine, parseBunLock, parseLockfile, parseNpmLock, parsePnpmLock, parseYarnBerryLock, parseYarnV1Lock, yarnBerrySpecifierToName, yarnV1SpecifierToName } from '../lib/lockfile.ts'

function toSorted(obj: VersionsSet): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [k, v] of obj) out[k] = Array.from(v).sort()
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)))
}

const packageLockJson = readFileSync(new URL('./fixtures/npm/package-lock.json', import.meta.url), 'utf8')
const pnpmLock = readFileSync(new URL('./fixtures/pnpm/pnpm-lock.yaml', import.meta.url), 'utf8')
const yarnV1Lock = readFileSync(new URL('./fixtures/yarn-v1/yarn.lock', import.meta.url), 'utf8')
const yarnBerryLock = readFileSync(new URL('./fixtures/yarn-berry/yarn.lock', import.meta.url), 'utf8')
const bunLock = readFileSync(new URL('./fixtures/bun/bun.lock', import.meta.url), 'utf8')

test('parseLockfile', async (t) => {
  await t.test('dispatches npm', () => {
    const npm = parseLockfile('package-lock.json', '{"packages":{}}')
    assert.ok(npm instanceof Map)
  })
  assert.deepEqual(toSorted(parseNpmLock(packageLockJson)), {
    '@scope/name': ['2.3.4'],
    'lodash': ['4.17.21'],
  })

  await t.test('dispatches pnpm', () => {
    const pnpm = parseLockfile('pnpm-lock.yaml', `packages:\n`)
    assert.ok(pnpm instanceof Map)
  })
  assert.deepEqual(toSorted(parsePnpmLock(pnpmLock)), {
    '@scope/name': ['2.3.4'],
    'lodash': ['4.17.21'],
  })

  await t.test('dispatches yarn v1', () => {
    const yarnV1 = parseLockfile('yarn.lock', `pkg@^1:\n  version "1.0.0"`)
    assert.ok(yarnV1 instanceof Map)
  })
  assert.deepEqual(toSorted(parseYarnV1Lock(yarnV1Lock)), {
    '@scope/name': ['2.3.4'],
    'lodash': ['4.17.21'],
  })

  await t.test('dispatches yarn berry', () => {
    const yarnBerry = parseLockfile('yarn.lock', `"pkg@npm:^1":\n  version: 1.0.0`)
    assert.ok(yarnBerry instanceof Map)
  })
  assert.deepEqual(toSorted(parseYarnBerryLock(yarnBerryLock)), {
    '@scope/name': ['2.3.4'],
    'lodash': ['4.17.21'],
  })

  await t.test('dispatches bun', () => {
    const bun = parseLockfile('bun.lock', `{"packages":[]}`)
    assert.ok(bun instanceof Map)
  })
  assert.deepEqual(toSorted(parseBunLock(bunLock)), {
    '@scope/name': ['2.3.4'],
    'lodash': ['4.17.21'],
  })
})

test('yarnV1SpecifierToName', () => {
  assert.equal(yarnV1SpecifierToName('lodash@^4.17.21'), 'lodash')
  assert.equal(yarnV1SpecifierToName('@scope/name@^1.0.0'), '@scope/name')
  assert.equal(yarnV1SpecifierToName('name@npm:^1.0.0'), 'name')
})

test('yarnBerrySpecifierToName', () => {
  assert.equal(yarnBerrySpecifierToName('lodash@npm:^4.17.21'), 'lodash')
  assert.equal(yarnBerrySpecifierToName('@scope/name@npm:^1.0.0'), '@scope/name')
  assert.equal(yarnBerrySpecifierToName('name@npm:^1.0.0'), 'name')
})

test('diffDependencySets', () => {
  const a: VersionsSet = new Map([['lodash', new Set(['4.17.21'])]])
  const b: VersionsSet = new Map([['lodash', new Set(['4.17.21', '4.17.22'])]])
  const diff = diffDependencySets(a, b)
  assert.equal(diff.length, 1)
  assert.equal(diff[0].name, 'lodash')
})

test('findLockfileLine', async (t) => {
  await t.test('finds in npm lockfile', () => {
    assert.ok(
      findLockfileLine('package-lock.json', packageLockJson, 'lodash', '4.17.21'),
    )
  })
  await t.test('finds in pnpm lockfile', () => {
    assert.ok(
      findLockfileLine('pnpm-lock.yaml', pnpmLock, 'lodash', '4.17.21'),
    )
  })
  await t.test('finds in yarn v1 lockfile', () => {
    assert.ok(
      findLockfileLine('yarn.lock', yarnV1Lock, 'lodash', '4.17.21'),
    )
  })
  await t.test('finds in yarn berry lockfile', () => {
    assert.ok(
      findLockfileLine('yarn.lock', yarnBerryLock, 'lodash', '4.17.21'),
    )
  })
  await t.test('finds in bun lockfile', () => {
    assert.ok(
      findLockfileLine('bun.lock', bunLock, 'lodash', '4.17.21'),
    )
  })

  await t.test('pnpm tolerates peer suffix and quotes', () => {
    const pnpm = `packages:\n\n  "/name@1.0.0(peer@x)":\n    resolution: {integrity: sha512-...}\n`
    const line = findLockfileLine('pnpm-lock.yaml', pnpm, 'name', '1.0.0')
    assert.ok(line && line >= 1)
  })

  await t.test('yarn v1 matches within multi-spec header', () => {
    const y1 = `# yarn lockfile v1\nname@^1.0.0, name@~1.0.0:\n  version "1.0.1"\n`
    const line = findLockfileLine('yarn.lock', y1, 'name', '1.0.1')
    assert.equal(line, 3)
  })

  await t.test('yarn berry parses version in multiple formats', () => {
    const yb = `"name@npm:^1":\n  version: 1.2.3\n\n"name@npm:^2":\n  version: '2.3.4'\n\n"name@npm:^3":\n  version: 3.2.1 # comment\n`
    assert.equal(findLockfileLine('yarn.lock', yb, 'name', '1.2.3'), 2)
    assert.equal(findLockfileLine('yarn.lock', yb, 'name', '2.3.4'), 5)
    assert.equal(findLockfileLine('yarn.lock', yb, 'name', '3.2.1'), 8)
  })
})
