import type { VersionsSet } from '../lib/lockfile.ts'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
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

describe('parseLockfile', () => {
  it('dispatches npm', () => {
    const npm = parseLockfile('package-lock.json', '{"packages":{}}')
    expect(npm instanceof Map).toBeTruthy()
  })
  it('parses npm', () => {
    expect(toSorted(parseNpmLock(packageLockJson))).toEqual({
      '@scope/name': ['2.3.4'],
      'lodash': ['4.17.21'],
    })
  })

  it('dispatches pnpm', () => {
    const pnpm = parseLockfile('pnpm-lock.yaml', `packages:\n`)
    expect(pnpm instanceof Map).toBeTruthy()
  })
  it('parses pnpm', () => {
    expect(toSorted(parsePnpmLock(pnpmLock))).toEqual({
      '@scope/name': ['2.3.4'],
      'lodash': ['4.17.21'],
    })
  })

  it('dispatches yarn v1', () => {
    const yarnV1 = parseLockfile('yarn.lock', `pkg@^1:\n  version "1.0.0"`)
    expect(yarnV1 instanceof Map).toBeTruthy()
  })
  it('parses yarn v1', () => {
    expect(toSorted(parseYarnV1Lock(yarnV1Lock))).toEqual({
      '@scope/name': ['2.3.4'],
      'lodash': ['4.17.21'],
    })
  })

  it('dispatches yarn berry', () => {
    const yarnBerry = parseLockfile('yarn.lock', `"pkg@npm:^1":\n  version: 1.0.0`)
    expect(yarnBerry instanceof Map).toBeTruthy()
  })
  it('parses yarn berry', () => {
    expect(toSorted(parseYarnBerryLock(yarnBerryLock))).toEqual({
      '@scope/name': ['2.3.4'],
      'lodash': ['4.17.21'],
    })
  })

  it('dispatches bun', () => {
    const bun = parseLockfile('bun.lock', `{"packages":[]}`)
    expect(bun instanceof Map).toBeTruthy()
  })
  it('parses bun', () => {
    expect(toSorted(parseBunLock(bunLock))).toEqual({
      '@scope/name': ['2.3.4'],
      'lodash': ['4.17.21'],
    })
  })
})

it('yarnV1SpecifierToName', () => {
  expect(yarnV1SpecifierToName('lodash@^4.17.21')).toBe('lodash')
  expect(yarnV1SpecifierToName('@scope/name@^1.0.0')).toBe('@scope/name')
  expect(yarnV1SpecifierToName('name@npm:^1.0.0')).toBe('name')
})

it('yarnBerrySpecifierToName', () => {
  expect(yarnBerrySpecifierToName('lodash@npm:^4.17.21')).toBe('lodash')
  expect(yarnBerrySpecifierToName('@scope/name@npm:^1.0.0')).toBe('@scope/name')
  expect(yarnBerrySpecifierToName('name@npm:^1.0.0')).toBe('name')
})

it('diffDependencySets', () => {
  const a: VersionsSet = new Map([['lodash', new Set(['4.17.21'])]])
  const b: VersionsSet = new Map([['lodash', new Set(['4.17.21', '4.17.22'])]])
  const diff = diffDependencySets(a, b)
  expect(diff.length).toBe(1)
  expect(diff[0].name).toBe('lodash')
})

describe('findLockfileLine', () => {
  it('finds in npm lockfile', () => {
    expect(
      findLockfileLine('package-lock.json', packageLockJson, 'lodash', '4.17.21'),
    ).toBeTruthy()
  })
  it('finds in pnpm lockfile', () => {
    expect(
      findLockfileLine('pnpm-lock.yaml', pnpmLock, 'lodash', '4.17.21'),
    ).toBeTruthy()
  })
  it('finds in yarn v1 lockfile', () => {
    expect(
      findLockfileLine('yarn.lock', yarnV1Lock, 'lodash', '4.17.21'),
    ).toBeTruthy()
  })
  it('finds in yarn berry lockfile', () => {
    expect(
      findLockfileLine('yarn.lock', yarnBerryLock, 'lodash', '4.17.21'),
    ).toBeTruthy()
  })
  it('finds in bun lockfile', () => {
    expect(
      findLockfileLine('bun.lock', bunLock, 'lodash', '4.17.21'),
    ).toBeTruthy()
  })

  it('pnpm tolerates peer suffix and quotes', () => {
    const pnpm = `packages:\n\n  "/name@1.0.0(peer@x)":\n    resolution: {integrity: sha512-...}\n`
    const line = findLockfileLine('pnpm-lock.yaml', pnpm, 'name', '1.0.0')
    expect(line).toBeGreaterThanOrEqual(1)
  })

  it('yarn v1 matches within multi-spec header', () => {
    const y1 = `# yarn lockfile v1\nname@^1.0.0, name@~1.0.0:\n  version "1.0.1"\n`
    const line = findLockfileLine('yarn.lock', y1, 'name', '1.0.1')
    expect(line).toBe(3)
  })

  it('yarn berry parses version in multiple formats', () => {
    const yb = `"name@npm:^1":\n  version: 1.2.3\n\n"name@npm:^2":\n  version: '2.3.4'\n\n"name@npm:^3":\n  version: 3.2.1 # comment\n`
    expect(findLockfileLine('yarn.lock', yb, 'name', '1.2.3')).toBe(2)
    expect(findLockfileLine('yarn.lock', yb, 'name', '2.3.4')).toBe(5)
    expect(findLockfileLine('yarn.lock', yb, 'name', '3.2.1')).toBe(8)
  })
})
