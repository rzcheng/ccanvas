import { memo } from 'react'
import type { CanvasElement, WidgetElement } from '../lib/types'
import { WIDGET_ACCENT } from '../lib/types'
import { useAgents, useDisplayStatus } from '../lib/agents'
import { baseName } from '../lib/backend'
import { KIND_ICON, StatusGlyph, showsStatus } from '../widgets/widgetIcons'
import { IconDesktop } from './icons'
import { pathWithin, widgetGlyph, widgetType } from '../lib/layers'

// A static stand-in for one element on an overview sheet: a tile at the
// widget's own position and size. Text only, a handful of nodes: no xterm,
// Monaco or iframe.
//
// A tile has three faces, blended by custom properties the overview sets:
//  • the block (the fill): coloured by status, all that shows on a slat;
//  • the text (status icon, two-line title, meta and last line), faded by
//    the sheet's --txt, so it shows only while the sheet is nearly flat;
//  • the widget (--m): a 30px title bar like the real one grows in and the
//    text fades, as a dive lands. Then --h wipes the fill away top-down to
//    hand over to the real widget underneath.

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
  ord = 0,
  noText,
  home,
}: {
  el: CanvasElement
  /** past the per-sheet cap, draw the block only */
  rect?: boolean
  /** 'map': a title, a meta line and a last line; 'detail' (V): a few lines
   *  of what the widget shows */
  mode?: ProxyMode
  /** faded out: it doesn't match the overview's find */
  dim?: boolean
  /** its place in reading order on the sheet (the dive's sweep) */
  ord?: number
  /** a tile stacked above covers its top-left corner: no text */
  noText?: boolean
  /** the layer's folder: a widget from another project says where it's from */
  home?: string
}) {
  if (el.type === 'widget')
    return rect ? (
      <div
        className="pt pt--rect"
        data-pid={el.id}
        data-ord={ord}
        style={{ left: el.x, top: el.y, width: el.w, height: el.h, ['--k2' as string]: accentOf(el) }}
      >
        <div className="pt__fill" />
      </div>
    ) : (
      <WidgetTile el={el} mode={mode} dim={dim} ord={ord} noText={noText} home={home} />
    )
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

/** Glyph component for a widget: the desktop mirror gets its own. */
function glyphFor(el: WidgetElement) {
  return widgetGlyph(el) === 'mirror' ? IconDesktop : KIND_ICON[el.kind]
}

/** A few lines of what a non-terminal widget shows. */
function otherLines(el: WidgetElement): string[] {
  if (el.kind === 'note' && el.note)
    return el.note
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 6)
  if (el.url) return [el.url]
  if (el.path) return [baseName(el.path), el.path]
  if (el.cmd) return [el.cmd]
  if (el.cwd) return [baseName(el.cwd)]
  return []
}

function WidgetTile({
  el,
  mode,
  dim,
  ord,
  noText,
  home,
}: {
  el: WidgetElement
  mode: ProxyMode
  dim?: boolean
  ord: number
  noText?: boolean
  home?: string
}) {
  const live = showsStatus(el)
  const shown = useDisplayStatus(el.id)
  const lastLine = useAgents((s) => (live ? s.lastLine[el.id] : undefined))
  const st = live ? (shown ?? 'off') : null
  const Icon = glyphFor(el)
  const icon = live ? (
    <StatusGlyph status={st!} icon={<Icon />} className="pt__ic" />
  ) : (
    <span className="pt__ic">
      <Icon />
    </span>
  )
  // a widget moved here from another project keeps its folder: say so
  const guest = home && el.cwd && !pathWithin(home, el.cwd) ? baseName(el.cwd) : null
  const meta = widgetType(el) + (guest ? ` · ↗ ${guest}` : '')
  const lines = live
    ? [lastLine || STATUS_WORD[st!] || '', ...(mode === 'detail' && el.cwd ? [baseName(el.cwd)] : [])]
    : otherLines(el)
  const shownLines = mode === 'detail' ? lines.slice(0, 4) : lines.slice(0, 1)
  return (
    <div
      className={`pt${st ? ` pt--${st}` : ''}${dim ? ' is-dim' : ''}`}
      data-pid={el.id}
      data-ord={ord}
      style={{ left: el.x, top: el.y, width: el.w, height: el.h, ['--k2' as string]: accentOf(el) }}
    >
      <div className="pt__fill" />
      <div className="pt__bar">
        {icon}
        <span className="pt__bt">{el.title}</span>
      </div>
      {!noText && (
        <div className="pt__txt">
          <div className="pt__top">
            {icon}
            <span className="pt__tt">{el.title}</span>
          </div>
          <span className="pt__tm">{meta}</span>
          <span className="pt__tls">
            {shownLines.map((l, i) => (
              <span key={i} className="pt__tl">
                {l}
              </span>
            ))}
          </span>
        </div>
      )}
    </div>
  )
}
