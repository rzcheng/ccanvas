import { memo } from 'react'
import type { CanvasElement, WidgetElement } from '../lib/types'
import { WIDGET_ACCENT } from '../lib/types'
import { useAgents, useDisplayStatus } from '../lib/agents'
import { useAgentContext } from '../lib/context'
import { baseName } from '../lib/backend'
import { KIND_ICON } from '../widgets/widgetIcons'
import { IconDesktop } from './icons'
import { widgetGlyph, widgetType } from '../lib/layers'

// A static stand-in for one element on an overview sheet. Text only, a few
// dozen nodes at most: no xterm, Monaco or iframe, and nothing animates (an
// animation inside a 3D plane would repaint the whole sheet every frame).

const STATUS_WORD: Record<string, string> = {
  working: 'working',
  waiting: 'needs you',
  idle: 'idle',
  done: 'done',
  connecting: 'connecting',
  off: 'offline',
}

const accentOf = (el: WidgetElement) =>
  el.color ?? (el.kind === 'terminal' || el.kind === 'agent' ? 'var(--accent)' : WIDGET_ACCENT[el.kind])

export type ProxyMode = 'map' | 'detail'

export const LayerProxy = memo(function LayerProxy({
  el,
  rect,
  mode = 'map',
  dim,
  spot,
}: {
  el: CanvasElement
  /** past the per-sheet cap, draw a coloured box only */
  rect?: boolean
  /** 'map': a type glyph and status per widget (light, reads at any size);
   *  'detail': a faceplate with the title bar and a few lines of text */
  mode?: ProxyMode
  /** faded out: it doesn't match the overview's find */
  dim?: boolean
  /** where its label goes (fractions of the tile), clear of tiles above;
   *  null = covered everywhere, no label */
  spot?: [number, number, number] | null
}) {
  if (el.type === 'widget')
    return rect ? <ProxyRect el={el} /> : mode === 'map' ? <WidgetTile el={el} dim={dim} spot={spot} /> : <WidgetProxy el={el} dim={dim} spot={spot} />
  if (el.type === 'frame')
    return (
      <div
        className="pc-frame"
        style={{ left: el.x, top: el.y, width: el.w, height: el.h, borderColor: el.color }}
      >
        {el.title && <span style={{ color: el.color }}>{el.title}</span>}
      </div>
    )
  if (el.type === 'text')
    return (
      <div className="pc-text" style={{ left: el.x, top: el.y, fontSize: el.fontSize, color: el.color }}>
        {el.text}
      </div>
    )
  if (el.type === 'image')
    return <div className="pc-image" style={{ left: el.x, top: el.y, width: el.w, height: el.h }} />
  return null
})

function ProxyRect({ el }: { el: WidgetElement }) {
  return (
    <div
      className="pc pc--rect"
      style={{ left: el.x, top: el.y, width: el.w, height: el.h, ['--k2' as string]: accentOf(el) }}
    />
  )
}

function WidgetProxy({ el, dim, spot }: { el: WidgetElement; dim?: boolean; spot?: [number, number, number] | null }) {
  const isTerm = el.kind === 'terminal' || el.kind === 'agent'
  const Icon = KIND_ICON[el.kind]
  return (
    <div
      className={`pc${isTerm && el.color ? ' pc--tagged' : ''}${dim ? ' is-dim' : ''}`}
      data-pid={el.id}
      style={{ left: el.x, top: el.y, width: el.w, height: el.h, ['--k2' as string]: accentOf(el) }}
    >
      <div className="pc__bar">
        <span className="pc__icon">
          <Icon />
        </span>
        {isTerm && <ProxyLed id={el.id} />}
        <span className="pc__title">{el.title}</span>
        {el.kind === 'agent' && <ProxyContext el={el} />}
      </div>
      <div className="pc__body">{isTerm ? <TermLines el={el} /> : <OtherLines el={el} />}</div>
      <div
        className={`pc__far${spot === null ? ' pc__far--hidden' : ''}`}
        style={spot ? ({ '--sx': `${spot[0] * 100}%`, '--sy': `${spot[1] * 100}%`, '--sw': `${spot[2] * 100}%` } as React.CSSProperties) : undefined}
      >
        {isTerm ? (
          <ProxyLed id={el.id} />
        ) : (
          <span className="pc__icon">
            <Icon />
          </span>
        )}
        <span>{el.title}</span>
      </div>
    </div>
  )
}

/** Glyph component for a widget: the desktop mirror gets its own. */
function glyphFor(el: WidgetElement) {
  return widgetGlyph(el) === 'mirror' ? IconDesktop : KIND_ICON[el.kind]
}

/** Map mode: a tinted tile with the widget's type glyph and status, sized
 *  for the screen (counter-scaled by --fs) so it reads at any zoom. */
function WidgetTile({ el, dim, spot }: { el: WidgetElement; dim?: boolean; spot?: [number, number, number] | null }) {
  const isTerm = el.kind === 'terminal' || el.kind === 'agent'
  const Icon = glyphFor(el)
  return (
    <div
      className={`pt${dim ? ' is-dim' : ''}`}
      data-pid={el.id}
      style={{ left: el.x, top: el.y, width: el.w, height: el.h, ['--k2' as string]: accentOf(el) }}
    >
      {isTerm ? <TileStatus id={el.id} /> : null}
      <div
        className={`pt__mark${spot === null ? ' pt__mark--hidden' : ''}`}
        style={spot ? ({ '--sx': `${spot[0] * 100}%`, '--sy': `${spot[1] * 100}%`, '--sw': `${spot[2] * 100}%` } as React.CSSProperties) : undefined}
      >
        <span className="pt__icon">
          <Icon />
        </span>
        <span className="pt__name">{el.title}</span>
        <span className="pt__type">{widgetType(el)}</span>
      </div>
    </div>
  )
}

/** A terminal's status as the tile's state class (border tint) and LED. */
function TileStatus({ id }: { id: string }) {
  const s = useDisplayStatus(id) ?? 'off'
  return <span className={`pt__led pc__led pc__led--${s} pt__led--${s}`} />
}

function ProxyLed({ id }: { id: string }) {
  const s = useDisplayStatus(id) ?? 'off'
  return <span className={`pc__led pc__led--${s}`} />
}

function ProxyContext({ el }: { el: WidgetElement }) {
  const ctx = useAgentContext(el.cwd, el.sessionId, el.model)
  if (!ctx) return null
  return <span className="pc__ctx">{Math.round(ctx.pct)}%</span>
}

function TermLines({ el }: { el: WidgetElement }) {
  const s = useDisplayStatus(el.id) ?? 'off'
  const line = useAgents((st) => st.lastLine[el.id])
  return (
    <>
      <div className={`pc__line pc__line--${s}`}>{STATUS_WORD[s] ?? s}</div>
      {line && <div className="pc__line">{line}</div>}
      {el.cwd && <div className="pc__line pc__line--dim">{baseName(el.cwd)}</div>}
    </>
  )
}

function OtherLines({ el }: { el: WidgetElement }) {
  const lines: string[] = []
  if (el.kind === 'note' && el.note)
    lines.push(
      ...el.note
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, 6),
    )
  else if (el.url) lines.push(el.url)
  else if (el.path) lines.push(baseName(el.path), el.path)
  else if (el.cmd) lines.push(el.cmd)
  else if (el.cwd) lines.push(baseName(el.cwd))
  return (
    <>
      {lines.map((l, i) => (
        <div key={i} className={`pc__line${i ? ' pc__line--dim' : ''}`}>
          {l}
        </div>
      ))}
    </>
  )
}
