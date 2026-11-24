// Now playing: what the Spotify or Music app is playing, read over AppleScript.
//
// macOS only, desktop app only. Each poll runs one short `osascript` through
// runCommand(). That costs about 4 ms of CPU and an eighth of a second of wall
// time, so a long-lived JXA process (and the streaming plumbing it would need
// on the Rust side) isn't worth it. Polls are shared by every Now playing
// widget and run only while at least one of them is on screen: about once a
// second while something plays, every few seconds while paused, and not at all
// when none is visible or the window is hidden. The progress bar interpolates
// between polls.
//
// Every script checks `application "…" is running` before it talks to an app,
// because a `tell` would launch it. Nothing here is logged or saved: track
// details live only in this in-memory store, never in the .ccnvs file.

import { create } from 'zustand'
import { isTauri, mediaUrl, runCommand } from './backend'

export type Source = 'spotify' | 'music'
export const SOURCES: Source[] = ['spotify', 'music']
export const SOURCE_LABEL: Record<Source, string> = { spotify: 'Spotify', music: 'Music' }
const APP_NAME: Record<Source, string> = { spotify: 'Spotify', music: 'Music' }

export type Track = {
  source: Source
  playing: boolean
  title: string
  artist: string
  album: string
  durationMs: number
  /** position when it was read, at `at` (performance.now()) */
  positionMs: number
  at: number
  /** the app's id for the track (Spotify URI, Music persistent ID) */
  id: string
  /** an <img> src: Spotify's artwork URL, or Music's artwork file via the asset protocol */
  artwork: string | null
}

export type NowPlaying =
  | { kind: 'unsupported' }
  | { kind: 'loading' }
  | { kind: 'idle' }
  /** the user said no to "ccanvas wants to control …" */
  | { kind: 'denied'; source: Source }
  | { kind: 'track'; track: Track }

/** Can this build read Now playing at all? (the macOS desktop app) */
export function nowPlayingSupported(): boolean {
  return isTauri() && typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent)
}

export const useNowPlaying = create<{ np: NowPlaying }>(() => ({
  np: nowPlayingSupported() ? { kind: 'loading' } : { kind: 'unsupported' },
}))

/** Where the track is now, moving on from the last poll while it plays. */
export function positionNow(t: Track, now = performance.now()): number {
  if (!t.playing) return t.positionMs
  const p = t.positionMs + (now - t.at)
  return t.durationMs > 0 ? Math.min(p, t.durationMs) : p
}

// ---------- the scripts ----------

// Fields are split by the unit separator, sources by the record separator:
// neither turns up in track names.
const US = '\u001f'
const RS = '\u001e'

// Each part adds one record to `out`: "<source> US <state> [US fields…]".
// Values are read inside the `tell` and joined outside it, so the number
// coercions and file writes are ours, not sent to the app. Error -1743 is
// "not authorised to send Apple events" (the user declined the prompt).
const PART: Record<Source, string> = {
  spotify: `
if application "Spotify" is running then
	try
		with timeout of 4 seconds
			tell application "Spotify"
				set s to player state as text
				if s is not "stopped" then
					set t to current track
					set nm to name of t
					set ar to artist of t
					set al to album of t
					set du to duration of t
					set pp to player position
					set tid to id of t
					set aw to artwork url of t
				end if
			end tell
		end timeout
		if s is "stopped" then
			set end of out to "spotify" & US & s
		else
			set end of out to "spotify" & US & s & US & nm & US & ar & US & al & US & ((du as real) as integer) & US & ((pp * 1000) as integer) & US & tid & US & aw
		end if
	on error number n
		if n is -1743 then set end of out to "spotify" & US & "denied"
	end try
end if`,
  music: `
if application "Music" is running then
	try
		set raw to missing value
		with timeout of 4 seconds
			tell application "Music"
				set s to player state as text
				if s is not "stopped" then
					set t to current track
					set nm to name of t
					set ar to artist of t
					set al to album of t
					set du to 0
					try
						set du to duration of t
					end try
					set pp to player position
					set tid to persistent ID of t
					if tid is not knownMusic and (count of artworks of t) > 0 then
						set a to artwork 1 of t
						set fmt to (format of a) as text
						set raw to raw data of a
					end if
				end if
			end tell
		end timeout
		if s is "stopped" then
			set end of out to "music" & US & s
		else
			set art to ""
			if tid is knownMusic then
				set art to "="
			else if raw is not missing value then
				set dir to POSIX path of (path to temporary items from user domain)
				do shell script "rm -f " & quoted form of dir & "ccanvas-artwork-*"
				set ext to ".jpg"
				if fmt contains "PNG" then set ext to ".png"
				set art to dir & "ccanvas-artwork-" & tid & ext
				try
					set f to open for access (POSIX file art) with write permission
					set eof f to 0
					write raw to f
					close access f
				on error
					try
						close access (POSIX file art)
					end try
					set art to ""
				end try
			end if
			set end of out to "music" & US & s & US & nm & US & ar & US & al & US & ((du * 1000) as integer) & US & ((pp * 1000) as integer) & US & tid & US & art
		end if
	on error number n
		if n is -1743 then set end of out to "music" & US & "denied"
	end try
end if`,
}

