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
    const failOnDowngradeValue = (getInput('fail-on-downgrade') || 'true').toLowerCase()
    const failAnyDowngrade = failOnDowngradeValue === 'true'
      || failOnDowngradeValue === 'any'
      || failOnDowngradeValue === ''
    const failOnlyProvenanceLoss = failOnDowngradeValue === 'only-provenance-loss'
    const failOnProvChange = (getInput('fail-on-provenance-change') || 'false').toLowerCase() === 'true'

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
    const provenanceDetailsCache = new Map<string, ProvenanceDetails>()
    const trustedPublisherCache = new Map<string, boolean>()
    type DowngradeType = 'provenance' | 'trusted_publisher'
    type DowngradeEvent = { name: string, from: string, to: string, downgradeType: DowngradeType, keptProvenance?: boolean }
    const events: DowngradeEvent[] = []
    type ChangeWarningType = 'repo_changed' | 'branch_changed'
    type ChangeWarning = { name: string, from: string, to: string, type: ChangeWarningType, prevRepo?: string, newRepo?: string, prevBranch?: string, newBranch?: string }
    const warnings: ChangeWarning[] = []

    for (const change of changed) {
      if (change.previous.size === 0 || change.current.size === 0) {
        continue
      }

      // For each newly introduced version, compare against any previous version that had provenance
      for (const newVersion of change.current) {
        if (change.previous.has(newVersion)) continue

        const hasProvNew = await hasProvenance(change.name, newVersion, provenanceCache)
        const newDetails = await getProvenanceDetails(change.name, newVersion, provenanceDetailsCache)
        const hasTPNew = await hasTrustedPublisher(change.name, newVersion, trustedPublisherCache)

        // Trusted publisher downgrade (prev had TP, new does not)
        if (!hasTPNew) {
          for (const prevVersion of change.previous) {
            const hadTPPrev = await hasTrustedPublisher(change.name, prevVersion, trustedPublisherCache)
            if (hadTPPrev) {
              events.push({ name: change.name, from: prevVersion, to: newVersion, downgradeType: 'trusted_publisher', keptProvenance: hasProvNew })
              break
            }
          }
        }

        // Provenance downgrade (prev had provenance, new does not)
        if (!hasProvNew) {
          for (const prevVersion of change.previous) {
            const hadProv = await hasProvenance(change.name, prevVersion, provenanceCache)
            if (hadProv) {
              events.push({ name: change.name, from: prevVersion, to: newVersion, downgradeType: 'provenance' })
              break
            }
          }
        }

        // Provenance detail change checks (repo/branch) — warn only
        if (hasProvNew) {
          for (const prevVersion of change.previous) {
            const prevDetails = await getProvenanceDetails(change.name, prevVersion, provenanceDetailsCache)
            if (!prevDetails.has) continue
            // Repository change
            if (prevDetails.repository && newDetails.repository && prevDetails.repository !== newDetails.repository) {
              warnings.push({ name: change.name, from: prevVersion, to: newVersion, type: 'repo_changed', prevRepo: prevDetails.repository, newRepo: newDetails.repository })
              break
            }
            // Branch change
            const prevBranch = prevDetails.branch
            const newBranch = newDetails.branch
            if (prevBranch && newBranch && prevBranch !== newBranch) {
              warnings.push({ name: change.name, from: prevVersion, to: newVersion, type: 'branch_changed', prevBranch, newBranch })
              break
            }
          }
        }
      }
    }

    if (events.length === 0) {
      log('No downgrades detected.')
      setOutput('downgraded', '[]')
      // Still report provenance change warnings if any
      if (warnings.length === 0) {
        setOutput('changed', '[]')
        return
      }
    }

    if (events.length > 0) {
      const summaryLines = events.map(d => `- ${d.name}: ${d.from} -> ${d.to} [${d.downgradeType}${d.downgradeType === 'trusted_publisher' && d.keptProvenance ? ', kept provenance' : ''}]`)
      log('Detected dependency downgrades:')
      for (const line of summaryLines) log(line)
      appendSummary(['Dependency downgrades:', ...summaryLines].join('\n'))
    }

    if (warnings.length > 0) {
      const warnLines = warnings.map(w => {
        if (w.type === 'repo_changed') return `- ${w.name}: ${w.from} -> ${w.to} [provenance repository changed: ${w.prevRepo} -> ${w.newRepo}]`
        return `- ${w.name}: ${w.from} -> ${w.to} [provenance branch changed: ${w.prevBranch} -> ${w.newBranch}]`
      })
      log('Detected provenance changes:')
      for (const line of warnLines) log(line)
      appendSummary(['Provenance changes:', ...warnLines].join('\n'))
    }

    // Emit GitHub Actions annotations on the lockfile lines (best-effort)
    for (const d of events) {
      const line = findLockfileLine(lockfilePath, headContent, d.name, d.to)
      const shouldFail = (failAnyDowngrade || (failOnlyProvenanceLoss && d.downgradeType === 'provenance'))
      const level: 'error' | 'warning' = shouldFail ? 'error' : 'warning'
      const base = d.downgradeType === 'provenance' ? 'lost npm provenance' : 'lost trusted publisher'
      const extra = d.downgradeType === 'trusted_publisher' && d.keptProvenance ? ' (kept provenance)' : ''
      const msg = `${d.name} ${base}: ${d.from} -> ${d.to}${extra}`
      if (line) annotate(level, lockfilePath, line, 1, msg)
      else annotate(level, lockfilePath, 1, 1, msg)
    }

    // Emit annotations for provenance change warnings
    for (const w of warnings) {
      const line = findLockfileLine(lockfilePath, headContent, w.name, w.to)
      const msg = w.type === 'repo_changed'
        ? `${w.name} provenance repository changed: ${w.prevRepo} -> ${w.newRepo}`
        : `${w.name} provenance branch changed: ${w.prevBranch} -> ${w.newBranch}`
      const level = failOnProvChange ? 'error' : 'warning'
      if (line) annotate(level, lockfilePath, line, 1, msg)
      else annotate(level, lockfilePath, 1, 1, msg)
    }

    // Output combined list (omit keptProvenance to keep output minimal)
    const outputEvents = events.map(e => ({ name: e.name, from: e.from, to: e.to, downgradeType: e.downgradeType }))
    setOutput('downgraded', JSON.stringify(outputEvents))
    // Output provenance changes
    const changedOutput = warnings.map(w => ({
      name: w.name,
      from: w.from,
      to: w.to,
      type: w.type,
      previousRepository: w.prevRepo,
      newRepository: w.newRepo,
      previousBranch: w.prevBranch,
      newBranch: w.newBranch,
    }))
    setOutput('changed', JSON.stringify(changedOutput))

    // Decide failure
    if (failAnyDowngrade || failOnlyProvenanceLoss || failOnProvChange) {
      const hasFailDowngrade = events.some(e => failAnyDowngrade || (failOnlyProvenanceLoss && e.downgradeType === 'provenance'))
      const hasFailProvChange = failOnProvChange && warnings.length > 0
      if (hasFailDowngrade || hasFailProvChange) process.exitCode = 1
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
  if (lockfilePath.endsWith('yarn.lock')) {
    if (content.includes('yarn lockfile v1')) return parseYarnV1Lock(content)
    return parseYarnBerryLock(content)
  }
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

function parseYarnV1Lock(content: string): VersionsSet {
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
      const name = yarnV1SpecifierToName(spec)
      if (name) addVersion(result, name, version)
    }
  }
  return result
}

