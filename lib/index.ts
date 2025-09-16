/**
 * Main entry point
 */
import { execFile as _execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as https from 'node:https'

const execFile = promisify(_execFile)

type VersionsSet = Map<string, Set<string>>

async function run(): Promise<void> {
  try {
    const workspacePath = getInput('workspace-path') || process.env.GITHUB_WORKSPACE || process.cwd()
    const lockfileInput = getInput('lockfile')
    const baseRefInput = getInput('base-ref')
    const failOnDowngrade = (getInput('fail-on-downgrade') || 'true').toLowerCase() === 'true'

    const lockfilePath = lockfileInput || detectLockfile(workspacePath)
    if (!lockfilePath) {
      log('No supported lockfile found. Supported: pnpm-lock.yaml, package-lock.json, yarn.lock')
      return
    }

    const absLockfilePath = join(workspacePath, lockfilePath)
    const headContent = readTextFile(absLockfilePath)

    const baseRef = baseRefInput || process.env.GITHUB_BASE_REF || await guessDefaultBaseRef()
    const baseContent = await gitShowFile(baseRef, lockfilePath, workspacePath)
    if (!baseContent) {
      log(`Could not read base lockfile from ref "${baseRef}". Nothing to compare.`)
      return
    }

    const currentDeps = parseLockfile(lockfilePath, headContent)
    const previousDeps = parseLockfile(lockfilePath, baseContent)

    const changed = diffDependencySets(previousDeps, currentDeps)
    if (changed.length === 0) {
      log('No dependency version changes detected in lockfile.')
      return
    }

    const provenanceCache = new Map<string, boolean>()
    const downgraded: Array<{ name: string, from: string, to: string }> = []

    for (const change of changed) {
      if (change.previous.size === 0 || change.current.size === 0) {
        continue
      }

      // For each newly introduced version, compare against any previous version that had provenance
      for (const newVersion of change.current) {
        if (change.previous.has(newVersion)) continue

        const hasProvNew = await hasProvenance(change.name, newVersion, provenanceCache)
        if (hasProvNew) continue

        // Check if any previous version had provenance
        let anyPrevHadProv = false
        for (const prevVersion of change.previous) {
          const hadProv = await hasProvenance(change.name, prevVersion, provenanceCache)
          if (hadProv) {
            anyPrevHadProv = true
            // Record the first pair we find
            downgraded.push({ name: change.name, from: prevVersion, to: newVersion })
            break
          }
        }
      }
    }

    if (downgraded.length === 0) {
      log('No provenance downgrades detected.')
      setOutput('downgraded', '[]')
      return
    }

    const summaryLines = downgraded.map(d => `- ${d.name}: ${d.from} -> ${d.to}`)
    log('Detected dependencies that lost provenance:')
    for (const line of summaryLines) log(line)

    // Emit GitHub Actions annotations on the lockfile lines (best-effort)
    for (const d of downgraded) {
      const line = findLockfileLine(lockfilePath, headContent, d.name, d.to)
      const level: 'error' | 'warning' = failOnDowngrade ? 'error' : 'warning'
      const msg = `${d.name} lost npm provenance: ${d.from} -> ${d.to}`
      if (line) annotate(level, lockfilePath, line, 1, msg)
      else annotate(level, lockfilePath, 1, 1, msg)
    }

    const json = JSON.stringify(downgraded)
    setOutput('downgraded', json)
    appendSummary(['Dependencies that lost npm provenance (trusted publishing):', ...summaryLines].join('\n'))

    if (failOnDowngrade) {
      process.exitCode = 1
    }
  } catch (err) {
    logError(err)
    process.exitCode = 1
  }
}

function getInput(name: string): string | undefined {
  const key = `INPUT_${name.replace(/ /g, '_').replace(/-/g, '_').toUpperCase()}`
  return process.env[key]
}

function detectLockfile(workspacePath: string): string | undefined {
  const candidates = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock']
  for (const c of candidates) {
    if (existsSync(join(workspacePath, c))) return c
  }
  return undefined
}

function readTextFile(path: string): string {
  return readFileSync(path, 'utf8')
}

async function guessDefaultBaseRef(): Promise<string> {
  // Try to derive the remote default branch; fallback to origin/main then HEAD^ if needed by callers
  try {
    const { stdout } = await execFile('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], { cwd: process.cwd() })
    const m = stdout.trim().match(/refs\/remotes\/origin\/(.*)$/)
    if (m) return `origin/${m[1]}`
  } catch {}
  return 'origin/main'
}

async function gitShowFile(ref: string, filePath: string, cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFile('git', ['show', `${ref}:${filePath}`], { cwd })
    return stdout
  } catch {
    // Try previous commit as a fallback if ref failed
    try {
      const { stdout } = await execFile('git', ['show', `HEAD^:${filePath}`], { cwd })
      return stdout
    } catch {
      return undefined
    }
  }
}

function parseLockfile(lockfilePath: string, content: string): VersionsSet {
  if (lockfilePath.endsWith('package-lock.json')) return parseNpmLock(content)
  if (lockfilePath.endsWith('pnpm-lock.yaml')) return parsePnpmLock(content)
  if (lockfilePath.endsWith('yarn.lock')) return parseYarnLockV1(content)
  return new Map()
}

function parseNpmLock(content: string): VersionsSet {
  const result: VersionsSet = new Map()
  let json: any
  try {
    json = JSON.parse(content)
  } catch {
    return result
  }
  const packages = json.packages || {}
  for (const key of Object.keys(packages)) {
    const entry = packages[key]
    const version: string | undefined = entry && entry.version
    if (!version) continue
    // Skip the root project entry
    if (key === '') continue
    let name: string | undefined = entry.name
    if (!name) {
      // Derive from path like "node_modules/@scope/name/..."
      const parts = key.split('node_modules/').filter(Boolean)
      if (parts.length > 0) {
        const last = parts[parts.length - 1].replace(/\/$/, '')
        name = last
      }
    }
    if (!name) continue
    addVersion(result, name, version)
  }
  return result
}

function parsePnpmLock(content: string): VersionsSet {
  const result: VersionsSet = new Map()
  const lines = content.split(/\r?\n/)
  let inPackages = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!inPackages) {
      if (/^packages:\s*$/.test(line)) {
        inPackages = true
      }
      continue
    }
    // Stop if next top-level section reached
    if (/^[^\s].*:$/.test(line)) {
      // another top-level section
      inPackages = /^packages:\s*$/.test(line)
      continue
    }
    // Match entries like "  /name@1.2.3:" or "  /@scope/name@1.2.3(peer@x):"
    const m = /^\s{2}([^\s].*?):\s*$/.exec(line)
    if (!m) continue
    let key = m[1]
    // Keys typically start with '/'
    if (key.startsWith("/")) key = key.slice(1)
    // Remove surrounding quotes if any
    if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
      key = key.slice(1, -1)
    }
    // Remove any peer info suffix like "(peer@x)"
    const core = key.includes('(') ? key.slice(0, key.indexOf('(')) : key
    // Extract name and version by last '@' BEFORE peer info
    const at = core.lastIndexOf('@')
    if (at <= 0) continue
    const name = core.slice(0, at)
    const version = core.slice(at + 1).trim()
    if (!version) continue
    addVersion(result, name, version)
  }
  return result
}

