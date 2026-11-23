import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WidgetElement } from '../lib/types'
import { useStore, selectActive } from '../store/workspace'
import {
  transcriptPathFor,
  parseTranscript,
  readTranscriptChunk,
  type TranscriptTurn,
} from '../lib/transcript'
import { watchPath, baseName, openExternal } from '../lib/backend'
import { renderMarkdown } from '../lib/markdown'
import { IconReload } from '../ui/icons'
import '../styles/agent-tools.css'

// Renders an agent's real conversation, read from its session JSONL transcript —
// the clean version, free of the terminal's box-drawing chrome. Bound to an
// agent widget by id (el.agentId), or — for a desktop-app mirror
// (el.mirrorOf === 'desktop') — straight to el.cwd + el.sessionId. Follows the
// session live and lets you filter. Read-only either way.

// a mirror's first read starts this far from the end of a huge transcript
const MIRROR_TAIL_BYTES = 8 * 1024 * 1024

/** A message body rendered as markdown. Memoised per text, so appending turns
 *  to a long conversation doesn't re-render every earlier one. */
const MdText = memo(function MdText({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text])
  return (
    <div
      className="tx__md"
      // renderMarkdown escapes everything, then re-allows a safe tag subset
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        // a link would navigate the whole app away: open it in the browser
        const a = (e.target as HTMLElement).closest('a')
        if (!a) return
        e.preventDefault()
        const href = a.getAttribute('href') ?? ''
        if (/^https?:\/\//i.test(href)) void openExternal(href)
      }}
    />
  )
})

function ToolChip({ name, target }: { name: string; target?: string }) {
  const short = target
    ? target.length > 48
      ? '…' + target.slice(-46)
      : target
    : ''
  return (
    <span className="tx__tool" title={`${name}${target ? ' · ' + target : ''}`}>
      <span className="tx__tool-name">{name}</span>
      {short && <span className="tx__tool-target">{short}</span>}
    </span>
  )
}

