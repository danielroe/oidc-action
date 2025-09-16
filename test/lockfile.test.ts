import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { detectLockfile, readTextFile } from '../lib/lockfile.ts'

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
