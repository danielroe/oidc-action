import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type VersionsSet = Map<string, Set<string>>

export const supportedLockfiles = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock'] as const

export function detectLockfile(workspacePath: string): string | undefined {
  for (const c of supportedLockfiles) {
    if (existsSync(join(workspacePath, c)))
      return c
  }
  return undefined
}

export function readTextFile(path: string): string {
  return readFileSync(path, 'utf8')
}

export function parseLockfile(lockfilePath: string, content: string): VersionsSet {
  if (lockfilePath.endsWith('package-lock.json'))
    return parseNpmLock(content)
  if (lockfilePath.endsWith('pnpm-lock.yaml'))
    return parsePnpmLock(content)
  if (lockfilePath.endsWith('yarn.lock')) {
    if (content.includes('yarn lockfile v1'))
      return parseYarnV1Lock(content)
    return parseYarnBerryLock(content)
  }
  if (lockfilePath.endsWith('bun.lock'))
    return parseBunLock(content)
  return new Map()
}

export function parseNpmLock(content: string): VersionsSet {
  const result: VersionsSet = new Map()
  let json: any
  try {
    json = JSON.parse(content)
  }
  catch {
    return result
  }
  const packages = json.packages || {}
  for (const key of Object.keys(packages)) {
    const entry = packages[key]
    const version: string | undefined = entry && entry.version
    if (!version)
      continue
    if (key === '')
      continue
    let name: string | undefined = entry.name
    if (!name) {
      const parts = key.split('node_modules/').filter(Boolean)
      if (parts.length > 0) {
        const last = parts[parts.length - 1].replace(/\/$/, '')
        name = last
      }
    }
    if (!name)
      continue
    addVersion(result, name, version)
  }
  return result
}

export function parsePnpmLock(content: string): VersionsSet {
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
    if (/^\S.*:$/.test(line)) {
      inPackages = /^packages:\s*$/.test(line)
      continue
    }
    const m = /^\s{2}(\S.*?):\s*$/.exec(line)
    if (!m)
      continue
    let key = m[1]
    if (key.startsWith('/'))
      key = key.slice(1)
    if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith('\'') && key.endsWith('\''))) {
      key = key.slice(1, -1)
    }
    const core = key.includes('(') ? key.slice(0, key.indexOf('(')) : key
    const at = core.lastIndexOf('@')
    if (at <= 0)
      continue
    const name = core.slice(0, at)
    const version = core.slice(at + 1).trim()
    if (!version)
      continue
    addVersion(result, name, version)
  }
  return result
}

export function parseYarnV1Lock(content: string): VersionsSet {
  const result: VersionsSet = new Map()
  const lines = content.split(/\r?\n/)
  let i = 0
  while (i < lines.length) {
    let line = lines[i]
    if (!line || /^\s/.test(line)) {
      i++
      continue
    }
    if (!line.trimEnd().endsWith(':')) {
      i++
      continue
    }
    const headerLines: string[] = []
    while (i < lines.length) {
      const hl = lines[i]
      headerLines.push(hl)
      i++
      if (!lines[i] || lines[i].startsWith('  '))
        break
    }
    const specifiers = headerLines.join('\n')
      .split(',\n')
      .map(s => s.trim())
      .map(s => s.replace(/:$/, ''))
      .map(s => s.replace(/^"|"$/g, ''))

    let version: string | undefined
    while (i < lines.length) {
      line = lines[i]
      if (!line || (!line.startsWith(' ') && line.trimEnd().endsWith(':')))
        break
      const vm = /^\s{2}version\s+"([^"]+)"/.exec(line)
      if (vm)
        version = vm[1]
      i++
    }
    if (!version)
      continue
    for (const spec of specifiers) {
      const name = yarnV1SpecifierToName(spec)
      if (name)
        addVersion(result, name, version)
    }
  }
  return result
}

