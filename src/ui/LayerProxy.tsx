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
//  • the widget (--m): the real widget's look (its body colour, frame and
//    title bar, tint and folder included) crossfades in over the block, so
//    nothing snaps. Then --h wipes it away top-down to hand over to the real
//    widget underneath.
//
// --w, the tile's wash, types the text in a character at a time, line after
// line, with a block cursor (layers.css); each line carries its length
// (--n) for that. Run backwards, it backspaces.

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
        <div className="pt__real" />
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

/** A line's length, for typing it in a character at a time. */
const chars = (s: string) => ({ ['--n' as string]: Math.min(s.length, 120) })

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
  // the real title bar: a labelled terminal or agent is tinted, and the
  // folder follows the title (WidgetFrame)
  const tagged = (el.kind === 'terminal' || el.kind === 'agent') && !!el.color
  const folder = el.cwd ? el.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : null
  return (
    <div
      className={`pt${st ? ` pt--${st}` : ''}${dim ? ' is-dim' : ''}${tagged ? ' pt--tagged' : ''}`}
      data-pid={el.id}
      data-ord={ord}
      // a terminal or agent: on landing, its real output types in (LayerOverview)
      data-typed={el.kind === 'terminal' || el.kind === 'agent' ? '' : undefined}
      style={{ left: el.x, top: el.y, width: el.w, height: el.h, ['--k2' as string]: accentOf(el) }}
    >
      <div className="pt__fill" />
      <div className="pt__real" />
      <div className="pt__bar">
        {icon}
        <span className="pt__bt">{el.title}</span>
        {folder && <span className="pt__cwd">{folder}</span>}
      </div>
      {!noText && (
        <div className="pt__txt">
          <div className="pt__top">
            {icon}
            <span className="pt__tt" style={chars(el.title)}>
              <i>{el.title}</i>
            </span>
          </div>
          <span className="pt__tm" style={chars(meta)}>
            <i>{meta}</i>
          </span>
          <span className="pt__tls">
            {shownLines.map((l, i) => (
              <span key={i} className="pt__tl" style={chars(l)}>
                <i>{l}</i>
              </span>
            ))}
          </span>
        </div>
      )}
    </div>
  )
}
