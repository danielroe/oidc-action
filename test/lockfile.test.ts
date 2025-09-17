import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  detectLockfile,
  diffDependencySets,
  findLockfileLine,
  parseBunLock,
  parseLockfile,
  parseNpmLock,
  parsePnpmLock,
  parseYarnBerryLock,
  parseYarnV1Lock,
  readTextFile,
  yarnBerrySpecifierToName,
  yarnV1SpecifierToName,
} from '../lib/lockfile.ts'

test('detectLockfile finds supported lockfiles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oidc-action-'))
  try {
    // No file
    assert.equal(detectLockfile(dir), undefined)
    // Create pnpm first
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '')
    assert.equal(detectLockfile(dir), 'pnpm-lock.yaml')
    // If pnpm exists, it should still prefer that even if others are present
    writeFileSync(join(dir, 'package-lock.json'), '{}')
    writeFileSync(join(dir, 'yarn.lock'), '')
    assert.equal(detectLockfile(dir), 'pnpm-lock.yaml')
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readTextFile reads utf8 content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oidc-action-'))
  try {
    const p = join(dir, 'file.txt')
    writeFileSync(p, 'hello', 'utf8')
    assert.equal(readTextFile(p), 'hello')
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// Test parseLockfile with unsupported file types
test('parseLockfile returns empty map for unsupported lockfile types', () => {
  const result = parseLockfile('unsupported.lock', 'content')
  assert.ok(result instanceof Map)
  assert.equal(result.size, 0)
})

// Test parseNpmLock error cases
test('parseNpmLock handles malformed JSON', () => {
  const result = parseNpmLock('invalid json {')
  assert.ok(result instanceof Map)
  assert.equal(result.size, 0)
})

test('parseNpmLock handles missing packages property', () => {
  const result = parseNpmLock('{}')
  assert.ok(result instanceof Map)
  assert.equal(result.size, 0)
})

test('parseNpmLock handles entries without version', () => {
  const content = '{"packages":{"node_modules/test":{"name":"test"}}}'
  const result = parseNpmLock(content)
  assert.equal(result.size, 0)
})

test('parseNpmLock handles root package entry', () => {
  const content = '{"packages":{"":{"name":"root","version":"1.0.0"}}}'
  const result = parseNpmLock(content)
  assert.equal(result.size, 0) // Root package should be skipped
})

test('parseNpmLock handles entry without name', () => {
  const content = '{"packages":{"node_modules/test":{"version":"1.0.0"}}}'
  const result = parseNpmLock(content)
  assert.equal(result.get('test')?.has('1.0.0'), true)
})

test('parseNpmLock handles entry with explicit name', () => {
  const content = '{"packages":{"node_modules/test":{"name":"different","version":"1.0.0"}}}'
  const result = parseNpmLock(content)
  assert.equal(result.get('different')?.has('1.0.0'), true)
})

// Test parsePnpmLock edge cases
test('parsePnpmLock handles content without packages section', () => {
  const content = 'settings:\n  autoInstallPeers: true'
  const result = parsePnpmLock(content)
  assert.equal(result.size, 0)
})

test('parsePnpmLock handles packages section without entries', () => {
  const content = 'packages:\n\nsettings:\n  autoInstallPeers: true'
  const result = parsePnpmLock(content)
  assert.equal(result.size, 0)
})

test('parsePnpmLock handles malformed package entries', () => {
  const content = `packages:

  /test@1.0.0:
    resolution: {integrity: sha512-test}
  
  invalid-entry-without-colon
  
  /valid@2.0.0:
    resolution: {integrity: sha512-test}`
  const result = parsePnpmLock(content)
  // Both test and valid should be parsed because both have valid format
  assert.equal(result.get('test')?.has('1.0.0'), true)
  assert.equal(result.get('valid')?.has('2.0.0'), true)
  assert.equal(result.size, 2)
})

test('parsePnpmLock handles entries without @ symbol', () => {
  const content = `packages:

  /no-at-symbol:
    resolution: {integrity: sha512-test}`
  const result = parsePnpmLock(content)
  assert.equal(result.size, 0)
})

test('parsePnpmLock handles entries with @ at position 0', () => {
  const content = `packages:

  /@scoped:
    resolution: {integrity: sha512-test}`
  const result = parsePnpmLock(content)
  assert.equal(result.size, 0)
})

test('parsePnpmLock handles entries without version', () => {
  const content = `packages:

  /test@:
    resolution: {integrity: sha512-test}`
  const result = parsePnpmLock(content)
  assert.equal(result.size, 0)
})

test('parsePnpmLock handles quoted package names', () => {
  const content = `packages:

  "/test@1.0.0":
    resolution: {integrity: sha512-test}
  
  '/another@2.0.0':
    resolution: {integrity: sha512-test}`
  const result = parsePnpmLock(content)
  assert.equal(result.size, 2)
  // The parser doesn't strip leading slash for quoted names
  assert.equal(result.get('/test')?.has('1.0.0'), true)
  assert.equal(result.get('/another')?.has('2.0.0'), true)
})

test('parsePnpmLock handles packages with peer dependencies suffix', () => {
  const content = `packages:

  /test@1.0.0(peer@2.0.0):
    resolution: {integrity: sha512-test}`
  const result = parsePnpmLock(content)
  assert.equal(result.get('test')?.has('1.0.0'), true)
})

// Test parseYarnV1Lock edge cases
test('parseYarnV1Lock handles entries without version', () => {
  const content = `# yarn lockfile v1

test@^1.0.0:
  resolved "https://registry.yarnpkg.com/test"
  # no version field`
  const result = parseYarnV1Lock(content)
  assert.equal(result.size, 0)
})

test('parseYarnV1Lock handles multi-line headers', () => {
  const content = `# yarn lockfile v1

"test@^1.0.0",
"test@^1.1.0":
  version "1.2.0"
  resolved "https://registry.yarnpkg.com/test"`
  const result = parseYarnV1Lock(content)
  assert.equal(result.get('test')?.has('1.2.0'), true)
})

test('parseYarnV1Lock skips invalid specifiers', () => {
  const content = `# yarn lockfile v1

invalid-spec:
  version "1.0.0"
  
test@^1.0.0:
  version "2.0.0"`
  const result = parseYarnV1Lock(content)
  assert.equal(result.get('test')?.has('2.0.0'), true)
  assert.equal(result.size, 1)
})

// Test parseYarnBerryLock edge cases
test('parseYarnBerryLock handles entries without version', () => {
  const content = `"test@npm:^1.0.0":
  resolution: "test@npm:1.2.0"
  # no version field`
  const result = parseYarnBerryLock(content)
  assert.equal(result.size, 0)
})

test('parseYarnBerryLock handles invalid specifiers', () => {
  const content = `"invalid-spec":
  version: "1.0.0"
  
"test@npm:^1.0.0":
  version: "2.0.0"`
  const result = parseYarnBerryLock(content)
  assert.equal(result.get('test')?.has('2.0.0'), true)
  assert.equal(result.size, 1)
})

test('parseYarnBerryLock skips comment lines', () => {
  const content = `# This is a comment
"test@npm:^1.0.0":
  version: "1.0.0"
  
# Another comment
"other@npm:^2.0.0":
  version: "2.0.0"`
  const result = parseYarnBerryLock(content)
  assert.equal(result.get('test')?.has('1.0.0'), true)
  assert.equal(result.get('other')?.has('2.0.0'), true)
})

test('parseYarnBerryLock handles single quotes in specifiers', () => {
  const content = `'test@npm:^1.0.0':
  version: '1.0.0'`
  const result = parseYarnBerryLock(content)
  assert.equal(result.get('test')?.has('1.0.0'), true)
})

test('parseYarnBerryLock handles lines without colon', () => {
  const content = `"test@npm:^1.0.0"
  version: "1.0.0"
  
"valid@npm:^2.0.0":
  version: "2.0.0"`
  const result = parseYarnBerryLock(content)
  // Only valid should be parsed since test line doesn't end with ':'
  assert.equal(result.get('valid')?.has('2.0.0'), true)
  assert.equal(result.has('test'), false)
  assert.equal(result.size, 1)
})

// Test parseBunLock edge cases
test('parseBunLock handles malformed JSON', () => {
  const result = parseBunLock('invalid json {')
  assert.ok(result instanceof Map)
  assert.equal(result.size, 0)
})

test('parseBunLock handles JSONC with comments', () => {
  const content = `{
  // This is a comment
  "packages": [
    {
      "name": "test",
      "version": "1.0.0" // Another comment
    }
  ]
}`
  const result = parseBunLock(content)
  assert.equal(result.get('test')?.has('1.0.0'), true)
})

test('parseBunLock handles malformed JSONC', () => {
  const content = `{
  // This is a comment
  "packages": [
    invalid json
  ]
}`
  const result = parseBunLock(content)
  assert.equal(result.size, 0)
})

test('parseBunLock handles missing packages property', () => {
  const result = parseBunLock('{}')
  assert.equal(result.size, 0)
})

test('parseBunLock handles null packages', () => {
  const result = parseBunLock('{"packages": null}')
  assert.equal(result.size, 0)
})

test('parseBunLock handles array format with null entries', () => {
  const content = '{"packages": [null, {"name": "test", "version": "1.0.0"}]}'
  const result = parseBunLock(content)
  assert.equal(result.get('test')?.has('1.0.0'), true)
  assert.equal(result.size, 1)
})

test('parseBunLock handles array format without name or version', () => {
  const content = '{"packages": [{"description": "test"}]}'
  const result = parseBunLock(content)
  assert.equal(result.size, 0)
})

test('parseBunLock handles object format without version', () => {
  const content = '{"packages": {"test@1.0.0": {"name": "test"}}}'
  const result = parseBunLock(content)
  assert.equal(result.size, 0)
})

test('parseBunLock handles object format without name but with key pattern', () => {
  const content = '{"packages": {"test@1.0.0": {"version": "1.0.0"}}}'
  const result = parseBunLock(content)
  assert.equal(result.get('test')?.has('1.0.0'), true)
})

test('parseBunLock handles scoped packages in key pattern', () => {
  const content = '{"packages": {"@scope/test@1.0.0": {"version": "1.0.0"}}}'
  const result = parseBunLock(content)
  assert.equal(result.get('@scope/test')?.has('1.0.0'), true)
})

test('parseBunLock handles invalid key patterns', () => {
  const content = '{"packages": {"invalid-key": {"version": "1.0.0"}}}'
  const result = parseBunLock(content)
  assert.equal(result.size, 0)
})

test('parseBunLock handles non-array non-object packages', () => {
  const content = '{"packages": "invalid"}'
  const result = parseBunLock(content)
  assert.equal(result.size, 0)
})

// Test yarnV1SpecifierToName edge cases
test('yarnV1SpecifierToName handles specs without @', () => {
  assert.equal(yarnV1SpecifierToName('invalid-spec'), undefined)
})

test('yarnV1SpecifierToName handles specs with @ at position 0', () => {
  assert.equal(yarnV1SpecifierToName('@invalid'), undefined)
})

// Test yarnBerrySpecifierToName edge cases
test('yarnBerrySpecifierToName handles scoped packages without version', () => {
  assert.equal(yarnBerrySpecifierToName('@scope/name'), undefined)
})

test('yarnBerrySpecifierToName handles regular packages without version', () => {
  assert.equal(yarnBerrySpecifierToName('name'), undefined)
})

test('yarnBerrySpecifierToName handles quoted specs', () => {
  assert.equal(yarnBerrySpecifierToName('"@scope/name@npm:1.0.0"'), '@scope/name')
  assert.equal(yarnBerrySpecifierToName('\'test@npm:1.0.0\''), 'test')
})

// Test findLockfileLine edge cases
test('findLockfileLine returns undefined for unsupported lockfile types', () => {
  const result = findLockfileLine('unsupported.lock', 'content', 'test', '1.0.0')
  assert.equal(result, undefined)
})

test('findLockfileLine handles npm lockfile without matches', () => {
  const content = '{"packages": {}}'
  const result = findLockfileLine('package-lock.json', content, 'nonexistent', '1.0.0')
  assert.equal(result, undefined)
})

test('findLockfileLine handles pnpm lockfile without matches', () => {
  const content = 'packages:\n\n  /other@1.0.0:\n    resolution: {}'
  const result = findLockfileLine('pnpm-lock.yaml', content, 'test', '1.0.0')
  assert.equal(result, undefined)
})

test('findLockfileLine handles yarn v1 lockfile without matches', () => {
  const content = '# yarn lockfile v1\n\nother@^1.0.0:\n  version "1.0.0"'
  const result = findLockfileLine('yarn.lock', content, 'test', '1.0.0')
  assert.equal(result, undefined)
})

test('findLockfileLine handles yarn berry lockfile without matches', () => {
  const content = '"other@npm:^1.0.0":\n  version: "1.0.0"'
  const result = findLockfileLine('yarn.lock', content, 'test', '1.0.0')
  assert.equal(result, undefined)
})

test('findLockfileLine handles bun lockfile without matches', () => {
  const content = '{"packages": {"different@2.0.0": {"version": "2.0.0"}}}'
  const result = findLockfileLine('bun.lock', content, 'test', '1.0.0')
  assert.equal(result, undefined)
})

// Test diffDependencySets to cover setsEqual edge cases
test('diffDependencySets detects different versions in sets', () => {
  const prev = new Map([['lodash', new Set(['4.17.21'])]])
  const curr = new Map([['lodash', new Set(['4.17.22'])]])
  const diff = diffDependencySets(prev, curr)
  assert.equal(diff.length, 1)
  assert.equal(diff[0].name, 'lodash')
})

test('diffDependencySets detects removed packages', () => {
  const prev = new Map([['lodash', new Set(['4.17.21'])], ['removed', new Set(['1.0.0'])]])
  const curr = new Map([['lodash', new Set(['4.17.21'])]])
  const diff = diffDependencySets(prev, curr)
  assert.equal(diff.length, 1)
  assert.equal(diff[0].name, 'removed')
  assert.equal(diff[0].previous.has('1.0.0'), true)
  assert.equal(diff[0].current.size, 0)
})