function parseYarnLockV1(content: string): VersionsSet {
  const result: VersionsSet = new Map()
  const lines = content.split(/\r?\n/)
  let i = 0
  while (i < lines.length) {
    let line = lines[i]
    // Find block header: one or more specifiers ending with ':' possibly continued with commas
    if (!line || /^\s/.test(line)) { i++; continue }
    if (!line.trimEnd().endsWith(':')) { i++; continue }

    // Collect all header lines (can span multiple lines if specifiers are split)
    const headerLines: string[] = []
    while (i < lines.length) {
      const hl = lines[i]
      headerLines.push(hl)
      i++
      if (!lines[i] || lines[i].startsWith('  ')) break
    }
    const specifiers = headerLines.join('\n')
      .split(',\n')
      .map(s => s.trim())
      .map(s => s.replace(/:$/, ''))
      .map(s => s.replace(/^"|"$/g, ''))

    // Parse block body until blank line or next header
    let version: string | undefined
    while (i < lines.length) {
      line = lines[i]
      if (!line || (!line.startsWith(' ') && line.trimEnd().endsWith(':'))) break
      const vm = /^\s{2}version\s+"([^"]+)"/.exec(line)
      if (vm) version = vm[1]
      i++
    }
    if (!version) continue
    for (const spec of specifiers) {
      const name = yarnSpecifierToName(spec)
      if (name) addVersion(result, name, version)
    }
  }
  return result
}

