// Icons per widget kind and the activity dot for terminals/agents — shared by
// the widget title bar and the stack tab rail.

import type { WidgetKind } from '../lib/types'
import { useDisplayStatus } from '../lib/agents'
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

// Activity dot for terminal/agent widgets: reflects whether the session is
// idle, streaming output, or appears to be waiting on a prompt.
export function AgentDot({ id }: { id: string }) {
  const status = useDisplayStatus(id)
  if (!status || status === 'off') return null
  const title =
    status === 'working'
      ? 'working…'
      : status === 'waiting'
        ? 'waiting for input'
        : status === 'connecting'
          ? 'connecting…'
          : status === 'done'
            ? 'just finished'
            : 'idle'
  return <span className={`agent-dot agent-dot--${status}`} title={title} />
}
