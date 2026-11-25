import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { WidgetElement } from '../lib/types'
import { useStore } from '../store/workspace'
import {
  previewProxy,
  openExternal,
  proxyUrl,
  playerUrl,
  pickPath,
  readFile,
  watchPath,
  resolvePath,
  baseName,
  isTauri,
} from '../lib/backend'
import {
  normalizeUrl,
  isHttpUrl,
  isLocalUrl,
  looksLikeLocalFile,
  hostOf,
  videoEmbed,
  appOnlySite,
} from '../lib/weburl'
import { nativeViewSupported, useNativeView } from '../lib/nativeView'
import { focusWidget, toggleFocus } from '../lib/view'
import { useFocusSlot, stopCanvas } from '../ui/focusSlots'
import { IconReload, IconWeb, IconFile, IconBack, IconForward, IconExternal } from '../ui/icons'

// Web widget. Two modes, stored on the same widget (setting one clears the other):
//   • URL  (el.url)  — an http(s) page. On the canvas it's an <iframe>: local
//     dev servers embed directly, remote sites load through the preview proxy
//     (framing headers stripped, no cookies: a preview). Focused in the desktop
//     app, a real native browser takes over the body (lib/nativeView.ts), with
//     one persistent profile so logins stick.
//     Full JS apps don't survive the preview, so video pages (YouTube, Vimeo)
//     play in the site's own embeddable player instead, and the rest of such a
//     site (appOnlySite) shows a card that sends you to focus mode.
//   • File (el.path) — a local .html file rendered via the iframe's srcDoc from
//     its contents (read through the backend), watched on disk for live reload.

/** What a video player's frame may do (the player page passes it on). */
const PLAYER_ALLOW = 'autoplay; encrypted-media; fullscreen; picture-in-picture'

const SANDBOX =
  'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock allow-popups-to-escape-sandbox allow-presentation'

/** The default title, replaced by the page's host once there is one. */
const DEFAULT_TITLE = 'web'

type History = { list: string[]; at: number }

