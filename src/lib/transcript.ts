// Reading + parsing Claude Code session transcripts. Claude persists each
// session as append-only JSONL under
//   <home>/.claude/projects/<cwd-with-non-alnum-→-dashes>/<sessionId>.jsonl
// Every line is one event (`user` / `assistant` / tool results …). Reading it
// gives the model's real output, free of terminal chrome, plus the files it
// touched via tool calls — the basis for the transcript widget and the
// agent-tracking camera.
//
// This module is the single home for that logic; flow.ts piping and the live
// features all share it. The one exception: on the desktop app the live
// summary (context, names, last reply) is computed by src-tauri/src/transcript.rs,
// which mirrors extractContext, extractSessionTitles and extractLastAssistant —
// keep the two in step.

import { invoke } from '@tauri-apps/api/core'
import { defaultDir, readFile, joinPath, isTauri } from './backend'

// ---------- transcript location ----------

let homeDir: string | null | undefined // cached after first lookup

/** Encode a working directory the way Claude Code names its project folder. */
function encodeProject(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/** Absolute path of an agent's transcript, or null if it can't be located. */
export async function transcriptPathFor(
  cwd: string | undefined,
  sessionId: string | undefined,
): Promise<string | null> {
  if (!cwd || !sessionId) return null
  if (homeDir === undefined) homeDir = await defaultDir()
  if (!homeDir) return null
  return joinPath(
    joinPath(joinPath(joinPath(homeDir, '.claude'), 'projects'), encodeProject(cwd)),
    `${sessionId}.jsonl`,
  )
}

/** Read an agent's transcript file (null when unavailable). */
export async function readTranscript(
  cwd: string | undefined,
  sessionId: string | undefined,
): Promise<string | null> {
  const path = await transcriptPathFor(cwd, sessionId)
  if (!path) return null
  return readFile(path)
}

// ---------- shared event helpers ----------

type Block = { type?: string; text?: string; name?: string; input?: unknown }
type Event = { type?: string; message?: { content?: unknown } }

/** Pull a human-meaningful target out of a tool_use block (file, command, …). */
export function toolTarget(_name: string | undefined, input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const i = input as Record<string, unknown>
  const pick = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
  return (
    pick(i.file_path) ??
    pick(i.notebook_path) ??
    pick(i.path) ??
    pick(i.command) ??
    pick(i.url) ??
    pick(i.pattern) ??
    pick(i.query) ??
    undefined
  )
}

// Tools that change a file on disk vs. just read one. Used to decide which
// transcript file ops the tracking camera should surface (and how).
const MUTATE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Create'])
const READ_TOOLS = new Set(['Read', 'NotebookRead'])

function fileFromTool(name: string | undefined, input: unknown): string | null {
  if (!name || (!MUTATE_TOOLS.has(name) && !READ_TOOLS.has(name))) return null
  if (!input || typeof input !== 'object') return null
  const i = input as Record<string, unknown>
  const p = i.file_path ?? i.notebook_path ?? i.path
  return typeof p === 'string' && p ? p : null
}

/** Number of complete (newline-terminated) lines — never consume a partial tail. */
function completeLines(jsonl: string): string[] {
  const arr = jsonl.split('\n')
  // a trailing chunk with no newline yet may be a half-written event — drop it
  if (arr.length && jsonl.length && !jsonl.endsWith('\n')) arr.pop()
  return arr
}

// ---------- last assistant turn (flow piping) ----------

/** Walk a transcript from the end, gathering the final turn's assistant text. */
export function extractLastAssistant(jsonl: string): string | null {
  const lines = jsonl.split('\n')
  const parts: string[] = []
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i].trim()
    if (!ln) continue
    let ev: Event
    try {
      ev = JSON.parse(ln)
    } catch {
      continue
    }
    // a user message or tool result marks the start of this turn — stop
    if (ev.type === 'user') break
    if (ev.type !== 'assistant') continue
    const content = ev.message?.content
    let text = ''
    if (typeof content === 'string') text = content
    else if (Array.isArray(content))
      text = (content as Block[])
        .filter((c): c is Block & { text: string } => !!c && c.type === 'text' && !!c.text)
        .map((c) => c.text)
        .join('\n')
    if (text.trim()) parts.unshift(text.trim())
  }
  const out = parts.join('\n\n').trim()
  return out || null
}

// ---------- context window (context meter) ----------

export type ContextUsage = {
  /** tokens in the context at the most recent reply */
  used: number
  /** model id of that reply, e.g. "claude-opus-5" */
  model?: string
  /** largest context seen in this session (hints at a 1M window) */
  peak: number
}