function yarnSpecifierToName(spec: string): string | undefined {
  // Examples: lodash@^4.17.21, @scope/name@^1.2.3, name@npm:^1.0.0, name@patch:...
  // Take everything before the last '@'
  const at = spec.lastIndexOf('@')
  if (at <= 0) return undefined
  return spec.slice(0, at)
}

function addVersion(map: VersionsSet, name: string, version: string): void {
  let set = map.get(name)
  if (!set) { set = new Set(); map.set(name, set) }
  set.add(version)
}

function diffDependencySets(prev: VersionsSet, curr: VersionsSet): Array<{ name: string, previous: Set<string>, current: Set<string> }> {
  const names = new Set<string>([...prev.keys(), ...curr.keys()])
  const changes: Array<{ name: string, previous: Set<string>, current: Set<string> }> = []
  for (const name of names) {
    const a = prev.get(name) || new Set<string>()
    const b = curr.get(name) || new Set<string>()
    if (!setsEqual(a, b)) {
      changes.push({ name, previous: a, current: b })
    }
  }
  return changes
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const v of a) if (!b.has(v)) return false
  return true
}

async function hasProvenance(name: string, version: string, cache: Map<string, boolean>): Promise<boolean> {
  const key = `${name}@${version}`
  if (cache.has(key)) return cache.get(key) as boolean

  // Try attestations endpoint(s)
  const encodedName = encodeURIComponent(name)
  const encodedVersion = encodeURIComponent(version)
  const attestUrls = [
    `https://registry.npmjs.org/-/npm/v1/attestations/${encodedName}@${encodedVersion}`,
    `https://registry.npmjs.org/-/v1/attestations/${encodedName}@${encodedVersion}`
  ]
  let endpointSaidHas = false
  for (const url of attestUrls) {
    try {
      const res = await httpJson(url)
      // Known shapes: { attestations: [...] } or { count: N, attestations: [...] }
      const count = typeof res?.count === 'number' ? res.count : (Array.isArray(res?.attestations) ? res.attestations.length : 0)
      if (count > 0) {
        endpointSaidHas = true
        break
      }
      // If explicitly empty, conclude no provenance
      cache.set(key, false)
      return false
    } catch (e: any) {
      // 404 means no provenance for this version
      if (e && e.statusCode === 404) {
        cache.set(key, false)
        return false
      }
      // Other errors: continue to fallback
      continue
    }
  }
  if (endpointSaidHas) {
    cache.set(key, true)
    return true
  }

  // Fallback: check version metadata for provenance hints
  try {
    const meta = await httpJson(packageMetadataUrl(name))
    const ver = meta && meta.versions && meta.versions[version]
    const has = Boolean(ver && (
      ver.provenance ||
      (ver.dist && (
        ver.dist.provenance ||
        // npm exposes an attestations object when provenance exists
        (ver.dist.attestations && (
          typeof ver.dist.attestations === 'object' || Array.isArray(ver.dist.attestations)
        ))
      ))
    ))
    cache.set(key, has)
    return has
  } catch {
    cache.set(key, false)
    return false
  }
}

function packageMetadataUrl(name: string): string {
  // Prefer encoding the whole name; registry accepts encoded scoped names
  return `https://registry.npmjs.org/${encodeURIComponent(name)}`
}

function httpJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'Accept': 'application/json' } }, (res) => {
      const { statusCode } = res
      if (!statusCode) { reject(new Error('No status code')); return }
      const chunks: Buffer[] = []
      res.on('data', (d) => chunks.push(typeof d === 'string' ? Buffer.from(d) : d))
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        if (statusCode < 200 || statusCode >= 300) {
          const err: any = new Error(`HTTP ${statusCode} for ${url}`)
          err.statusCode = statusCode
          err.body = body
          reject(err)
          return
        }
        try {
          resolve(body ? JSON.parse(body) : {})
        } catch (e) {
          reject(e)
        }
      })
    })
    req.on('error', reject)
  })
}

function setOutput(name: string, value: string): void {
  const filepath = process.env.GITHUB_OUTPUT
  if (!filepath) return
  writeFileSync(filepath, `${name}<<__EOF__\n${value}\n__EOF__\n`, { encoding: 'utf8', flag: 'a' })
}

function appendSummary(text: string): void {
  const filepath = process.env.GITHUB_STEP_SUMMARY
  if (!filepath) return
  writeFileSync(filepath, `${text}\n`, { encoding: 'utf8', flag: 'a' })
}

function log(message: any): void {
  // eslint-disable-next-line no-console
  console.log(String(message))
}

function logError(err: any): void {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.stack || err.message : String(err))
}

function annotate(level: 'error' | 'warning', file: string, line: number, col: number, message: string): void {
  const esc = (s: string) => String(s)
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A')
  // eslint-disable-next-line no-console
  console.log(`::${level} file=${file},line=${line},col=${col}::${esc(message)}`)
}

function findLockfileLine(lockfilePath: string, content: string, name: string, version: string): number | undefined {
  if (lockfilePath.endsWith('package-lock.json')) return findLineInNpmLock(content, name)
  if (lockfilePath.endsWith('pnpm-lock.yaml')) return findLineInPnpmLock(content, name, version)
  if (lockfilePath.endsWith('yarn.lock')) return findLineInYarnLockV1(content, name, version)
  return undefined
}

function countLinesBefore(content: string, index: number): number {
  let count = 1
  for (let i = 0; i < index && i < content.length; i++) if (content.charCodeAt(i) === 10) count++
  return count
}

function findLineInNpmLock(content: string, name: string): number | undefined {
  // Look for key line of the package block
  const key = `"node_modules/${name}"`
  const idx = content.indexOf(key)
  if (idx >= 0) return countLinesBefore(content, idx)
  // Fallback: try to find a "name": "<name>" occurrence
  const alt = `"name": "${name}"`
  const j = content.indexOf(alt)
  if (j >= 0) return countLinesBefore(content, j)
  return undefined
}

function findLineInPnpmLock(content: string, name: string, version: string): number | undefined {
  const lines = content.split(/\r?\n/)
  const needle = `/${name}@${version}`
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (!l) continue
    if (l.includes(needle) && l.trimEnd().endsWith(':')) return i + 1
  }
  // Fallback: match start-with and allow peer suffix
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (!l) continue
    if (l.trimStart().startsWith(`/${name}@${version}`)) return i + 1
  }
  return undefined
}

function findLineInYarnLockV1(content: string, name: string, version: string): number | undefined {
  const lines = content.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i]
    if (!header || header.startsWith(' ')) continue
    if (!header.trimEnd().endsWith(':')) continue
    // Header contains one or more specifiers
    if (!header.includes(`${name}@`)) continue
    // Scan block for version line
    let j = i + 1
    while (j < lines.length && (lines[j].startsWith(' ') || !lines[j])) {
      const m = /^\s{2}version\s+"([^"]+)"/.exec(lines[j])
      if (m && m[1] === version) return j + 1
      // Next block if encounter another header-like line without indentation
      if (lines[j] && !lines[j].startsWith(' ') && lines[j].trimEnd().endsWith(':')) break
      j++
    }
  }
  return undefined
}

// Run the action
if (import.meta.main) {
  run()
}

export { run }
export type { VersionsSet }
export {
  parseLockfile,
  parseNpmLock,
  parsePnpmLock,
  parseYarnLockV1,
  yarnSpecifierToName,
  diffDependencySets,
  hasProvenance,
}