/** One osascript program that reads the given sources. argv 1 is the Music
 *  track whose artwork is already on disk (so it isn't written again). */
export function buildScript(sources: Source[]): string {
  return [
    'on run argv',
    'set US to character id 31',
    'set RS to character id 30',
    'set knownMusic to ""',
    'if (count of argv) > 0 then set knownMusic to item 1 of argv',
    'set out to {}',
    ...sources.map((s) => PART[s]),
    "set AppleScript's text item delimiters to RS",
    'return out as text',
    'end run',
  ].join('\n')
}

/** One app's answer, as parsed from the script's output. */
export type Sample = { source: Source; state: 'stopped' | 'denied' } | TrackSample
export type TrackSample = {
      source: Source
      state: 'playing' | 'paused'
      title: string
      artist: string
      album: string
      durationMs: number
      positionMs: number
      id: string
      /** a URL or path; '' for none; '=' for "the one you already have" */
      art: string
}

const clean = (s: string | undefined): string => (!s || s === 'missing value' ? '' : s)
// AppleScript writes numbers in the user's locale ("1,5") and may use exponents
const num = (s: string | undefined): number => {
  const n = parseFloat(clean(s).replace(',', '.'))
  return Number.isFinite(n) && n > 0 ? n : 0
}

export function parseOutput(stdout: string): Sample[] {
  const out: Sample[] = []
  for (const rec of stdout.replace(/\n$/, '').split(RS)) {
    const f = rec.split(US)
    const source = f[0] as Source
    if (!SOURCES.includes(source)) continue
    const st = f[1] ?? ''
    if (st === 'stopped' || st === 'denied') {
      out.push({ source, state: st })
      continue
    }
    // Music's "fast forwarding" and "rewinding" count as playing
    const state = st === 'paused' ? 'paused' : st ? 'playing' : null
    if (!state) continue
    out.push({
      source,
      state,
      title: clean(f[2]),
      artist: clean(f[3]),
      album: clean(f[4]),
      durationMs: num(f[5]),
      positionMs: num(f[6]),
      id: clean(f[7]),
      art: clean(f[8]),
    })
  }
  return out
}

/** Which app to show: a playing one beats a paused one, Spotify first. */
export function pickSample(samples: Sample[]): Sample | null {
  const order = (s: Sample) => SOURCES.indexOf(s.source)
  const by = (state: Sample['state']) =>
    samples.filter((s) => s.state === state).sort((a, b) => order(a) - order(b))[0]
  return by('playing') ?? by('paused') ?? by('denied') ?? null
}

// ---------- polling ----------

/** Sources whose script compiles here (Spotify's won't if it isn't installed). */
let sources: Source[] = [...SOURCES]
/** Music artwork on disk: the track it belongs to and its <img> src. */
let musicArt: { id: string; src: string | null } = { id: '', src: null }
const demand = new Map<string, boolean>()
let timer: ReturnType<typeof setTimeout> | null = null
let inFlight = false