type UsageEvent = {
  type?: string
  isSidechain?: boolean
  message?: {
    model?: string
    usage?: {
      input_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
      output_tokens?: number
    }
  }
}

/** How full the main conversation's context is, from its last assistant reply.
 *  Subagent (sidechain) turns have their own context and are skipped. */
export function extractContext(jsonl: string): ContextUsage | null {
  let last: ContextUsage | null = null
  let peak = 0
  for (const ln of completeLines(jsonl)) {
    if (!ln.includes('"usage"')) continue
    let ev: UsageEvent
    try {
      ev = JSON.parse(ln)
    } catch {
      continue
    }
    const u = ev.message?.usage
    if (ev.type !== 'assistant' || ev.isSidechain || !u) continue
    if (ev.message?.model === '<synthetic>') continue
    const used =
      (u.input_tokens ?? 0) +
      (u.cache_read_input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0) +
      (u.output_tokens ?? 0)
    if (!used) continue
    peak = Math.max(peak, used)
    last = { used, model: ev.message?.model, peak }
  }
  return last ? { ...last, peak } : null
}

// ---------- files touched (tracking camera) ----------

export type ToolFile = {
  /** the path as it appeared in the tool call (often absolute) */
  path: string
  /** the tool name (Edit, Write, Read, …) */
  tool: string
  /** true for tools that write to disk, false for reads */
  mutate: boolean
}

/**
 * File operations recorded in the transcript after `fromLine`. Returns the new
 * ops in order plus a cursor (line count consumed) so a watcher only processes
 * events it hasn't seen. Partial trailing lines are never consumed.
 */
export function extractToolFiles(
  jsonl: string,
  fromLine = 0,
): { files: ToolFile[]; cursor: number } {
  const lines = completeLines(jsonl)
  const out: ToolFile[] = []
  for (let idx = Math.max(0, fromLine); idx < lines.length; idx++) {
    const ln = lines[idx].trim()
    if (!ln) continue
    let ev: Event
    try {
      ev = JSON.parse(ln)
    } catch {
      continue
    }
    if (ev.type !== 'assistant') continue
    const content = ev.message?.content
    if (!Array.isArray(content)) continue
    for (const c of content as Block[]) {
      if (!c || c.type !== 'tool_use') continue
      const p = fileFromTool(c.name, c.input)
      if (p) out.push({ path: p, tool: c.name ?? '', mutate: MUTATE_TOOLS.has(c.name ?? '') })
    }
  }
  return { files: out, cursor: lines.length }
}

// ---------- full conversation (transcript widget) ----------

export type TranscriptTool = { name: string; target?: string }
export type TranscriptTurn = {
  /** `event` is harness traffic shown as a muted one-liner: a task
   *  notification, a message from another session, a compaction, an
   *  interrupt, a slash command's output */
  role: 'user' | 'assistant' | 'event'
  text: string
  tools: TranscriptTool[]
}

type UserEvent = Event & { isMeta?: boolean; isCompactSummary?: boolean; origin?: unknown }

const tagBody = (text: string, tag: string): string | null => {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(text)
  return m ? m[1].trim() : null
}
const tagAttr = (text: string, tag: string, attr: string): string | null => {
  const m = new RegExp(`<${tag}\\s[^>]*\\b${attr}="([^"]*)"`).exec(text)
  return m ? m[1] : null
}
const oneLine = (s: string, max = 160): string => {
  const line = s.replace(/\s+/g, ' ').trim()
  return line.length > max ? line.slice(0, max - 1) + '…' : line
}

/** Claude Code wraps what you type (and what it injects) in harness markup.
 *  Turn one user event's text into what to show: your prompt with the markup
 *  removed, a muted event line, or nothing. */
