// The real browser behind a focused web widget (desktop app only).
//
// On the canvas a web widget is an <iframe>, which can follow the board's CSS
// transforms. A native webview can't: it's a plain rectangle drawn on top of
// the whole page. So it is only used in focus mode, where the widget sits in a
// fixed, untransformed box. This hook keeps one native view (Rust side:
// src-tauri/src/native_view.rs) exactly over a placeholder element:
//   • it opens once the focus flight has landed (the placeholder is at 100%
//     scale and holding still), and closes the moment focus moves on;
//   • it follows the placeholder's rect every frame (window resize, focus
//     strip or chrome changes), stopping short of the floating toolbar along
//     the bottom edge;
//   • it hides whenever anything else in the page covers the placeholder
//     (menus, the command palette, popovers: being native, it would sit on
//     top of them) and while the window isn't visible.
// Only the focused widget mounts it, so at most one native view is alive.

import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { isTauri } from './backend'

/** Can this build host a native child webview? (desktop app only) */
export function nativeViewSupported(): boolean {
  return isTauri() && typeof navigator !== 'undefined' && !/Android|iPhone|iPad/i.test(navigator.userAgent)
}

type Rect = { x: number; y: number; w: number; h: number }

export type NativeViewState = 'off' | 'opening' | 'live' | 'failed'

export type NativeViewHandlers = {
  /** the page navigated (or started/stopped loading) */
  onNav?: (url: string, loading: boolean) => void
  /** the page asked for a new window (target=_blank, window.open) */
  onNewWindow?: (url: string) => void
  /** ⌘⇧↵ pressed inside the page (keys there never reach the canvas) */
  onExitFocus?: () => void
}

type NavPayload = { id: string; url: string; loading: boolean }
type IdUrl = { id: string; url: string }

const sameRect = (a: Rect | null, b: Rect) =>
  !!a && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.w - b.w) < 0.5 && Math.abs(a.h - b.h) < 0.5

/** Grid spacing (px) for the "is anything covering it?" probe: fine enough to
 *  catch a small context menu, coarse enough to stay cheap. */
const PROBE_STEP = 80

/** How tall a strip along the bottom may hold floating chrome (the toolbar,
 *  the zoom controls) that the view stops short of instead of hiding. */
const CHROME_BAND = 72

/** The element that sits over `host` at a probe point: the hit's outermost
 *  ancestor that isn't also an ancestor of `host` (e.g. the whole toolbar). */
function overlayOf(hit: Element, host: HTMLElement): Element {
  let el = hit
  while (el.parentElement && !el.parentElement.contains(host)) el = el.parentElement
  return el
}

/**
 * Does anything in the page sit over `host`? Probes a grid of points; each
 * must land on the placeholder itself (or the widget's own click shield).
 * Returns null when something covers it (a menu, the palette: hide the view),
 * else how many px to trim off its bottom so it ends above the floating chrome
 * along the bottom edge (0 when nothing is there).
 */
function probe(host: HTMLElement, r: DOMRect): number | null {
  const widget = host.closest('.widget')
  const cols = Math.max(2, Math.ceil(r.width / PROBE_STEP) + 1)
  const rows = Math.max(2, Math.ceil(r.height / PROBE_STEP) + 1)
  let trim = 0
  for (let i = 0; i < cols; i++)
    for (let j = 0; j <= rows; j++) {
      const x = r.left + 2 + ((r.width - 4) * i) / (cols - 1)
      // the extra last row sits just inside the bottom band
      const y = j === rows ? r.bottom - 24 : r.top + 2 + ((r.height - 4) * j) / (rows - 1)
      const hit = document.elementFromPoint(x, y)
      if (!hit) continue // off-window
      if (host.contains(hit)) continue
      if (widget?.contains(hit) && hit.closest('.widget__shield')) continue
      const top = overlayOf(hit, host).getBoundingClientRect().top
      if (top < r.bottom - CHROME_BAND) return null
      trim = Math.max(trim, r.bottom - top + 8)
    }
  return trim
}

/** Laid out at its final size, no flight transform or clip in progress? */
function settled(host: HTMLElement, r: DOMRect): boolean {
  if (Math.abs(r.width - host.offsetWidth) > 0.5 || Math.abs(r.height - host.offsetHeight) > 0.5) return false
  const widget = host.closest<HTMLElement>('.widget')
  return !widget?.style.clipPath
}

/**
 * Keep a native view over `hostRef` while `want` is true. `url` is where it
 * opens; later changes to `url` don't reload it (drive it with the returned
 * controls). When it closes, `onClose` gets the last URL it showed.
 */
