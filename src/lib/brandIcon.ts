// The real icon for a widget, where there is one: a web page's own site icon
// (of the page it is on now, not the one it was made with), or the icon of
// the app it stands for (Spotify or Music for Now playing, VS Code, Claude).
// Shown in the title bar, on the zoomed-out card and on the layers overview's
// tiles; until it has loaded (or where there is none) the kind's own glyph
// stands in.
//
// Icons are fetched by the desktop app (site_icon.rs: from the site itself,
// never an icon service) and cached there per host or app, on disk; here they
// are cached in memory too, so every card asks once per host.

import { create } from 'zustand'
import { useEffect, useSyncExternalStore } from 'react'
import type { WidgetElement } from './types'
import { invoke } from '@tauri-apps/api/core'
import { isTauri } from './backend'
import { isHttpUrl, isLocalUrl, searchQuery } from './weburl'

// ---- where each web widget is now ----

/** The page each web widget shows right now (it can move on from el.url:
 *  links, back and forward), by widget id. WebBody keeps it. */
export const useWebPages = create<{ at: Record<string, string> }>(() => ({ at: {} }))

export function setWebPage(id: string, url: string) {
  const at = useWebPages.getState().at
  if (at[id] !== url) useWebPages.setState({ at: { ...at, [id]: url } })
}

// ---- the caches ----

type Entry = string | null | Promise<string | null>
const cache = new Map<string, Entry>()
const listeners = new Set<() => void>()
let version = 0
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}
const bump = () => {
  version++
  listeners.forEach((l) => l())
}

function load(key: string, get: () => Promise<string | null>): string | null {
  const v = cache.get(key)
  if (typeof v === 'string' || v === null) return v
  if (v === undefined) {
    const p = get()
      .catch(() => null)
      .then((r) => {
        cache.set(key, r)
        bump()
        return r
      })
    cache.set(key, p)
  }
  return null
}

const hostKey = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return ''
  }
}

/** A site's icon (data: URL), or null while it loads or where there's none
 *  (local pages, outside the desktop app). */
function siteIcon(url: string): string | null {
  if (!isTauri() || !isHttpUrl(url) || isLocalUrl(url)) return null
  const host = hostKey(url)
  if (!host) return null
  return load(`site:${host}`, () => invoke<string | null>('site_icon', { url }))
}

/** An installed app's icon (data: URL), or null. */
function appIcon(bundleId: string): string | null {
  if (!isTauri()) return null
  return load(`app:${bundleId}`, () => invoke<string | null>('app_icon', { bundleId }))
}

// ---- which icon a widget gets ----

const NOW_PLAYING_APP: Record<string, string> = {
  spotify: 'com.spotify.client',
  music: 'com.apple.Music',
}
const VSCODE_APP = 'com.microsoft.VSCode'
const CLAUDE_APP = 'com.anthropic.claudefordesktop'

/** What a widget's icon comes from: a site, an app, GitHub's mark (drawn
 *  inline, widgetIcons.tsx), or nothing (its kind's glyph). */
export type BrandSource =
  | { kind: 'site'; url: string }
  | { kind: 'app'; bundleId: string; fallback?: 'claude' }
  | { kind: 'github' }
  | null

export function brandSource(el: WidgetElement, page?: string, npSource?: string | null): BrandSource {
  switch (el.kind) {
    case 'web': {
      if (el.path) return null
      const url = page ?? el.url
      if (!url || isLocalUrl(url)) return null
      // a search shows the search engine's icon
      return { kind: 'site', url: searchQuery(url) != null ? 'https://www.google.com/' : url }
    }
    case 'nowplaying':
      return npSource && NOW_PLAYING_APP[npSource] ? { kind: 'app', bundleId: NOW_PLAYING_APP[npSource] } : null
    case 'vscode':
      return { kind: 'app', bundleId: VSCODE_APP }
    case 'agent':
      // Claude Code (the CLI) wears Claude's icon; Codex keeps the glyph
      return el.cli === 'codex' ? null : { kind: 'app', bundleId: CLAUDE_APP, fallback: 'claude' }
    case 'claude':
      return { kind: 'app', bundleId: CLAUDE_APP, fallback: 'claude' }
    case 'transcript':
      return el.mirrorOf === 'desktop' ? { kind: 'app', bundleId: CLAUDE_APP, fallback: 'claude' } : null
    case 'pr':
    case 'issues':
    case 'runs':
      return { kind: 'github' }
    default:
      return null
  }
}

/** The image for a source: a data: URL once loaded, else null. */
export function brandImage(src: BrandSource): string | null {
  if (!src) return null
  if (src.kind === 'site') return siteIcon(src.url)
  if (src.kind === 'app') return appIcon(src.bundleId)
  return null
}

/** Re-render when any icon arrives. */
export function useBrandIcons(): number {
  return useSyncExternalStore(subscribe, () => version)
}

/** The page a web widget is on now (el.url until it has moved on). */
export function useWebPage(el: WidgetElement): string | undefined {
  const at = useWebPages((s) => (el.kind === 'web' ? s.at[el.id] : undefined))
  return at ?? el.url
}

/** Ask for an icon ahead of time (a web widget as soon as its page changes),
 *  so cards and tiles have it by the time they show. */
export function usePrefetchSiteIcon(url: string | undefined) {
  useEffect(() => {
    if (url) siteIcon(url)
  }, [url])
}
