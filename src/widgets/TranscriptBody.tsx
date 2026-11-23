import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WidgetElement } from '../lib/types'
import { useStore, selectActive } from '../store/workspace'
import {
  transcriptPathFor,
  readTranscriptChunk,
  TranscriptParser,
  type ActivityStep,
  type ThinkingStep,
  type ToolCall,
  type TranscriptItem,
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

// ---------- tool activity ----------
// Each tool call is one compact row (status, name, target) that opens to show
// what the desktop app shows: a command and its output tail, a diff preview, a
// checklist. Rows render their body only while open, and every row, group and
// message is memoised on its object: the parser swaps in a new object only for
// what changed, so a live append re-renders the new rows, not the history.

const GLYPH: Record<ToolCall['state'], string> = {
  running: '◌',
  done: '✓',
  error: '✕',
  stopped: '–',
}
const STATE_TITLE: Record<ToolCall['state'], string> = {
  running: 'running',
  done: 'done',
  error: 'failed',
  stopped: 'no result (interrupted)',
}
const PLAN_GLYPH: Record<string, string> = { completed: '☑', in_progress: '◧' }

/** "14:02:11" for a row's tooltip; the date too when it isn't today. */
function when(ts: string | undefined): string {
  if (!ts) return ''
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  const today = new Date().toDateString() === d.toDateString()
  return today ? d.toLocaleTimeString() : d.toLocaleString()
}

/** Short text at the right of a row: +3 −1, 2/5, 120 lines … */
function toolMeta(t: ToolCall): string {
  if (t.diff) return t.diff.del ? `+${t.diff.add} −${t.diff.del}` : `+${t.diff.add}`
  if (t.plan?.length) return `${t.plan.filter((p) => p.status === 'completed').length}/${t.plan.length}`
  if (t.images) return t.images > 1 ? `${t.images} images` : 'image'
  if ((t.name === 'Read' || t.name === 'Grep' || t.name === 'Glob') && t.outputLines)
    return `${t.outputLines} lines`
  return ''
}

/** The row's one-liner after the tool name. */
function toolLine(t: ToolCall): string {
  if (t.plan?.length) {
    const cur = t.plan.find((p) => p.status === 'in_progress')
    return cur?.text ?? (t.plan.every((p) => p.status === 'completed') ? 'all done' : t.plan[0].text)
  }
  if (!t.target) return ''
  // a file path: lead with the file's name, then its folder
  if (/^[/~]/.test(t.target) && !t.target.includes(' ')) {
    const cut = t.target.lastIndexOf('/')
    if (cut > 0 && cut < t.target.length - 1)
      return `${t.target.slice(cut + 1)}  ${t.target.slice(0, cut)}`
  }
  return t.target
}

const hasBody = (t: ToolCall) =>
  !!(t.command || t.diff?.lines.length || t.plan?.length || t.prompt || t.output)


const ToolBody = ({ t }: { t: ToolCall }) => (
  <div className="tx__tbody">
    {t.plan?.length ? (
      <ul className="tx__plan">
        {t.plan.map((p, i) => (
          <li key={i} className={`tx__plan-item tx__plan-item--${p.status}`}>
            <span className="tx__plan-box">{PLAN_GLYPH[p.status] ?? '☐'}</span>
            {p.text}
          </li>
        ))}
      </ul>
    ) : null}
    {t.prompt && <div className="tx__tprompt">{t.prompt}</div>}
    {t.diff && t.diff.lines.length > 0 && (
      <pre className="tx__diff">
        {t.diff.lines.map((l, i) => (
          <span key={i} className={l[0] === '+' ? 'tx__add' : 'tx__del'}>
            {l}
            {'\n'}
          </span>
        ))}
        {t.diff.add + t.diff.del > t.diff.lines.length && (
          <span className="tx__more">… {t.diff.add + t.diff.del - t.diff.lines.length} more lines</span>
        )}
      </pre>
    )}
    {t.command && <pre className="tx__out tx__out--cmd">$ {t.command}</pre>}
    {t.output && !t.plan?.length && (
      <pre className={`tx__out${t.state === 'error' ? ' tx__out--error' : ''}`}>{t.output}</pre>
    )}
  </div>
)

const ToolRow = memo(function ToolRow({ t }: { t: ToolCall }) {
  const [open, setOpen] = useState(false)
  const body = hasBody(t)
  const meta = toolMeta(t)
  const line = toolLine(t)
  return (
    <div className={`tx__trow tx__trow--${t.state}${open ? ' tx__trow--open' : ''}`}>
      <button
        className="tx__thead"
        disabled={!body}
        title={[t.name, t.target, when(t.ts), STATE_TITLE[t.state]].filter(Boolean).join('\n')}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="tx__glyph">{GLYPH[t.state]}</span>
        <span className="tx__tname">{t.label}</span>
        {line && <span className="tx__ttarget">{line}</span>}
        {meta && <span className="tx__tmeta">{meta}</span>}
        {body && <span className="tx__caret">{open ? '▾' : '▸'}</span>}
      </button>
      {open && <ToolBody t={t} />}
    </div>
  )
})

const ThinkingRow = memo(function ThinkingRow({ s }: { s: ThinkingStep }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`tx__trow tx__trow--thinking${open ? ' tx__trow--open' : ''}`}>
      <button className="tx__thead" title={when(s.ts)} onClick={() => setOpen((o) => !o)}>
        <span className="tx__glyph">∴</span>
        <span className="tx__tname">thinking</span>
        {!open && <span className="tx__ttarget">{s.text.slice(0, 160)}</span>}
        <span className="tx__caret">{open ? '▾' : '▸'}</span>
      </button>
      {open && <div className="tx__think">{s.text}</div>}
    </div>
  )
})

