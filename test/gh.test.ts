import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { annotate, appendSummary, getInput, log, logError, setOutput } from '../lib/gh.ts'

test('getInput reads from process.env with normalization', () => {
  const prev = { ...process.env }
  try {
    process.env.INPUT_FOO = 'bar'
    process.env.INPUT_HELLO_WORLD = 'ok'
    assert.equal(getInput('foo'), 'bar')
    assert.equal(getInput('hello-world'), 'ok')
  }
  finally {
    process.env = prev
  }
})

test('setOutput appends in GitHub output file format', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oidc-action-'))
  const out = join(dir, 'output.txt')
  const prev = process.env.GITHUB_OUTPUT
  try {
    process.env.GITHUB_OUTPUT = out
    setOutput('name', 'value1')
    setOutput('name', 'value2')
    const content = readFileSync(out, 'utf8')
    assert.ok(content.includes('name<<__EOF__\nvalue1\n__EOF__'))
    assert.ok(content.includes('name<<__EOF__\nvalue2\n__EOF__'))
  }
  finally {
    if (prev === undefined)
      delete process.env.GITHUB_OUTPUT
    else process.env.GITHUB_OUTPUT = prev
    rmSync(dir, { recursive: true, force: true })
  }
})

test('appendSummary writes lines to summary file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oidc-action-'))
  const out = join(dir, 'summary.txt')
  const prev = process.env.GITHUB_STEP_SUMMARY
  try {
    process.env.GITHUB_STEP_SUMMARY = out
    appendSummary('hello')
    appendSummary('world')
    const content = readFileSync(out, 'utf8')
    assert.equal(content, 'hello\nworld\n')
  }
  finally {
    if (prev === undefined)
      delete process.env.GITHUB_STEP_SUMMARY
    else process.env.GITHUB_STEP_SUMMARY = prev
    rmSync(dir, { recursive: true, force: true })
  }
})

test('annotate formats GitHub logging command and escapes newlines', () => {
  const logs: string[] = []

  const prev = console.log
  try {
    console.log = (s: string) => {
      logs.push(String(s))
    }
    annotate('error', 'file.txt', 3, 7, 'line1\nline2')
    assert.equal(logs.length, 1)
    assert.ok(logs[0].startsWith('::error file=file.txt,line=3,col=7::'))
    assert.ok(logs[0].includes('line1%0Aline2'))
  }
  finally {
    console.log = prev
  }
})

test('log and logError write to console', () => {
  const outs: string[] = []
  const errs: string[] = []

  const prevLog = console.log
  const prevErr = console.error
  try {
    console.log = (s: string) => {
      outs.push(String(s))
    }
    console.error = (s: string) => {
      errs.push(String(s))
    }
    log('hello')
    logError(new Error('boom'))
    logError('world')
    assert.equal(outs[0], 'hello')
    assert.ok(errs[0].includes('boom') || errs[0].includes('Error'))
    assert.equal(errs[1], 'world')
  }
  finally {
    console.log = prevLog
    console.error = prevErr
  }
})