function parseYarnBerryLock(content: string): VersionsSet {
  const result: VersionsSet = new Map()
  const lines = content.split(/\r?\n/)
  let i = 0
  while (i < lines.length) {
    let line = lines[i]

    // Skip blanks and comments
    if (!line || line.trimStart().startsWith('#')) { i++; continue }

    // Yarn Berry keys are quoted descriptors, possibly multiple separated by commas
    if (!line.startsWith('"') && !line.startsWith('\'')) { i++; continue }
    if (!line.trimEnd().endsWith(':')) { i++; continue }

    // Collect header (usually single line); split by commas into individual descriptors
    const headerLine = line.trim()
    const specifiers = headerLine
      .split(',')
      .map(s => s.trim())
      .map(s => s.replace(/:$/, ''))
      .map(s => s.replace(/^"|"$/g, '').replace(/^'|'$/g, ''))

    // Read block to get version
    i++
    let version: string | undefined
    while (i < lines.length) {
      line = lines[i]
      if (!line) { break }
      if (!line.startsWith(' ')) { break }
      const vm = /^\s{2}version:\s*(?:"([^\"]+)"|'([^']+)'|([^\s#]+))/.exec(line)
      if (vm) {
        version = vm[1] || vm[2] || vm[3]
      }
      i++
    }

    if (!version) { continue }
    for (const spec of specifiers) {
      const name = yarnBerrySpecifierToName(spec)
      if (name) { addVersion(result, name, version) }
    }
  }
  return result
}

