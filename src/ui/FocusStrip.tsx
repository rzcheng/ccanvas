// The strip along the top of focus mode: a way back to the canvas, where you
// are (tab › stack › widget), and a "jack" for every terminal and agent on the
// layer, numbered like ⌘1–9, with its live status, then one (unnumbered) for
// each desktop-app mirror. A jack swaps which widget is focused. One that needs
// you lights its jack, and a chip on the right takes you to it. Nothing ever
// swaps in on its own.

import { useStore, selectActive } from '../store/workspace'
import { useAgents } from '../lib/agents'
import { focusWidget, orderedMirrors, orderedTerminals, FOCUS_STRIP_H } from '../lib/view'
import { stacksOf } from '../lib/stacks'
import { StatusGlyph, StatusIcon } from '../widgets/widgetIcons'
import { IconBack, IconStack, IconUnfocus } from './icons'

export function FocusStrip() {
  const focusId = useStore((s) => s.focus?.id ?? null)
  // re-render when widgets come, go or are renamed
  const ws = useStore(selectActive)
  // terminals keep ⌘1–9's numbering; mirrors follow, unnumbered (read-only,
  // so not in the ⌘N / cycle order you type into)
  const terms = focusId ? orderedTerminals() : []
  const mirrors = focusId ? orderedMirrors() : []
  const numbered = Math.min(9, terms.length)
  const jacks = [...terms.slice(0, numbered), ...mirrors]
  const all = [...terms, ...mirrors]
  const allIds = all.map((t) => t.id)
  const waiting = useAgents((s) => allIds.filter((id) => id !== focusId && s.status[id] === 'waiting').join(','))
  if (!focusId) return null
  const el = ws.elements.find((e) => e.id === focusId)
  if (!el || el.type !== 'widget') return null
  const stack = el.stackId ? stacksOf(ws.elements).get(el.stackId) : undefined
  const waitingIds = waiting ? waiting.split(',') : []
  const exit = () => useStore.getState().exitFocus()

  return (
    <div className="focus-strip" style={{ height: FOCUS_STRIP_H }} onPointerDown={(e) => e.stopPropagation()}>
      <button className="focus-strip__back" title="Back to canvas (⌘⇧↵ or Esc)" onClick={exit}>
        <IconBack />
        Canvas
      </button>
      <span className="focus-strip__sep" />
      <span className="focus-strip__crumb">
        <span className="focus-strip__tab">{ws.name}</span>
        {stack && (
          <>
            <i>›</i>
            <span className="focus-strip__stack">
              <IconStack />
              {stack.title}
            </span>
          </>
        )}
        <i>›</i>
        <b>{el.title}</b>
      </span>
      <div className="focus-strip__jacks">
        {jacks.map((t, i) => (
          <button
            key={t.id}
            className={`focus-jack${t.id === focusId ? ' focus-jack--on' : ''}${
              waitingIds.includes(t.id) ? ' focus-jack--attn' : ''
            }${i >= numbered ? ' focus-jack--mirror' : ''}`}
            title={i < numbered ? `${t.title} (⌘${i + 1})` : `${t.title} (Claude app session)`}
            onClick={() => focusWidget(t.id)}
          >
            {i < numbered && <span className="focus-jack__n">{i + 1}</span>}
            <StatusIcon id={t.id} kind={t.kind} />
            <span className="focus-jack__t">{t.title}</span>
          </button>
        ))}
      </div>
      {waitingIds.length > 0 && (
        <button className="focus-strip__attn" onClick={() => focusWidget(waitingIds[0])}>
          <StatusGlyph status="waiting" />
          {waitingIds.length === 1
            ? `${all.find((t) => t.id === waitingIds[0])?.title ?? 'an agent'} needs you`
            : `${waitingIds.length} need you`}
        </button>
      )}
      <button className="focus-strip__exit" title="Back to canvas (⌘⇧↵)" onClick={exit}>
        <IconUnfocus />
      </button>
    </div>
  )
}
