import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { annotate, appendSummary, getInput, log, logError, setOutput } from '../lib/gh.ts'

describe('gitHub input/output and logging helpers', () => {
  it('getInput reads from process.env with normalization', () => {
    try {
      vi.stubEnv('INPUT_FOO', 'bar')
      vi.stubEnv('INPUT_HELLO_WORLD', 'ok')
      expect(getInput('foo')).toBe('bar')
      expect(getInput('hello-world')).toBe('ok')
    }
    finally {
      vi.unstubAllEnvs()
    }
  })

  it('setOutput appends in GitHub output file format', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oidc-action-'))
    const out = join(dir, 'output.txt')
    try {
      vi.stubEnv('GITHUB_OUTPUT', out)
      setOutput('name', 'value1')
      setOutput('name', 'value2')
      const content = readFileSync(out, 'utf8')
      expect(content.includes('name<<__EOF__\nvalue1\n__EOF__'))
      expect(content.includes('name<<__EOF__\nvalue2\n__EOF__'))
    }
    finally {
      vi.unstubAllEnvs()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('appendSummary writes lines to summary file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oidc-action-'))
    const out = join(dir, 'summary.txt')
    try {
      vi.stubEnv('GITHUB_STEP_SUMMARY', out)
      appendSummary('hello')
      appendSummary('world')
      const content = readFileSync(out, 'utf8')
      expect(content).toBe('hello\nworld\n')
    }
    finally {
      vi.unstubAllEnvs()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('annotate formats GitHub logging command and escapes newlines', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      annotate('error', 'file.txt', 3, 7, 'line1\nline2')
      expect(spy).toHaveBeenCalledTimes(1)
      const logged = String(spy.mock.calls[0][0])
      expect(logged.startsWith('::error file=file.txt,line=3,col=7::'))
      expect(logged.includes('line1%0Aline2'))
    }
    finally {
      spy.mockRestore()
    }
  })

  it('log and logError write to console', () => {
    const spyLog = vi.spyOn(console, 'log').mockImplementation(() => {})
    const spyErr = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      log('hello')
      logError(new Error('boom'))
      logError('world')
      expect(spyLog).toHaveBeenCalledWith('hello')
      const firstErr = String(spyErr.mock.calls[0][0])
      expect(/boom|Error/.test(firstErr)).toBe(true)
      expect(spyErr).toHaveBeenNthCalledWith(2, 'world')
    }
    finally {
      spyLog.mockRestore()
      spyErr.mockRestore()
    }
  })
})
