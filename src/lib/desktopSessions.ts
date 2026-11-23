// Mirroring Claude desktop-app sessions onto the canvas. Discovery (reading the
// desktop app's metadata) is the Rust `desktop_sessions` command; this file only
// consumes its result. Mirrors are read-only 'transcript' widgets bound straight
// to a Claude Code session id — we NEVER spawn `claude --resume` on that id, as
// two writers would split the JSONL. "Fork into terminal" uses --fork-session.

import { invoke } from '@tauri-apps/api/core'
import { isTauri } from './backend'
import { useStore, selectActive } from '../store/workspace'
import { viewCenter } from './view'
import { screenToWorld } from './geometry'
import type { CanvasElement, WidgetElement } from './types'

export type DesktopSession = {
  /** the desktop app's own id (`local_<uuid>`) */
  sessionId: string
  /** the Claude Code session id — names the transcript file */
  cliSessionId: string
  cwd: string
  title: string
  model: string | null
  isArchived: boolean
  createdAt: number | null
  lastActivityAt: number | null
  transcriptPath: string
  /** transcript mtime (epoch ms); null when the file is missing */
  transcriptMtime: number | null
}

/** A transcript written this recently counts as "running now". */
export const RUNNING_WINDOW_MS = 30_000

export function isRunningNow(modifiedMs: number | null | undefined, now = Date.now()): boolean {
  return modifiedMs != null && now - modifiedMs < RUNNING_WINDOW_MS
}

/** The desktop app's sessions, newest activity first (empty outside the desktop
 *  build or when the desktop app isn't installed). */
export async function listDesktopSessions(): Promise<DesktopSession[]> {
  if (!isTauri()) return []
  try {
    return await invoke<DesktopSession[]>('desktop_sessions')
  } catch {
    return []
  }
}

export const isDesktopMirror = (el: CanvasElement): el is WidgetElement =>
  el.type === 'widget' && el.kind === 'transcript' && el.mirrorOf === 'desktop'

/** Widget fields that bind a transcript widget to a desktop session. */
export function mirrorInit(s: DesktopSession): Partial<WidgetElement> {
  return {
    mirrorOf: 'desktop',
    desktopId: s.sessionId,
    cwd: s.cwd,
    sessionId: s.cliSessionId,
    title: s.title,
    // only read for the context meter's window size (a `[1m]` suffix)
    ...(s.model ? { model: s.model } : {}),
  }
}

/** Claude Code session ids already mirrored in these elements. */
export function mirroredIds(elements: CanvasElement[]): Set<string> {
  const ids = new Set<string>()
  for (const e of elements) if (isDesktopMirror(e) && e.sessionId) ids.add(e.sessionId)
  return ids
}

/** Shell command that opens an independent copy of a session. `--fork-session`
 *  gives the copy its own id, so the original transcript is never written. */
export function forkCommand(sessionId: string): string | null {
  // ids come from another app's files — never let one smuggle shell syntax in
  if (!/^[A-Za-z0-9-]+$/.test(sessionId)) return null
  return `claude --resume ${sessionId} --fork-session`
}

const MIRROR_W = 460
const MIRROR_H = 520
const GAP = 40
const COLS = 3

/** Add one mirror per session to the active canvas, laid out in a grid around
 *  the view centre. Sessions already mirrored there are skipped. Returns how
 *  many were added. */
export function addDesktopMirrors(sessions: DesktopSession[]): number {
  const s = useStore.getState()
  const ws = selectActive(s)
  const have = mirroredIds(ws.elements)
  const todo = sessions.filter((d) => !have.has(d.cliSessionId))
  if (!todo.length) return 0
  const c = screenToWorld(viewCenter(), ws.camera)
  const cols = Math.min(COLS, todo.length)
  const rows = Math.ceil(todo.length / cols)
  const x0 = c.x - ((cols - 1) * (MIRROR_W + GAP)) / 2
  const y0 = c.y - ((rows - 1) * (MIRROR_H + GAP)) / 2
  todo.forEach((d, i) => {
    const x = x0 + (i % cols) * (MIRROR_W + GAP)
    const y = y0 + Math.floor(i / cols) * (MIRROR_H + GAP)
    s.spawnWidget('transcript', x, y, mirrorInit(d))
  })
  return todo.length
}

/** Open a terminal next to a mirror running a fork of its session. */
export function forkIntoTerminal(mirror: WidgetElement): boolean {
  const cmd = mirror.sessionId ? forkCommand(mirror.sessionId) : null
  if (!cmd || !mirror.cwd) return false
  useStore.getState().spawnWidget('terminal', mirror.x + mirror.w + 380, mirror.y + mirror.h / 2, {
    cwd: mirror.cwd,
    title: `${mirror.title} · fork`,
    startCmd: cmd,
  })
  return true
}