function yarnV1SpecifierToName(spec: string): string | undefined {
  // Examples: lodash@^4.17.21, @scope/name@^1.2.3, name@npm:^1.0.0, name@patch:...
  // Take everything before the last '@'
  const at = spec.lastIndexOf('@')
  if (at <= 0) return undefined
  return spec.slice(0, at)
}

function yarnBerrySpecifierToName(spec: string): string | undefined {
  // Yarn Berry descriptors like: "name@npm:^1.0.0" or "@scope/name@npm:^1.0.0"
  const s = spec.replace(/^"|"$/g, '').replace(/^'|'$/g, '')
  if (s.startsWith('@')) {
    const at2 = s.indexOf('@', 1)
    if (at2 <= 0) { return undefined }
    return s.slice(0, at2)
  }
  const at1 = s.indexOf('@')
  if (at1 <= 0) { return undefined }
  return s.slice(0, at1)
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

type ProvenanceDetails = { has: boolean, repository?: string, ref?: string, branch?: string }

async function getProvenanceDetails(name: string, version: string, cache: Map<string, ProvenanceDetails>): Promise<ProvenanceDetails> {
  const key = `${name}@${version}`
  if (cache.has(key)) return cache.get(key) as ProvenanceDetails

  const details: ProvenanceDetails = { has: false }
  const encodedName = encodeURIComponent(name)
  const encodedVersion = encodeURIComponent(version)
  const attestUrls = [
    `https://registry.npmjs.org/-/npm/v1/attestations/${encodedName}@${encodedVersion}`,
    `https://registry.npmjs.org/-/v1/attestations/${encodedName}@${encodedVersion}`
  ]

  for (const url of attestUrls) {
    try {
      const res = await httpJson(url)
      const attestations: any[] = Array.isArray(res?.attestations) ? res.attestations : []
      if (attestations.length === 0) continue
      // Mark has provenance if any attestation exists
      details.has = true
      // Try to extract repo/ref from any attestation
      for (const att of attestations) {
        const { repository, ref } = extractRepoAndRef(att)
        if (repository || ref) {
          details.repository = repository || details.repository
          details.ref = ref || details.ref
          if (details.ref) details.branch = normalizeRefToBranch(details.ref)
          if (details.repository && details.branch) break
        }
      }
      break
    } catch (e: any) {
      if (e && e.statusCode === 404) {
        // No provenance
        cache.set(key, details)
        return details
      }
      // Other errors: try next endpoint
      continue
    }
  }

  // Fallback to metadata if needed
  if (!details.has) {
    try {
      const meta = await httpJson(packageMetadataUrl(name))
      const ver = meta && meta.versions && meta.versions[version]
      if (ver && ver.dist && ver.dist.attestations) {
        const attestations = Array.isArray(ver.dist.attestations) ? ver.dist.attestations : [ver.dist.attestations]
        if (attestations.length) {
          details.has = true
          for (const att of attestations) {
            const { repository, ref } = extractRepoAndRef(att)
            if (repository || ref) {
              details.repository = repository || details.repository
              details.ref = ref || details.ref
              if (details.ref) details.branch = normalizeRefToBranch(details.ref)
              if (details.repository && details.branch) break
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }

  cache.set(key, details)
  return details
}

function extractRepoAndRef(att: any): { repository?: string, ref?: string } {
  // Try several known shapes for npm/GitHub SLSA provenance
  const stmt = att?.statement || att?.envelope || att
  const predicate = stmt?.predicate || att?.predicate
  const bd = predicate?.buildDefinition || predicate?.buildConfig || predicate?.build || {}
  const ext = bd?.externalParameters || bd?.externalParametersJSON || {}
  const workflow = ext?.workflow || ext?.github?.workflow || {}
  const invocation = predicate?.invocation || {}
  const configSource = invocation?.configSource || {}

  let repository: string | undefined
  let ref: string | undefined

  // Direct workflow fields
  if (typeof workflow?.repository === 'string') repository = normalizeRepository(workflow.repository)
  if (typeof workflow?.ref === 'string') ref = workflow.ref

  // configSource.uri like git+https://github.com/owner/repo@refs/heads/main
  const uri = typeof configSource?.uri === 'string' ? configSource.uri : undefined
  if (!repository || !ref) {
    const parsed = uri ? parseRepoRefFromUri(uri) : undefined
    if (parsed) {
      repository = repository || parsed.repository
      ref = ref || parsed.ref
    }
  }

  // Sometimes present under bd.resolvedDependencies[].uri
  if (!repository) {
    const deps = Array.isArray(bd?.resolvedDependencies) ? bd.resolvedDependencies : []
    for (const d of deps) {
      const u = typeof d?.uri === 'string' ? d.uri : undefined
      const parsed = u ? parseRepoRefFromUri(u) : undefined
      if (parsed?.repository) { repository = parsed.repository; break }
    }
  }

  return { repository, ref }
}

function normalizeRepository(repo: string): string {
  // Accept formats like owner/repo or https://github.com/owner/repo(.git)
  if (/^[^\s/]+\/[^^\s/]+$/.test(repo)) return repo.replace(/\.git$/, '')
  try {
    const url = new URL(repo.replace(/^git\+/, ''))
    if (url.hostname.endsWith('github.com')) {
      const parts = url.pathname.replace(/\.git$/, '').split('/').filter(Boolean)
      if (parts.length >= 2) return `${parts[0]}/${parts[1]}`
    }
  } catch {}
  return repo
}

function parseRepoRefFromUri(uri: string): { repository?: string, ref?: string } | undefined {
  try {
    const cleaned = uri.replace(/^git\+/, '')
    // Split at last '@' to separate repo from ref if present
    const at = cleaned.lastIndexOf('@')
    let repoUrl = cleaned
    let ref: string | undefined
    if (at > cleaned.indexOf('://') + 2) {
      repoUrl = cleaned.slice(0, at)
      ref = cleaned.slice(at + 1)
    }
    const url = new URL(repoUrl)
    if (!url.hostname.endsWith('github.com')) return undefined
    const parts = url.pathname.replace(/\.git$/, '').split('/').filter(Boolean)
    if (parts.length < 2) return undefined
    const repository = `${parts[0]}/${parts[1]}`
    return { repository, ref }
  } catch {
    return undefined
  }
}

function normalizeRefToBranch(ref?: string): string | undefined {
  if (!ref || typeof ref !== 'string') return undefined
  if (ref.startsWith('refs/heads/')) return ref.slice('refs/heads/'.length)
  return undefined
}

async function hasTrustedPublisher(name: string, version: string, cache: Map<string, boolean>): Promise<boolean> {
  const key = `${name}@${version}`
  if (cache.has(key)) return cache.get(key) as boolean
  try {
    const meta = await httpJson(packageMetadataUrl(name))
    const ver = meta && meta.versions && meta.versions[version]
    const tp = Boolean(ver && ver._npmUser && ver._npmUser.trustedPublisher)
      || Boolean(ver && ver._npmUser && ver._npmUser.name === 'GitHub Actions' && ver._npmUser.email === 'npm-oidc-no-reply@github.com')
    cache.set(key, tp)
    return tp
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
  if (lockfilePath.endsWith('yarn.lock')) {
    if (content.includes('yarn lockfile v1')) return findLineInYarnV1Lock(content, name, version)
    return findLineInYarnBerryLock(content, name, version)
  }
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

function findLineInYarnV1Lock(content: string, name: string, version: string): number | undefined {
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

function findLineInYarnBerryLock(content: string, name: string, version: string): number | undefined {
  const lines = content.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i]
    if (!header || header.startsWith(' ') || header.trimStart().startsWith('#')) continue
    if (!header.trimEnd().endsWith(':')) continue
    // Header contains one or more specifiers
    if (!header.includes(`${name}@`)) continue
    // Scan block for version line
    let j = i + 1
    while (j < lines.length && (lines[j].startsWith(' ') || !lines[j])) {
      const m = /^\s{2}version:\s*(?:"([^\"]+)"|'([^']+)'|([^\s#]+))/.exec(lines[j])
      const ver = m ? (m[1] || m[2] || m[3]) : undefined
      if (ver === version) return j + 1
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
  parseYarnV1Lock,
  parseYarnBerryLock,
  yarnV1SpecifierToName,
  yarnBerrySpecifierToName,
  diffDependencySets,
  findLockfileLine,
  hasProvenance,
  hasTrustedPublisher,
}