const Step = ({ s }: { s: ActivityStep }) =>
  s.kind === 'tool' ? <ToolRow t={s} /> : <ThinkingRow s={s} />

// groups of more tool calls than this fold into one "ran N tools" line
const GROUP_MIN = 4

/** "Bash 4 · Edit 2 · Read 1" */
function toolCounts(steps: ActivityStep[]): string {
  const n = new Map<string, number>()
  for (const s of steps) if (s.kind === 'tool') n.set(s.label, (n.get(s.label) ?? 0) + 1)
  return [...n]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([k, v]) => (v > 1 ? `${k} ${v}` : k))
    .join(' · ')
}

const Activity = memo(function Activity({
  steps,
  live,
}: {
  steps: ActivityStep[]
  /** the newest item of the conversation: open while it's still running */
  live: boolean
}) {
  const [open, setOpen] = useState<boolean | null>(null)
  const tools = steps.filter((s): s is ToolCall => s.kind === 'tool')
  if (tools.length < GROUP_MIN)
    return (
      <div className="tx__activity">
        {steps.map((s, i) => (
          <Step key={i} s={s} />
        ))}
      </div>
    )
  const running = tools.some((t) => t.state === 'running')
  const failed = tools.filter((t) => t.state === 'error').length
  const shown = open ?? (live && running)
  return (
    <div className="tx__activity">
      <button className="tx__group" onClick={() => setOpen(!shown)}>
        <span className="tx__glyph">{running ? GLYPH.running : shown ? '▾' : '▸'}</span>
        <span className="tx__tname">
          {running ? 'running' : 'ran'} {tools.length} tools
        </span>
        <span className="tx__ttarget">{toolCounts(steps)}</span>
        {failed > 0 && <span className="tx__tmeta tx__tmeta--error">{failed} failed</span>}
      </button>
      {shown && (
        <div className="tx__group-body">
          {steps.map((s, i) => (
            <Step key={i} s={s} />
          ))}
        </div>
      )}
    </div>
  )
})

const Item = memo(function Item({
  m,
  who,
  head,
  live,
}: {
  m: TranscriptItem
  who: string
  /** first assistant item after a prompt: show the speaker */
  head: boolean
  live: boolean
}) {
  if (m.kind === 'event')
    return (
      <div className={`tx__event${m.tone ? ' tx__event--' + m.tone : ''}`} title={[m.text, when(m.ts)].join('\n')}>
        {m.text}
      </div>
    )
  if (m.kind === 'user')
    return (
      <div className="tx__msg tx__msg--user">
        <div className="tx__role" title={when(m.ts)}>you</div>
        {m.text && <MdText text={m.text} />}
        {m.images > 0 && (
          <div className="tx__tools">
            <span className="tx__tool">
              <span className="tx__tool-name">▣ {m.images > 1 ? `${m.images} images` : 'image'}</span>
            </span>
          </div>
        )}
      </div>
    )
  return (
    <div className="tx__msg tx__msg--assistant">
      {head && <div className="tx__role" title={when(m.ts)}>{who}</div>}
      {m.kind === 'text' ? <MdText text={m.text} /> : <Activity steps={m.steps} live={live} />}
    </div>
  )
})

/** Does a filter query match this item (prose, or a tool's target/command)? */
function itemMatches(m: TranscriptItem, q: string): boolean {
  if (m.kind !== 'activity') return m.text.toLowerCase().includes(q)
  return m.steps.some((s) =>
    s.kind === 'thinking'
      ? s.text.toLowerCase().includes(q)
      : s.label.toLowerCase().includes(q) ||
        (s.target ?? '').toLowerCase().includes(q) ||
        (s.command ?? '').toLowerCase().includes(q),
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

  const [items, setItems] = useState<TranscriptItem[]>([])
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
  // keeps tool calls open across chunks so their results can be paired later
  const parserRef = useRef(new TranscriptParser())
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
              if (restart) parserRef.current = new TranscriptParser()
              const parser = parserRef.current
              const changed = chunk.text ? parser.push(chunk.text) : false
              if (restart) {
                setTruncated(chunk.truncated)
                setItems(parser.items.slice())
              } else if (changed) setItems(parser.items.slice())
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
  }, [items, autoscroll])

  // keep each item's index in the full list as its key, so a row's open
  // state stays with that row while filtering
  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase()
    const all = items.map((m, i) => ({ m, i }))
    return t ? all.filter(({ m }) => itemMatches(m, t)) : all
  }, [items, q])
  const msgCount = useMemo(
    () => items.reduce((n, m) => (m.kind === 'user' || m.kind === 'text' ? n + 1 : n), 0),
    [items],
  )
  const who = mirror ? 'claude' : baseName(agent?.title ?? 'agent')
  const jumpToLatest = () => {
    setAutoscroll(true)
    const n = scrollRef.current
    if (n) n.scrollTop = n.scrollHeight
  }

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
        <span className="tx__count">{msgCount} msgs</span>
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
          {filtered.map(({ m, i }, k) => {
            const prev = filtered[k - 1]?.m
            const head =
              m.kind !== 'user' && m.kind !== 'event' && (!prev || prev.kind === 'user' || prev.kind === 'event')
            return <Item key={i} m={m} who={who} head={head} live={i === items.length - 1} />
          })}
          </>
        )}
      </div>
      {!autoscroll && items.length > 0 && (
        <button className="tx__jump" title="Jump to the newest message" onClick={jumpToLatest}>
          ↓ latest
        </button>
      )}
    </div>
  )
}
