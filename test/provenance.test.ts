import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { hasProvenance } from '../lib/index.ts'

test('hasProvenance detects known provenance package versions', async () => {
  const cache = new Map<string, boolean>()
  assert.equal(await hasProvenance('nuxt', '4.1.2', cache), true)
  assert.equal(await hasProvenance('nuxt', '3.0.0', cache), false)
})
