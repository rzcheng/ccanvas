// Icons per widget kind and the activity dot for terminals/agents — shared by
// the widget title bar and the stack tab rail.

import type { WidgetKind } from '../lib/types'
import { useDisplayStatus, type AgentStatus } from '../lib/agents'
import {
  IconNote,
  IconTerminal,
  IconWeb,
  IconAgent,
  IconFiles,
  IconDiff,
  IconEditor,
  IconDoc,
  IconLog,
  IconPr,
  IconRun,
  IconIssue,
  IconChecks,
  IconDatabase,
  IconData,
  IconPlot,
  IconChat,
  IconVideo,
  IconClaude,
  IconInfo,
} from '../ui/icons'

export const KIND_ICON: Record<WidgetKind, (p: { className?: string; size?: number }) => JSX.Element> = {
  terminal: IconTerminal,
  agent: IconAgent,
  web: IconWeb,
  note: IconNote,
  files: IconFiles,
  diff: IconDiff,
  editor: IconEditor,
  vscode: IconEditor,
  doc: IconDoc,
  log: IconLog,
  pr: IconPr,
  issues: IconIssue,
  runs: IconChecks,
  runner: IconRun,
  sql: IconDatabase,
  data: IconData,
  plot: IconPlot,
  transcript: IconChat,
  video: IconVideo,
  mediainfo: IconInfo,
  claude: IconClaude,
}

// ---- status icons ----
// A terminal or agent shows its status in the icon slot instead of a blinking
// dot next to it: a spinning arc while it works, a steady amber dot when it
// needs you (it pings once as that starts, then stays still), a check for a
// couple of minutes after it finishes, and its ordinary kind icon when idle.
// Motion is kept for "busy"; "needs you" is colour and shape.

export type ShownStatus = AgentStatus | 'done' | undefined

const STATUS_TITLE: Record<string, string> = {
  working: 'working…',
  waiting: 'waiting for input',
  connecting: 'connecting…',
  done: 'just finished',
  idle: 'idle',
  off: 'offline',
}

const SPINNER = (
  <svg viewBox="0 0 16 16" fill="none" strokeWidth="1.8" strokeLinecap="round">
    <circle cx="8" cy="8" r="5.5" className="status-icon__track" />
    <path d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5" className="status-icon__arc" />
  </svg>
)
const WAITING = (
  <svg viewBox="0 0 16 16">
    <circle cx="8" cy="8" r="4" className="status-icon__fill" />
    <circle cx="8" cy="8" r="6.3" fill="none" strokeWidth="1.4" className="status-icon__halo" />
  </svg>
)
const DONE = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
  </svg>
)
const IDLE_DOT = (
  <svg viewBox="0 0 16 16">
    <circle cx="8" cy="8" r="3" className="status-icon__fill" />
  </svg>
)

/** A status, drawn in an icon slot. `icon` is what idle (and offline) shows. */
export function StatusGlyph({
  status,
  icon,
  title,
  className = '',
}: {
  status: ShownStatus | 'off'
  icon?: React.ReactNode
  title?: string
  className?: string
}) {
  const s = status ?? 'off'
  const body =
    s === 'working' || s === 'connecting' ? SPINNER : s === 'waiting' ? WAITING : s === 'done' ? DONE : (icon ?? IDLE_DOT)
  return (
    <span className={`status-icon status-icon--${s} ${className}`} title={title ?? STATUS_TITLE[s]}>
      {body}
    </span>
  )
}

/** A live terminal/agent's status in its icon slot. */
export function StatusIcon({ id, kind, className }: { id: string; kind: WidgetKind; className?: string }) {
  const status = useDisplayStatus(id)
  const Icon = KIND_ICON[kind]
  return <StatusGlyph status={status} icon={<Icon />} className={className} />
}