export function TranscriptBody({ el }: { el: WidgetElement }) {
  // resolve the agent we mirror (live, so a self-healed session id is picked up)
  const agent = useStore((s) =>
    selectActive(s).elements.find(
      (e): e is WidgetElement => e.type === 'widget' && e.id === el.agentId,
    ),
  )
  const mirror = el.mirrorOf === 'desktop'
  const cwd = mirror ? el.cwd : (agent?.cwd ?? el.cwd)
  const sessionId = mirror ? el.sessionId : agent?.sessionId

  const [turns, setTurns] = useState<TranscriptTurn[]>([])
  const [path, setPath] = useState<string | null>(null)
  const [offline, setOffline] = useState(false)
  const [q, setQ] = useState('')
  const [autoscroll, setAutoscroll] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)

  // resolve the transcript path whenever the bound session changes
  useEffect(() => {
    let alive = true
    void transcriptPathFor(cwd, sessionId).then((p) => {
      if (alive) setPath(p)
    })
    return () => {
      alive = false
    }
  }, [cwd, sessionId])

  // Read incrementally: keep the byte offset parsed so far and parse only what
  // was appended (each line is one event, so appended turns just concatenate).
  // Desktop transcripts reach ~100 MB; re-reading them per write was too heavy.
  const offsetRef = useRef(0)
  const busyRef = useRef(false)
  // a change that arrives mid-read re-runs once that read finishes
  const pendingRef = useRef<'none' | 'more' | 'fresh'>('none')
  const pathRef = useRef(path)
  pathRef.current = path
  const tail = mirror ? MIRROR_TAIL_BYTES : undefined
  const [truncated, setTruncated] = useState(false)

  const read = useCallback(
    async (fresh = false) => {
      if (busyRef.current) {
        if (fresh) pendingRef.current = 'fresh'
        else if (pendingRef.current === 'none') pendingRef.current = 'more'
        return
      }
      busyRef.current = true
      try {
        let mode: 'none' | 'more' | 'fresh' = fresh ? 'fresh' : 'more'
        while (mode !== 'none') {
          const p = pathRef.current
          if (!p) break
          const from = mode === 'fresh' ? 0 : offsetRef.current
          const chunk = await readTranscriptChunk(p, from, tail)
          if (pathRef.current === p) {
            if (!chunk) setOffline(true)
            else {
              setOffline(false)
              const restart = from === 0 || chunk.reset
              offsetRef.current = chunk.next
              const added = chunk.text ? parseTranscript(chunk.text) : []
              if (restart) {
                setTruncated(chunk.truncated)
                setTurns(added)
              } else if (added.length) setTurns((t) => [...t, ...added])
            }
          }
          mode = pendingRef.current
          pendingRef.current = 'none'
        }
      } finally {
        busyRef.current = false
      }
    },
    [tail],
  )
  const reload = useCallback(() => read(true), [read])

  // initial load + live refresh on transcript writes
  useEffect(() => {
    if (!path) return
    void reload()
    let dispose: (() => void) | null = null
    let cancelled = false
    let t: ReturnType<typeof setTimeout> | null = null
    const onChange = () => {
      if (t) clearTimeout(t)
      t = setTimeout(() => void read(), 350)
    }
    void watchPath(path, onChange, 1500).then((d) => (cancelled ? d() : (dispose = d)))
    return () => {
      cancelled = true
      if (t) clearTimeout(t)
      dispose?.()
    }
  }, [path, reload, read])

  // keep pinned to the newest turn unless the user scrolls up
  useEffect(() => {
    if (autoscroll && scrollRef.current)
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [turns, autoscroll])

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase()
    if (!t) return turns
    return turns.filter(
      (m) =>
        m.text.toLowerCase().includes(t) ||
        m.tools.some((tool) => (tool.target ?? '').toLowerCase().includes(t)),
    )
  }, [turns, q])

  if (!el.agentId && !mirror) {
    return (
      <div className="tx tx--empty">
        Open this from an agent’s menu — “Open transcript” — to mirror its conversation.
      </div>
    )
  }

  return (
    <div className="tx">
      <div className="tx__bar">
        <input
          className="tx__search"
          placeholder="Filter conversation…"
          value={q}
          spellCheck={false}
          onChange={(e) => setQ(e.target.value)}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Escape') setQ('')
          }}
        />
        <span className="tx__count">{turns.length} msgs</span>
        <button
          className={`tx__btn${autoscroll ? ' tx__btn--on' : ''}`}
          title="Stick to newest"
          onClick={() => setAutoscroll((a) => !a)}
        >
          ↓
        </button>
        <button className="tx__btn" title="Reload" onClick={() => void reload()}>
          <IconReload />
        </button>
      </div>

      <div
        className="tx__scroll"
        ref={scrollRef}
        onScroll={(e) => {
          const n = e.currentTarget
          const atBottom = n.scrollHeight - n.scrollTop - n.clientHeight < 40
          setAutoscroll(atBottom)
        }}
      >
        {offline && mirror ? (
          <div className="tx__hint">
            transcript not found — the desktop session may have been deleted, or its folder
            moved
          </div>
        ) : offline ? (
          <div className="tx__hint">
            backend offline, or no transcript yet — run <code>npm run server</code> or use the
            desktop app
          </div>
        ) : filtered.length === 0 && !truncated ? (
          <div className="tx__hint">{q ? 'no matching messages' : 'no messages yet'}</div>
        ) : (
          <>
          {truncated && (
            <div className="tx__hint">earlier messages not loaded — this transcript is very large</div>
          )}
          {filtered.map((m, i) =>
            m.role === 'event' ? (
              <div key={i} className="tx__event" title={m.text}>
                {m.text}
              </div>
            ) : (
            <div key={i} className={`tx__msg tx__msg--${m.role}`}>
              <div className="tx__role">{m.role === 'user' ? 'you' : mirror ? 'claude' : baseName(agent?.title ?? 'agent')}</div>
              {m.text && <MdText text={m.text} />}
              {m.tools.length > 0 && (
                <div className="tx__tools">
                  {m.tools.map((tool, j) => (
                    <ToolChip key={j} name={tool.name} target={tool.target} />
                  ))}
                </div>
              )}
            </div>
            ),
          )}
          </>
        )}
      </div>
    </div>
  )
}