export function parseYarnBerryLock(content: string): VersionsSet {
  const result: VersionsSet = new Map()
  const lines = content.split(/\r?\n/)
  let i = 0
  while (i < lines.length) {
    let line = lines[i]
    if (!line || line.trimStart().startsWith('#')) {
      i++
      continue
    }
    if (!line.startsWith('"') && !line.startsWith('\'')) {
      i++
      continue
    }
    if (!line.trimEnd().endsWith(':')) {
      i++
      continue
    }
    const headerLine = line.trim()
    const specifiers = headerLine
      .split(',')
      .map(s => s.trim())
      .map(s => s.replace(/:$/, ''))
      .map(s => s.replace(/^"|"$/g, '').replace(/^'|'$/g, ''))

    i++
    let version: string | undefined
    while (i < lines.length) {
      line = lines[i]
      if (!line)
        break
      if (!line.startsWith(' '))
        break
      const vm = /^\s{2}version:\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))/.exec(line)
      if (vm)
        version = vm[1] || vm[2] || vm[3]
      i++
    }
    if (!version)
      continue
    for (const spec of specifiers) {
      const name = yarnBerrySpecifierToName(spec)
      if (name)
        addVersion(result, name, version)
    }
  }
  return result
}

export function parseBunLock(content: string): VersionsSet {
  const result: VersionsSet = new Map()
  let json: any
  try {
    // Try a straightforward JSON parse first (fixtures may be pure JSON)
    json = JSON.parse(content)
  }
  catch {
    // Fallback: strip simple // comments and retry (very naive JSONC support)
    try {
      const withoutLineComments = content
        .split(/\r?\n/)
        .map(l => l.replace(/(^|\s)\/\/.*$/, '$1'))
        .join('\n')
      json = JSON.parse(withoutLineComments)
    }
    catch {
      return result
    }
  }

  const pkgs = json && json.packages
  if (!pkgs)
    return result

  if (Array.isArray(pkgs)) {
    for (const entry of pkgs) {
      if (!entry)
        continue
      const name: string | undefined = entry.name
      const version: string | undefined = entry.version
      if (name && version)
        addVersion(result, name, version)
    }
    return result
  }

  if (typeof pkgs === 'object') {
    for (const key of Object.keys(pkgs)) {
      const entry = pkgs[key]
      const version: string | undefined = entry && entry.version
      if (!version)
        continue
      let name: string | undefined = entry && entry.name
      if (!name) {
        // Derive name from key patterns like "name@version" or "@scope/name@version"
        const spec = String(key)
        if (spec.startsWith('@')) {
          const at2 = spec.indexOf('@', 1)
          if (at2 > 0)
            name = spec.slice(0, at2)
        }
        else {
          const at1 = spec.indexOf('@')
          if (at1 > 0)
            name = spec.slice(0, at1)
        }
      }
      if (!name)
        continue
      addVersion(result, name, version)
    }
    return result
  }

  return result
}

export function yarnV1SpecifierToName(spec: string): string | undefined {
  const at = spec.lastIndexOf('@')
  if (at <= 0)
    return undefined
  return spec.slice(0, at)
}

export function yarnBerrySpecifierToName(spec: string): string | undefined {
  const s = spec.replace(/^"|"$/g, '').replace(/^'|'$/g, '')
  if (s.startsWith('@')) {
    const at2 = s.indexOf('@', 1)
    if (at2 <= 0)
      return undefined
    return s.slice(0, at2)
  }
  const at1 = s.indexOf('@')
  if (at1 <= 0)
    return undefined
  return s.slice(0, at1)
}

function addVersion(map: VersionsSet, name: string, version: string): void {
  let set = map.get(name)
  if (!set) {
    set = new Set()
    map.set(name, set)
  }
  set.add(version)
}

export function diffDependencySets(prev: VersionsSet, curr: VersionsSet): Array<{ name: string, previous: Set<string>, current: Set<string> }> {
  const names = new Set<string>([...prev.keys(), ...curr.keys()])
  const changes: Array<{ name: string, previous: Set<string>, current: Set<string> }> = []
  for (const name of names) {
    const a = prev.get(name) || new Set<string>()
    const b = curr.get(name) || new Set<string>()
    if (!setsEqual(a, b))
      changes.push({ name, previous: a, current: b })
  }
  return changes
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size)
    return false
  for (const v of a) {
    if (!b.has(v))
      return false
  }
  return true
}

