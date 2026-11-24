import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { WidgetElement } from '../lib/types'
import { useStore, selectActive } from '../store/workspace'
import { isTauri, openExternal } from '../lib/backend'
import {
  useNowPlaying,
  setNowPlayingDemand,
  dropNowPlayingDemand,
  control,
  positionNow,
  SOURCE_LABEL,
  type NowPlaying,
  type Track,
} from '../lib/nowplaying'
import { IconMusic, IconPlay, IconPause, IconPrevTrack, IconNextTrack } from '../ui/icons'

// Now playing: the track Spotify or Music is on, with play/pause, previous and
// next. Reading and polling live in lib/nowplaying.ts; this widget only tells
// it whether it's on screen. Nothing it shows is saved with the canvas.

const AUTOMATION_SETTINGS = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation'

function fmt(ms: number): string {
  if (!(ms > 0)) return '0:00'
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor(s / 60) % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`
}

export function NowPlayingBody({ el, visible, far }: { el: WidgetElement; visible: boolean; far: boolean }) {
  useEffect(() => setNowPlayingDemand(el.id, visible), [el.id, visible])
  useEffect(() => () => dropNowPlayingDemand(el.id), [el.id])
  const np = useNowPlaying((s) => s.np)
  return (
    <>
      {np.kind === 'track' ? <Player t={np.track} /> : <Empty np={np} />}
      {far && visible && <FarCard np={np} />}
    </>
  )
}

function Artwork({ src, className }: { src: string | null; className: string }) {
  const [broken, setBroken] = useState(false)
  useEffect(() => setBroken(false), [src])
  return (
    <div className={className}>
      {src && !broken ? (
        <img src={src} alt="" draggable={false} onError={() => setBroken(true)} />
      ) : (
        <IconMusic />
      )}
    </div>
  )
}

function Player({ t }: { t: Track }) {
  const fill = useRef<HTMLDivElement>(null)
  // the line moves on its own between polls; each poll re-anchors it
  useLayoutEffect(() => {
    const node = fill.current
    if (!node) return
    const d = t.durationMs
    const pos = positionNow(t)
    const p = d > 0 ? Math.min(1, pos / d) : 0
    node.style.transform = `scaleX(${p})`
    if (!t.playing || d <= 0 || p >= 1) return
    const a = node.animate([{ transform: `scaleX(${p})` }, { transform: 'scaleX(1)' }], {
      duration: d - pos,
      easing: 'linear',
      fill: 'forwards',
    })
    return () => a.cancel()
  }, [t])

  const src = SOURCE_LABEL[t.source]
  return (
    <div className="np">
      <Artwork src={t.artwork} className="np__art" />
      <div className="np__main">
        <div className="np__meta">
          <div className="np__track" title={t.title}>
            {t.title || 'Untitled'}
          </div>
          {t.artist && (
            <div className="np__artist" title={t.artist}>
              {t.artist}
            </div>
          )}
          <div className="np__source" title={t.album || undefined}>
            {src}
            {!t.playing && ' · paused'}
          </div>
        </div>
        <div className="np__progress">
          <div className="np__fill" ref={fill} />
        </div>
        <div className="np__foot">
          <span className="np__time">{fmt(positionNow(t))}</span>
          <Controls t={t} className="np__controls" />
          <span className="np__time">{t.durationMs > 0 ? fmt(t.durationMs) : ''}</span>
        </div>
      </div>
    </div>
  )
}

function Controls({ t, className }: { t: Track; className: string }) {
  return (
    <div className={className}>
      <button className="np__btn" title="Previous" onClick={() => void control(t.source, 'previous')}>
        <IconPrevTrack />
      </button>
      <button
        className="np__btn np__btn--main"
        title={t.playing ? 'Pause' : 'Play'}
        onClick={() => void control(t.source, 'playpause')}
      >
        {t.playing ? <IconPause /> : <IconPlay />}
      </button>
      <button className="np__btn" title="Next" onClick={() => void control(t.source, 'next')}>
        <IconNextTrack />
      </button>
    </div>
  )
}

function Empty({ np }: { np: NowPlaying }) {
  let head = ''
  let sub = ''
  let action: React.ReactNode = null
  if (np.kind === 'idle') {
    head = 'Nothing playing'
    sub = 'Play something in Spotify or Music.'
  } else if (np.kind === 'denied') {
    head = `ccanvas can't see ${SOURCE_LABEL[np.source]}`
    sub = 'Allow it under Privacy & Security › Automation in System Settings.'
    action = (
      <button className="np__link" onClick={() => void openExternal(AUTOMATION_SETTINGS)}>
        Open System Settings
      </button>
    )
  } else if (np.kind === 'unsupported') {
    head = 'Now playing works on macOS for now'
    sub = isTauri() ? '' : 'Open this canvas in the desktop app to see what Spotify or Music is playing.'
  }
  return (
    <div className="np np--empty">
      <div className="np__art">
        <IconMusic />
      </div>
      <div className="np__main">
        {head && <div className="np__track">{head}</div>}
        {sub && <div className="np__hint">{sub}</div>}
        {action}
      </div>
    </div>
  )
}

// Zoomed far out: the artwork and the title, with the buttons over them on
// hover (a row wouldn't fit under the title at this size), sized in screen pixels like the
// terminal summary card so it stays readable.
function FarCard({ np }: { np: NowPlaying }) {
  const zoom = useStore((s) => selectActive(s).camera.zoom)
  const t = np.kind === 'track' ? np.track : null
  return (
    <div className="np-card" style={{ ['--z' as string]: zoom }}>
      <Artwork src={t?.artwork ?? null} className="np-card__art" />
      <div className="np-card__title">{t ? t.title || 'Untitled' : np.kind === 'idle' ? 'Nothing playing' : 'Now playing'}</div>
      {t && <Controls t={t} className="np-card__controls" />}
    </div>
  )
}