export function useNativeView(
  id: string,
  url: string,
  want: boolean,
  hostRef: React.RefObject<HTMLElement | null>,
  onClose: (lastUrl: string | null) => void,
  handlers: NativeViewHandlers,
) {
  const [state, setState] = useState<NativeViewState>('off')
  const [shown, setShown] = useState(false)
  const latest = useRef({ url, onClose, handlers })
  latest.current = { url, onClose, handlers }

  // events from the native side, for this widget only
  useEffect(() => {
    if (!want || !nativeViewSupported()) return
    const offs = [
      listen<NavPayload>('native-view:nav', (e) => {
        if (e.payload.id === id) latest.current.handlers.onNav?.(e.payload.url, e.payload.loading)
      }),
      listen<IdUrl>('native-view:new-window', (e) => {
        if (e.payload.id === id) latest.current.handlers.onNewWindow?.(e.payload.url)
      }),
      listen<{ id: string }>('native-view:exit-focus', (e) => {
        if (e.payload.id === id) latest.current.handlers.onExitFocus?.()
      }),
    ]
    return () => offs.forEach((p) => void p.then((off) => off()))
  }, [want, id])

  useEffect(() => {
    if (!want || !nativeViewSupported()) {
      setState('off')
      return
    }
    let alive = true
    let opened = false
    let opening = false
    let sentRect: Rect | null = null
    let visible = false
    // px trimmed off the bottom for floating chrome; null: covered, keep hidden
    let trim: number | null = 0
    let stillFrames = 0
    let lastBox: Rect | null = null
    let frame = 0
    let raf = 0

    const tick = () => {
      raf = requestAnimationFrame(tick)
      const host = hostRef.current
      if (!host) return
      const dr = host.getBoundingClientRect()
      const box = { x: dr.left, y: dr.top, w: dr.width, h: dr.height }
      const moved = !sameRect(lastBox, box)
      stillFrames = moved ? 0 : stillFrames + 1
      lastBox = box
      frame++
      // the probe costs a grid of hit tests: run it a few times a second, and
      // straight away whenever the box moved
      if (moved || frame % 8 === 0) trim = probe(host, dr)
      const rect = { ...box, h: box.h - (trim ?? 0) }
      // wait for the flight in to land (and, to open, hold still a moment)
      const ready = settled(host, dr) && rect.w > 40 && rect.h > 40
      const show = ready && !document.hidden && trim !== null
      if (!opened) {
        if (!show || stillFrames < 2 || opening) return
        opening = true
        setState('opening')
        void invoke('native_view_open', { id, url: latest.current.url, ...rect })
          .then(() => {
            if (!alive) {
              void invoke('native_view_close', { id })
              return
            }
            opened = true
            visible = true
            sentRect = rect
            setState('live')
            setShown(true)
          })
          .catch(() => {
            if (alive) setState('failed')
            cancelAnimationFrame(raf)
          })
        return
      }
      if (show && !sameRect(sentRect, rect)) {
        sentRect = rect
        void invoke('native_view_bounds', { id, ...rect })
      }
      if (show !== visible) {
        visible = show
        setShown(show)
        void invoke('native_view_visible', { id, visible: show })
      }
    }
    raf = requestAnimationFrame(tick)

    // hide at once when the window goes away, without waiting for a frame
    // (hidden windows get no animation frames)
    const onVis = () => {
      if (document.hidden && opened && visible) {
        visible = false
        setShown(false)
        void invoke('native_view_visible', { id, visible: false })
      }
    }
    document.addEventListener('visibilitychange', onVis)

    return () => {
      alive = false
      cancelAnimationFrame(raf)
      document.removeEventListener('visibilitychange', onVis)
      setShown(false)
      if (opened || opening)
        void invoke<string | null>('native_view_close', { id })
          .then((last) => latest.current.onClose(last ?? null))
          .catch(() => latest.current.onClose(null))
    }
    // `url` is only where the view opens; later navigation goes through the controls
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [want, id])

  const live = state === 'live'
  return {
    state,
    /** the native view is on screen right now (not hidden under a menu) */
    shown: live && shown,
    navigate: (to: string) => live && void invoke('native_view_navigate', { id, url: to }),
    back: () => live && void invoke('native_view_go', { id, action: 'back' }),
    forward: () => live && void invoke('native_view_go', { id, action: 'forward' }),
    reload: () => live && void invoke('native_view_go', { id, action: 'reload' }),
  }
}
