import { describe, expect, it } from 'vitest'
import { hostOf, isLocalUrl, looksLikeLocalFile, looksLikeUrl, normalizeUrl } from './weburl'

describe('normalizeUrl', () => {
  it('adds the right scheme', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com')
    expect(normalizeUrl('localhost:3000/a')).toBe('http://localhost:3000/a')
    expect(normalizeUrl('5173')).toBe('http://localhost:5173')
    expect(normalizeUrl('10.0.0.2:8080')).toBe('http://10.0.0.2:8080')
    expect(normalizeUrl(' http://x.dev ')).toBe('http://x.dev')
    expect(normalizeUrl('')).toBe('')
  })
})

describe('isLocalUrl', () => {
  it('spots dev servers and nothing else', () => {
    expect(isLocalUrl('http://localhost:5173/')).toBe(true)
    expect(isLocalUrl('http://127.0.0.1')).toBe(true)
    expect(isLocalUrl('http://[::1]:3000/')).toBe(true)
    expect(isLocalUrl('https://example.com/')).toBe(false)
    expect(isLocalUrl('https://localhost.example.com/')).toBe(false)
  })
})

describe('looksLikeUrl', () => {
  it('takes addresses, not commands', () => {
    expect(looksLikeUrl('example.com')).toBe(true)
    expect(looksLikeUrl('docs.example.org/guide')).toBe(true)
    expect(looksLikeUrl('localhost:5173')).toBe(true)
    expect(looksLikeUrl('https://a.b')).toBe(true)
    expect(looksLikeUrl('new terminal')).toBe(false)
    expect(looksLikeUrl('save')).toBe(false)
    expect(looksLikeUrl('v1.2')).toBe(false)
  })
})

describe('looksLikeLocalFile', () => {
  it('takes html files and absolute paths', () => {
    expect(looksLikeLocalFile('dist/index.html')).toBe(true)
    expect(looksLikeLocalFile('/tmp/page')).toBe(true)
    expect(looksLikeLocalFile('https://example.com/index.html')).toBe(false)
    expect(looksLikeLocalFile('example.com')).toBe(false)
    expect(looksLikeLocalFile('localhost:8080/index.html')).toBe(false)
    expect(looksLikeLocalFile('example.com/about.html')).toBe(false)
    expect(looksLikeLocalFile('./index.html')).toBe(true)
    expect(looksLikeLocalFile('index.html')).toBe(true)
  })
})

it('hostOf falls back to the input', () => {
  expect(hostOf('https://example.com:8443/x')).toBe('example.com:8443')
  expect(hostOf('not a url')).toBe('not a url')
})
