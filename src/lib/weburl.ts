// What the web widget's address bar (and quick insert / the palette) does with
// whatever was typed: a URL, a bare host, a port, or a local .html file.

import { isAbsolutePath } from './backend'

/** `example.com` → `https://example.com`, `localhost:3000` / `3000` → http. */
export function normalizeUrl(raw: string): string {
  const v = raw.trim()
  if (!v) return ''
  if (/^https?:\/\//i.test(v)) return v
  if (/^localhost(:\d+)?(\/|$)/i.test(v) || /^\d+\.\d+\.\d+\.\d+/.test(v)) return `http://${v}`
  if (/^\d{2,5}(\/|$)/.test(v)) return `http://localhost:${v}`
  return `https://${v}`
}

export const isHttpUrl = (u: string) => /^https?:\/\//i.test(u)

/** A dev server on this machine: embeds directly, no proxy needed. */
export const isLocalUrl = (u: string) =>
  /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\d+\.\d+\.\d+\.\d+)([:/?#]|$)/i.test(u)

/** Starts with a host: `localhost:8080/…`, `example.com/…`, `10.0.0.2/…`. */
const HOST_FIRST = /^(localhost|[a-z0-9-]+(\.[a-z0-9-]+)+)(:\d+)?(\/|$)/i

/** A local file rather than a URL: no http(s) scheme, and either an absolute
 *  path or something ending in .htm/.html (e.g. `dist/index.html`) that
 *  doesn't start with a host (`localhost:8080/index.html` is a URL). */
export function looksLikeLocalFile(v: string): boolean {
  if (isHttpUrl(v)) return false
  if (isAbsolutePath(v)) return true
  if (!/\.html?($|[?#])/i.test(v)) return false
  // `index.html` is a file; `example.com/index.html` is a URL
  return /\.html?$/i.test(v.split(/[/?#]/)[0]) || !HOST_FIRST.test(v)
}

/** Is a palette query plausibly an address? (`example.com`, `localhost:5173`,
 *  `https://…`) — one word with a dot, a port or a scheme, no spaces. */
export function looksLikeUrl(v: string): boolean {
  const t = v.trim()
  if (!t || /\s/.test(t)) return false
  if (isHttpUrl(t)) return true
  if (/^localhost(:\d+)?(\/|$)/i.test(t)) return true
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/.*)?$/i.test(t) && /\.[a-z]{2,}(:\d+)?(\/|$)/i.test(t)
}

/** The host to title a widget with, or the input when it doesn't parse. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}