export function WebBody({ el, active }: { el: WidgetElement; active: boolean }) {
  const mutateElement = useStore((s) => s.mutateElement)
  const focused = useStore((s) => s.focus?.id === el.id)
  const [input, setInput] = useState(el.url ?? el.path ?? '')
  // where the page is now (the bar shows it unless you're typing)
  const [current, setCurrent] = useState(el.url ?? '')
  const [hist, setHist] = useState<History>(() => ({ list: el.url ? [el.url] : [], at: 0 }))
  const [loading, setLoading] = useState(false)
  const [proxyBase, setProxyBase] = useState<string | null>(null)
  const [fileHtml, setFileHtml] = useState<string | null>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const urlRef = useRef<HTMLInputElement>(null)
  const editing = useRef(false)

  const toolsSlot = useFocusSlot('tools')
  const inStrip = focused && !!toolsSlot
  const fileMode = !!el.path
  const abs = resolvePath(el.cwd, el.path ?? '')

  useEffect(() => {
    setInput(el.url ?? el.path ?? '')
    setCurrent(el.url ?? '')
    setHist((h) => (el.url && h.list[h.at] !== el.url ? push(h, el.url) : h))
  }, [el.url, el.path])

  // a fresh widget opens with its address bar ready to type into
  useEffect(() => {
    if (!el.url && !el.path) requestAnimationFrame(() => urlRef.current?.focus())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    let alive = true
    void previewProxy().then((base) => alive && setProxyBase(base))
    return () => {
      alive = false
    }
  }, [])

  // ---- the native browser (focus mode, desktop app) ----
  const nativeWanted = focused && !fileMode && isHttpUrl(current) && nativeViewSupported()
  const native = useNativeView(
    el.id,
    current,
    nativeWanted,
    hostRef,
    (last) => {
      // keep where you left off; only the URL is ever saved (and not once
      // the widget has switched to showing a local file)
      const now = stored(el.id)
      if (now && !now.path && last && isHttpUrl(last) && last !== now.url)
        mutateElement(el.id, (w) => {
          ;(w as WidgetElement).url = last
        })
    },
    {
      onNav: (url, isLoading) => {
        setLoading(isLoading)
        setCurrent(url)
        if (!editing.current) setInput(url)
      },
      onNewWindow: (url) => openBeside(el.id, url),
      onExitFocus: () => useStore.getState().exitFocus(),
    },
  )
  const nativeLive = native.state === 'live' || native.state === 'opening'

  // the preview proxy reports in-page link clicks so the bar and history follow
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return
      const d = e.data as { type?: unknown; url?: unknown } | null
      if (!d || d.type !== 'ccanvas-web-nav' || typeof d.url !== 'string' || !isHttpUrl(d.url)) return
      const url = d.url
      setCurrent(url)
      if (!editing.current) setInput(url)
      setHist((h) => (h.list[h.at] === url ? h : push(h, url)))
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  // file mode: load the file's contents and re-load whenever it changes on disk
  const loadFile = useCallback(async () => {
    if (!abs) return
    const content = await readFile(abs)
    setFileHtml((prev) => (content !== prev ? content : prev))
  }, [abs])

  useEffect(() => {
    if (!el.path) {
      setFileHtml(null)
      return
    }
    void loadFile()
    let dispose: (() => void) | null = null
    let cancelled = false
    void watchPath(abs, () => void loadFile()).then((d) => {
      if (cancelled) d()
      else dispose = d
    })
    return () => {
      cancelled = true
      dispose?.()
    }
  }, [el.path, abs, loadFile])

  const setFile = (p: string) =>
    mutateElement(el.id, (w) => {
      const x = w as WidgetElement
      x.path = p
      x.url = undefined
      x.title = baseName(p)
    })

  // navigate the bar: route to file mode or URL mode based on the input
  const go = (raw: string) => {
    const v = raw.trim()
    if (!v) return
    if (looksLikeLocalFile(v)) {
      setInput(v)
      setFile(v)
      return
    }
    const url = normalizeUrl(v)
    setInput(url)
    if (native.state === 'live') {
      native.navigate(url)
      return
    }
    setCurrent(url)
    setHist((h) => push(h, url))
    mutateElement(el.id, (w) => {
      const x = w as WidgetElement
      x.url = url
      x.path = undefined
      if (!x.title || x.title === DEFAULT_TITLE || x.title === 'web preview') x.title = hostOf(url)
    })
  }

  // file button: native open dialog filtered to HTML
  const openLocalFile = async () => {
    const p = await pickPath({ name: 'HTML', extensions: ['html', 'htm'] })
    if (p) setFile(p)
  }

  const proxied = !!proxyBase && isHttpUrl(current) && !isLocalUrl(current)
  // a video plays in its site's player: in the desktop app through the proxy's
  // player page (it needs a referrer), in a browser framed directly
  const embed = fileMode ? null : videoEmbed(current)
  const appOnly = fileMode ? null : appOnlySite(current)
  const frameSrc = !current
    ? ''
    : embed
      ? isTauri() && proxyBase
        ? playerUrl(proxyBase, embed)
        : embed
      : proxied
        ? proxyUrl(proxyBase!, current)
        : current
  const externalTarget = fileMode ? abs : current

  const step = (d: 1 | -1) => {
    if (native.state === 'live') return d < 0 ? native.back() : native.forward()
    const at = hist.at + d
    if (at < 0 || at >= hist.list.length) return
    setHist({ ...hist, at })
    setCurrent(hist.list[at])
    setInput(hist.list[at])
  }
  const reload = () => {
    if (fileMode) void loadFile()
    else if (native.state === 'live') native.reload()
    else if (frameRef.current) frameRef.current.src = frameSrc
  }
  const canBack = nativeLive || (!fileMode && hist.at > 0)
  const canForward = nativeLive || (!fileMode && hist.at < hist.list.length - 1)

  // quietly say what you're looking at: a preview on the canvas, the real
  // browser in focus mode, or a preview in focus when no browser is available
  const remote = !fileMode && isHttpUrl(current) && !isLocalUrl(current)
  const fallback = focused && !fileMode && isHttpUrl(current) && !nativeLive
  const fallbackNote = !isTauri()
    ? 'Preview only. The full browser is in the desktop app.'
    : native.state === 'failed'
      ? "Couldn't open the browser view here, so this is the preview."
      : null

  // in focus mode the bar moves into the focus strip, the one bar there
  // (focusSlots.ts), and the page sits flush under it
  const bar = (
    <div className={`web__bar${inStrip ? ' web__bar--strip' : ''}`} {...(inStrip ? stopCanvas : {})}>
      <button className="web__nav" title="Back" disabled={!canBack} onClick={() => step(-1)}>
        <IconBack />
      </button>
      <button className="web__nav" title="Forward" disabled={!canForward} onClick={() => step(1)}>
        <IconForward />
      </button>
      <button
        className={`web__nav${loading && nativeLive ? ' web__nav--busy' : ''}`}
        title="Reload"
        onClick={reload}
      >
        <IconReload />
      </button>
      <input
        ref={urlRef}
        className="web__url"
        value={input}
        placeholder="Address, localhost:3000 or ./index.html"
        spellCheck={false}
        onFocus={(e) => {
          editing.current = true
          e.currentTarget.select()
        }}
        onBlur={() => {
          editing.current = false
        }}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') {
            go(input)
            e.currentTarget.blur()
          } else if (e.key === 'Escape') {
            setInput(fileMode ? (el.path ?? '') : current)
            e.currentTarget.blur()
          }
        }}
        onPointerDown={(e) => e.stopPropagation()}
      />
      {fileMode && (
        <span className="web__tag web__tag--live" title="Live-reloading on file change">
          <span className="web__live-dot" />
          live
        </span>
      )}
      {remote && !focused && (
        <button
          className="web__tag"
          title={
            nativeViewSupported()
              ? 'On the canvas this is a preview. Focus the widget (⌘⇧↵) for the full browser, with your logins.'
              : 'On the canvas this is a preview: no logins, and some pages won’t work.'
          }
          onClick={() => nativeViewSupported() && toggleFocus(el.id)}
        >
          preview
        </button>
      )}
      {!inStrip && (
        <button
          className={`web__nav${fileMode ? ' web__nav--on' : ''}`}
          title="Open a local HTML file (live-reloads on save)"
          onClick={() => void openLocalFile()}
        >
          <IconFile />
        </button>
      )}
      <button
        className="web__nav"
        title="Open in your browser"
        disabled={!externalTarget}
        onClick={() => externalTarget && void openExternal(externalTarget)}
      >
        <IconExternal />
      </button>
    </div>
  )

  return (
    <div className="web">
      {inStrip ? createPortal(bar, toolsSlot!) : bar}
      {fallback && fallbackNote && <div className="web__note">{fallbackNote}</div>}
      {fileMode ? (
        fileHtml != null ? (
          <iframe
            ref={frameRef}
            className="web__frame"
            srcDoc={fileHtml}
            title={el.title}
            sandbox={SANDBOX}
            style={{ pointerEvents: active ? 'auto' : 'none' }}
          />
        ) : (
          <div className="web__empty">
            <IconFile className="" />
            <div>
              loading <code>{baseName(el.path ?? '')}</code>…
              <br />
              if this persists, the backend is offline or the file is missing.
            </div>
          </div>
        )
      ) : nativeWanted && native.state !== 'failed' ? (
        // the native view is drawn over this box; it shows through while the
        // view is hidden under a menu or still opening
        <div ref={hostRef} className="web__native" style={{ pointerEvents: 'auto' }}>
          {!native.shown && <span>{hostOf(current)}</span>}
        </div>
      ) : appOnly ? (
        <div className="web__empty web__apponly">
          <IconWeb className="" />
          <div>
            {appOnly} needs a full browser; the canvas preview can't run it.
            <br />
            {nativeViewSupported()
              ? 'Browse it in focus mode. A video you open there plays right here.'
              : 'Paste a video link to play it here, or open the site in your browser.'}
          </div>
          <button
            className="web__cta"
            onClick={() =>
              nativeViewSupported() ? toggleFocus(el.id) : void openExternal(current)
            }
          >
            {nativeViewSupported() ? 'Open in focus mode' : 'Open in your browser'}
          </button>
        </div>
      ) : frameSrc ? (
        <iframe
          ref={frameRef}
          className="web__frame"
          src={frameSrc}
          title={el.title}
          sandbox={SANDBOX}
          allow={embed ? PLAYER_ALLOW : undefined}
          allowFullScreen={!!embed}
          style={{ pointerEvents: active || focused ? 'auto' : 'none' }}
        />
      ) : (
        <div className="web__empty">
          <IconWeb className="" />
          <div>
            Type an address above, or open a local <b>.html</b> file with the file button (it
            live-reloads on save).
            <br />
            Local dev servers embed directly. Other sites show as a preview
            {nativeViewSupported() ? '; focus the widget for the full browser.' : '.'}
          </div>
        </div>
      )}
    </div>
  )
}

function push(h: History, url: string): History {
  const list = [...h.list.slice(0, h.at + 1), url]
  return { list, at: list.length - 1 }
}

/** The widget as stored right now (it may have moved on since render). */
function stored(id: string): WidgetElement | undefined {
  const w = useStore.getState().active()?.elements.find((e) => e.id === id)
  return w && w.type === 'widget' ? w : undefined
}

/** A page asked for a new window: open it in a new web widget beside this one
 *  and focus that (focus swaps; the old one flies home). */
function openBeside(fromId: string, url: string) {
  if (!isHttpUrl(url)) return
  const st = useStore.getState()
  const from = st.active()?.elements.find((e) => e.id === fromId)
  if (!from || from.type !== 'widget') return
  const w = Math.max(from.w, 640)
  const h = Math.max(from.h, 480)
  const id = st.spawnWidget('web', from.x + from.w + 40 + w / 2, from.y + h / 2, {
    url,
    title: hostOf(url),
    w,
    h,
  })
  focusWidget(id)
}