const isCompileError = (stderr: string) => /syntax error|\(-27\d\d\)/i.test(stderr)

async function osa(script: string, args: string[] = []) {
  return runCommand('/usr/bin/osascript', ['-e', script, ...args])
}

/** Drop the sources whose script doesn't compile (an app that isn't installed). */
async function pruneSources() {
  const ok: Source[] = []
  for (const s of sources) {
    const r = await osa(buildScript([s]))
    if (r && !(r.code !== 0 && isCompileError(r.stderr))) ok.push(s)
  }
  sources = ok
}

async function sample(): Promise<NowPlaying> {
  if (!sources.length) return { kind: 'idle' }
  const t0 = performance.now()
  let r = await osa(buildScript(sources), [musicArt.id])
  if (r && r.code !== 0 && isCompileError(r.stderr)) {
    await pruneSources()
    if (!sources.length) return { kind: 'idle' }
    r = await osa(buildScript(sources), [musicArt.id])
  }
  if (!r || r.code !== 0) return { kind: 'idle' }
  const at = (t0 + performance.now()) / 2
  const s = pickSample(parseOutput(r.stdout))
  if (!s || s.state === 'stopped') return { kind: 'idle' }
  if (s.state === 'denied') return { kind: 'denied', source: s.source }
  return { kind: 'track', track: toTrack(s as TrackSample, at) }
}

function toTrack(s: TrackSample, at: number): Track {
  let artwork: string | null
  if (s.source === 'music') {
    if (s.art !== '=') musicArt = { id: s.id, src: s.art ? mediaUrl(s.art) : null }
    artwork = musicArt.src
  } else {
    artwork = /^https?:\/\//.test(s.art) ? s.art : null
  }
  return {
    source: s.source,
    playing: s.state === 'playing',
    title: s.title,
    artist: s.artist,
    album: s.album,
    durationMs: s.durationMs,
    positionMs: s.positionMs,
    at,
    id: s.id,
    artwork,
  }
}

const wanted = () =>
  nowPlayingSupported() && !document.hidden && [...demand.values()].some(Boolean)

function schedule(delay?: number) {
  if (timer) clearTimeout(timer)
  timer = null
  if (!wanted()) return
  const np = useNowPlaying.getState().np
  const playing = np.kind === 'track' && np.track.playing
  timer = setTimeout(tick, delay ?? (playing ? 1000 : 3000))
}

async function tick() {
  timer = null
  if (inFlight || !wanted()) return
  inFlight = true
  try {
    const np = await sample()
    useNowPlaying.setState({ np })
  } finally {
    inFlight = false
  }
  schedule()
}

if (typeof document !== 'undefined')
  document.addEventListener('visibilitychange', () => schedule(document.hidden ? undefined : 0))

/** A Now playing widget says whether it's on screen. The first visible one
 *  starts polling straight away; when none is, polling stops. */
export function setNowPlayingDemand(id: string, visible: boolean) {
  const before = wanted()
  demand.set(id, visible)
  if (!before && wanted()) schedule(0)
}
export function dropNowPlayingDemand(id: string) {
  demand.delete(id)
  if (!wanted()) schedule()
}

export type Control = 'playpause' | 'next' | 'previous'
const VERB: Record<Control, string> = {
  playpause: 'playpause',
  next: 'next track',
  previous: 'previous track',
}

/** Play/pause, next or previous in the app being shown. Never launches it. */
export async function control(source: Source, what: Control) {
  const app = APP_NAME[source]
  // flip the button at once; the next poll confirms it
  if (what === 'playpause') {
    const np = useNowPlaying.getState().np
    if (np.kind === 'track' && np.track.source === source) {
      const now = performance.now()
      const t = np.track
      useNowPlaying.setState({
        np: { kind: 'track', track: { ...t, playing: !t.playing, positionMs: positionNow(t, now), at: now } },
      })
    }
  }
  await osa(`if application "${app}" is running then tell application "${app}" to ${VERB[what]}`)
  schedule(what === 'playpause' ? 400 : 250)
}