function readUserText(raw: string, ev: UserEvent): TranscriptTurn | null {
  const event = (text: string): TranscriptTurn => ({ role: 'event', text: oneLine(text), tools: [] })
  if (ev.isCompactSummary) return event('conversation compacted — earlier turns summarized')
  // context the harness adds to your turn: never something you typed
  let text = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
  if (!text) return null

  if (text.includes('<cross-session-message')) {
    const from = tagAttr(text, 'cross-session-message', 'from-name') ?? 'another session'
    return event(`message from ${from}: ${tagBody(text, 'cross-session-message') ?? ''}`)
  }
  if (text.startsWith('<task-notification')) {
    const summary = tagBody(text, 'summary') ?? tagBody(text, 'status') ?? 'background task update'
    return event(`task · ${summary}`)
  }
  if (text.startsWith('<side-sessions-event')) return event('side sessions updated')
  // skill instructions, command caveats and other injected context
  if (ev.isMeta || text.startsWith('<local-command-caveat')) return null

  const cmd = tagBody(text, 'command-name')
  if (cmd) {
    const args = tagBody(text, 'command-args')
    return { role: 'user', text: '`' + [cmd, args].filter(Boolean).join(' ') + '`', tools: [] }
  }
  const stdout = tagBody(text, 'local-command-stdout')
  if (stdout != null) return stdout ? event(stdout) : null
  const bash = tagBody(text, 'bash-input')
  if (bash != null) return { role: 'user', text: '```\n! ' + bash + '\n```', tools: [] }
  const bashOut = tagBody(text, 'bash-stdout') ?? tagBody(text, 'bash-stderr')
  if (bashOut != null) return bashOut ? event(bashOut) : null
  if (/^\[Request interrupted/.test(text)) return event('interrupted')
  if (/^\[(Usage limit|Earlier usage)/.test(text)) return event(text.replace(/^\[|\]$/g, ''))
  // the harness's note when Claude reads an image file, not a prompt
  if (/^\[Image: original \d+x\d+/.test(text)) return null

  // pasted blocks: keep a short quoted preview instead of the whole paste
  text = text.replace(/<pasted_content[^>]*>([\s\S]*?)<\/pasted_content[^>]*>/g, (_m, body: string) => {
    const lines = body.trim().split('\n')
    const head = lines
      .slice(0, 4)
      .map((l) => '> ' + l)
      .join('\n')
    const more = lines.length > 4 ? `\n> … ${lines.length - 4} more lines` : ''
    return `\n\n*pasted:*\n${head}${more}\n\n`
  })
  text = text.trim()
  return text ? { role: 'user', text, tools: [] } : null
}

/** Parse a transcript into an ordered list of readable turns. */
export function parseTranscript(jsonl: string): TranscriptTurn[] {
  const out: TranscriptTurn[] = []
  for (const raw of jsonl.split('\n')) {
    const ln = raw.trim()
    if (!ln) continue
    let ev: Event
    try {
      ev = JSON.parse(ln)
    } catch {
      continue
    }
    const content = ev.message?.content
    if (ev.type === 'assistant') {
      let text = ''
      const tools: TranscriptTool[] = []
      if (typeof content === 'string') text = content
      else if (Array.isArray(content))
        for (const c of content as Block[]) {
          if (!c) continue
          if (c.type === 'text' && c.text) text += (text ? '\n' : '') + c.text
          else if (c.type === 'tool_use')
            tools.push({ name: c.name ?? 'tool', target: toolTarget(c.name, c.input) })
        }
      // harness-made replies (API errors, usage limits) aren't the model talking
      const synthetic = (ev.message as { model?: string } | undefined)?.model === '<synthetic>'
      if (synthetic && text.trim()) out.push({ role: 'event', text: oneLine(text), tools: [] })
      else if (text.trim() || tools.length) out.push({ role: 'assistant', text: text.trim(), tools })
    } else if (ev.type === 'user') {
      // pure tool-result turns carry no user text — skip them; an attached
      // image shows as a chip on the prompt
      let text = ''
      let images = 0
      if (typeof content === 'string') text = content
      else if (Array.isArray(content))
        for (const c of content as Block[]) {
          if (c?.type === 'text' && c.text) text += (text ? '\n' : '') + c.text
          else if (c?.type === 'image') images++
        }
      const meta = (ev as UserEvent).isMeta
      const turn = text.trim()
        ? readUserText(text, ev as UserEvent)
        : images && !meta
          ? { role: 'user' as const, text: '', tools: [] }
          : null
      if (turn?.role === 'user' && images)
        turn.tools.push({ name: images > 1 ? `${images} images` : 'image' })
      if (turn) out.push(turn)
    }
  }
  return out
}

export type TranscriptChunk = {
  /** complete lines read since the offset */
  text: string
  /** offset to pass next time */
  next: number
  /** the file was rewritten: drop what was parsed before */
  reset: boolean
  /** earlier lines were skipped to honour `tail` */
  truncated: boolean
}

/** What was appended to a transcript since `offset` (null when unreadable). On
 *  the desktop app only the new bytes are read; the web bridge has no such
 *  command, so the browser build re-reads the whole file and reports a reset.
 *  `tail` caps a first read of a huge file to roughly its last `tail` bytes. */
export async function readTranscriptChunk(
  path: string,
  offset: number,
  tail?: number,
): Promise<TranscriptChunk | null> {
  if (isTauri()) {
    try {
      return await invoke<TranscriptChunk | null>('transcript_chunk', { path, offset, tail })
    } catch {
      return null
    }
  }
  const text = await readFile(path)
  if (text == null) return null
  return { text, next: text.length, reset: true, truncated: false }
}

function lastStringField(jsonl: string, type: string, field: string): string | null {
  const at = jsonl.lastIndexOf(`"type":"${type}"`)
  if (at < 0) return null
  const start = jsonl.lastIndexOf('\n', at) + 1
  const end = jsonl.indexOf('\n', at)
  try {
    const ev = JSON.parse(jsonl.slice(start, end < 0 ? undefined : end)) as Record<string, unknown>
    const v = ev[field]
    return typeof v === 'string' && v.trim() ? v.trim() : null
  } catch {
    return null
  }
}

/** The session's names. `custom` is the newest `/rename` (a `custom-title`
 *  record); `ai` is the name Claude generates itself after the first prompt
 *  (an `ai-title` record). */
export function extractSessionTitles(jsonl: string): { custom: string | null; ai: string | null } {
  return {
    custom: lastStringField(jsonl, 'custom-title', 'customTitle'),
    ai: lastStringField(jsonl, 'ai-title', 'aiTitle'),
  }
}

// ---------- live summary (context meter, names, last reply) ----------

export type TranscriptSummary = {
  /** how much of the transcript has been read; changes when new events land */
  version: number
  context: ContextUsage | null
  /** newest `/rename` (custom-title) */
  customTitle: string | null
  /** the name Claude generated for the session (ai-title) */
  aiTitle: string | null
  /** text of the latest turn's assistant replies */
  lastReply: string | null
  /** when the transcript file was last written (epoch ms). Desktop only. */
  modified?: number | null
  /** the tool call still waiting for its result, if any. Desktop only. */
  pending?: TranscriptPending | null
}

export type TranscriptPending = {
  /** tool name, e.g. `AskUserQuestion`, `Bash` */
  tool: string
  /** for AskUserQuestion / ExitPlanMode: what the user is being asked */
  question: string | null
  /** for AskUserQuestion: the first question's option labels */
  options: string[]
  /** how many tool calls are open */
  count: number
}

/** Summarize an agent's transcript (null when unavailable). The desktop
 *  backend keeps its place in each file and parses only what was appended
 *  since the last call; the web bridge has no such command, so the browser
 *  build reads and parses the whole file. */
export async function readTranscriptSummary(
  cwd: string | undefined,
  sessionId: string | undefined,
): Promise<TranscriptSummary | null> {
  const path = await transcriptPathFor(cwd, sessionId)
  if (!path) return null
  if (isTauri()) {
    try {
      return await invoke<TranscriptSummary | null>('transcript_summary', { path })
    } catch {
      return null
    }
  }
  const jsonl = await readFile(path)
  if (jsonl == null) return null
  const { custom, ai } = extractSessionTitles(jsonl)
  return {
    version: jsonl.length,
    context: extractContext(jsonl),
    customTitle: custom,
    aiTitle: ai,
    lastReply: extractLastAssistant(jsonl),
  }
}

// Every agent widget keeps its title in sync and shows a context meter, and the
// roster shows each agent's last reply. They all subscribe here, so each
// transcript is polled once however many readers it has.

const SUMMARY_POLL_MS = 3000

type SummaryWatch = {
  subs: Set<(s: TranscriptSummary | null) => void>
  last: TranscriptSummary | null
  timer: ReturnType<typeof setInterval>
}
const summaryWatches = new Map<string, SummaryWatch>()

/** Call `cb` with the transcript's summary as soon as it's known and again on
 *  every poll. The object is reused while nothing new was written, so readers
 *  can compare by identity. Returns an unsubscribe function. */
export function watchTranscriptSummary(
  cwd: string | undefined,
  sessionId: string | undefined,
  cb: (s: TranscriptSummary | null) => void,
): () => void {
  if (!cwd || !sessionId) return () => {}
  const key = `${cwd}\n${sessionId}`
  let w = summaryWatches.get(key)
  if (w) {
    if (w.last) cb(w.last)
  } else {
    let busy = false
    const poll = async () => {
      if (busy) return
      busy = true
      const next = await readTranscriptSummary(cwd, sessionId).finally(() => (busy = false))
      const cur = summaryWatches.get(key)
      if (!cur || cur.timer !== timer) return // stopped while reading
      if (!next || !cur.last || next.version !== cur.last.version) cur.last = next
      for (const f of cur.subs) f(cur.last)
    }
    const timer = setInterval(poll, SUMMARY_POLL_MS)
    w = { subs: new Set(), last: null, timer }
    summaryWatches.set(key, w)
    void poll()
  }
  const watch = w
  watch.subs.add(cb)
  return () => {
    watch.subs.delete(cb)
    if (watch.subs.size) return
    clearInterval(watch.timer)
    summaryWatches.delete(key)
  }
}