export function findLockfileLine(lockfilePath: string, content: string, name: string, version: string): number | undefined {
  if (lockfilePath.endsWith('package-lock.json'))
    return findLineInNpmLock(content, name)
  if (lockfilePath.endsWith('pnpm-lock.yaml'))
    return findLineInPnpmLock(content, name, version)
  if (lockfilePath.endsWith('yarn.lock')) {
    if (content.includes('yarn lockfile v1'))
      return findLineInYarnV1Lock(content, name, version)
    return findLineInYarnBerryLock(content, name, version)
  }
  if (lockfilePath.endsWith('bun.lock'))
    return findLineInBunLock(content, name, version)
  return undefined
}

function countLinesBefore(content: string, index: number): number {
  let count = 1
  for (let i = 0; i < index && i < content.length; i++) {
    if (content.charCodeAt(i) === 10)
      count++
  }
  return count
}

function findLineInNpmLock(content: string, name: string): number | undefined {
  const key = `"node_modules/${name}"`
  const idx = content.indexOf(key)
  if (idx >= 0)
    return countLinesBefore(content, idx)
  const alt = `"name": "${name}"`
  const j = content.indexOf(alt)
  if (j >= 0)
    return countLinesBefore(content, j)
  return undefined
}

function findLineInPnpmLock(content: string, name: string, version: string): number | undefined {
  const lines = content.split(/\r?\n/)
  const needle = `/${name}@${version}`
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (!l)
      continue
    if (l.includes(needle) && l.trimEnd().endsWith(':'))
      return i + 1
  }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (!l)
      continue
    if (l.trimStart().startsWith(`/${name}@${version}`))
      return i + 1
  }
  return undefined
}

function findLineInYarnV1Lock(content: string, name: string, version: string): number | undefined {
  const lines = content.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i]
    if (!header || header.startsWith(' '))
      continue
    if (!header.trimEnd().endsWith(':'))
      continue
    if (!header.includes(`${name}@`))
      continue
    let j = i + 1
    while (j < lines.length && (lines[j].startsWith(' ') || !lines[j])) {
      const m = /^\s{2}version\s+"([^"]+)"/.exec(lines[j])
      if (m && m[1] === version)
        return j + 1
      if (lines[j] && !lines[j].startsWith(' ') && lines[j].trimEnd().endsWith(':'))
        break
      j++
    }
  }
  return undefined
}

function findLineInYarnBerryLock(content: string, name: string, version: string): number | undefined {
  const lines = content.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i]
    if (!header || header.startsWith(' ') || header.trimStart().startsWith('#'))
      continue
    if (!header.trimEnd().endsWith(':'))
      continue
    if (!header.includes(`${name}@`))
      continue
    let j = i + 1
    while (j < lines.length && (lines[j].startsWith(' ') || !lines[j])) {
      const m = /^\s{2}version:\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))/.exec(lines[j])
      const ver = m ? (m[1] || m[2] || m[3]) : undefined
      if (ver === version)
        return j + 1
      if (lines[j] && !lines[j].startsWith(' ') && lines[j].trimEnd().endsWith(':'))
        break
      j++
    }
  }
  return undefined
}

function findLineInBunLock(content: string, name: string, version: string): number | undefined {
  const lines = content.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (!l)
      continue
    if (l.includes(`"name"`) && l.includes(`"${name}"`)) {
      for (let j = i; j < Math.min(lines.length, i + 30); j++) {
        const v = lines[j]
        if (new RegExp(`\"version\"\\s*:\\s*\"${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\"`).test(v))
          return j + 1
        if (v && v.includes('}'))
          break
      }
    }
  }
  const needleKey = `"${name}@${version}"`
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(needleKey))
      return i + 1
  }
  for (let i = 0; i < lines.length; i++) {
    if (new RegExp(`\"version\"\\s*:\\s*\"${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\"`).test(lines[i]))
      return i + 1
  }
  return undefined
}
