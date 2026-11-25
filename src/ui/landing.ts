// Landing on a layer: the real widgets' content arrives instead of popping
// in. The overview's tiles land as cards (frame, title bar and a body in the
// widget's status lamp, data-st), and as it hands over (a dive, or a close
// back onto the layer you're on) each widget on screen takes that card off,
// top of the screen first: the lamp slides down off the body behind a soft
// edge, and a terminal or agent under it types its real output in, row by
// row behind a block cursor.
//
// Nothing on the widgets changes: covers (the lamp; for a terminal, covers in
// its own background and the cursor) are laid over each body, and only their transform
// moves, on its own layer, so the content under it is never repainted. The
// covers are laid on hidden a few frames early (`prepLanding`, at the start
// of a frame while layout is clean), shown in the same frame the overview's
// stand-ins step aside (`startLanding`), and removed as each one finishes.
// It runs on its own loop, so it outlives the overview, which unmounts as
// soon as its backdrop has faded. A new overview cancels it.

import { clamp01, easeOut } from '../lib/layers'

type Job = {
  body: HTMLElement
  /** a terminal: the covers over the rows below and the rest of the row, then the cursor; else one cover */
  parts: HTMLElement[]
  /** lays them on (after every read of a batch, so no read is forced) */
  make: () => HTMLElement[]
  delay: number
  dur: number
  type?: {
    /** visible rows, top to bottom: y and height and characters, in body px */
    rows: Array<{ y: number; h: number; n: number }>
    total: number
    cw: number
    w: number
    h: number
    ox: number
    oy: number
  }
  /** a fill: the body's height, in its own px */
  bh: number
}

type Pending = { body: HTMLElement; r: DOMRect; delay: number }

const MAX_JOBS = 40
/** widgets laid on per frame while preparing */
const PER_FRAME = 4
/** the wave down the screen: the bottom starts this much after the top */
const WAVE = 110
const FILL = 260
const FEATHER = 24

let jobs: Job[] = []
let queue: Pending[] = []
let prepped = false
let t0 = 0
let slow = 1
let raf = 0

const reduced = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** Lay the covers on, hidden, over every widget on screen, a few widgets a
 *  frame (each new layer costs the frame something). Reads layout, so call
 *  it at the start of frames, before anything is written, until it starts. */
export function prepLanding(): void {
  if (raf || reduced()) return
  if (!prepped) {
    prepped = true
    queue = onScreen()
  }
  prepSome(PER_FRAME)
}

/** The bodies of the widgets on screen, top of the screen first. */
function onScreen(): Pending[] {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const found: Array<{ body: HTMLElement; r: DOMRect }> = []
  for (const w of document.querySelectorAll<HTMLElement>('.canvas .widget[data-widget-id]')) {
    if (w.classList.contains('widget--offlayer') || w.classList.contains('widget--stack-hidden')) continue
    const body = w.querySelector<HTMLElement>(':scope > .widget__body')
    if (!body) continue
    const r = body.getBoundingClientRect()
    if (r.width < 8 || r.height < 8 || r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) continue
    found.push({ body, r })
  }
  found.sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left)
  return found.slice(0, MAX_JOBS).map(({ body, r }) => ({ body, r, delay: WAVE * clamp01(Math.max(0, r.top) / vh) }))
}

function prepSome(n: number) {
  // read the whole batch, then write it
  const batch: Job[] = []
  for (const { body, r, delay } of queue.splice(0, n)) {
    if (!body.isConnected) continue
    // a body that moved since it was listed is read again
    const now = body.getBoundingClientRect()
    const rr = now.top === r.top && now.left === r.left && now.width === r.width ? r : now
    batch.push(lamp(body, rr, delay))
    const typing = readTerminal(body, rr, delay)
    if (typing) batch.push(typing)
  }
  for (const j of batch) j.parts = j.make()
  jobs.push(...batch)
}

/** Show the covers and start them. Returns whether anything is landing (if
 *  not, the overview hands over the old way). */
export function startLanding(now: number, slowBy = 1): boolean {
  if (!prepped || raf) return false
  prepped = false
  // whatever wasn't laid on yet (a short lead-in)
  prepSome(queue.length)
  if (!jobs.length) return false
  t0 = now
  slow = slowBy
  for (const j of jobs) for (const n of j.parts) n.style.visibility = ''
  step(now)
  return jobs.length > 0
}

/** Take every cover off at once (the overview is opening again). */
export function cancelLanding(): void {
  if (raf) cancelAnimationFrame(raf)
  raf = 0
  prepped = false
  queue = []
  for (const j of jobs) for (const n of j.parts) n.remove()
  jobs = []
}

function step(now: number) {
  raf = 0
  const el = (now - t0) / slow
  jobs = jobs.filter((j) => {
    const v = clamp01((el - j.delay) / j.dur)
    if (v >= 1) {
      for (const n of j.parts) n.remove()
      return false
    }
    if (j.type) typeAt(j, v)
    else {
      // decelerating: the edge slows as it reaches the bottom
      const y = -FEATHER + easeOut(v) * (j.bh + FEATHER)
      j.parts[0].style.transform = `translate3d(0, ${y.toFixed(1)}px, 0)`
    }
    return true
  })
  if (jobs.length) raf = requestAnimationFrame(step)
}

/** A terminal at `v` (0 → 1): whole characters typed so far, at an even
 *  pace, and the row they reach. */
function typeAt(j: Job, v: number) {
  const t = j.type!
  const typed = Math.floor(v * t.total)
  let acc = 0
  let k = 0
  while (k < t.rows.length && acc + t.rows[k].n <= typed) acc += t.rows[k++].n
  const done = k >= t.rows.length
  const row = t.rows[Math.min(k, t.rows.length - 1)]
  const x = done ? t.w : (typed - acc) * t.cw
  const y0 = done ? t.h : row.y
  const y1 = done ? t.h : row.y + row.h
  const [below, rest, cursor] = j.parts
  below.style.transform = `translate3d(${t.ox}px, ${t.oy + y1}px, 0)`
  rest.style.transform = `translate3d(${t.ox + x}px, ${t.oy + y0}px, 0)`
  rest.style.height = `${row.h}px`
  cursor.style.transform = `translate3d(${t.ox + x}px, ${t.oy + y0}px, 0)`
  cursor.style.opacity = done ? '0' : '1'
}

const part = (body: HTMLElement, cls: string) => {
  const n = document.createElement('div')
  n.className = cls
  n.style.visibility = 'hidden'
  body.appendChild(n)
  return n
}

/** A terminal or agent's visible rows (DOM renderer), in the body's own px.
 *  Null if there's nothing to read (zoomed out to a status card, not
 *  started yet, empty): it fills like anything else. */
function readTerminal(body: HTMLElement, br: DOMRect, delay: number): Job | null {
  if (body.querySelector(':scope > .term-card')) return null
  const screen = body.querySelector<HTMLElement>('.xterm-screen')
  const rowsEl = screen?.querySelector<HTMLElement>('.xterm-rows')
  if (!screen || !rowsEl || !screen.offsetWidth || !body.offsetWidth) return null
  // the camera's zoom (the terminal's own scale inside the body differs)
  const k = br.width / body.offsetWidth
  if (!(k > 0)) return null
  const sr = screen.getBoundingClientRect()
  const rows: NonNullable<Job['type']>['rows'] = []
  let cw = 0
  let total = 0
  let lines = 0
  for (const node of Array.from(rowsEl.children) as HTMLElement[]) {
    const n = (node.textContent ?? '').replace(/\s+$/, '').length
    const rr = node.getBoundingClientRect()
    if (rr.top >= br.bottom) break
    rows.push({ y: (rr.top - sr.top) / k, h: rr.height / k, n })
    total += n
    if (n) lines++
    // a cell's width, from the first character on screen (monospace)
    if (!cw && n) {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
      for (let tn = walker.nextNode(); tn; tn = walker.nextNode()) {
        if (!tn.textContent) continue
        const range = document.createRange()
        range.setStart(tn, 0)
        range.setEnd(tn, 1)
        cw = range.getBoundingClientRect().width / k
        break
      }
    }
  }
  if (!total || !(cw > 0) || !rows.length) return null
  // the covers take the terminal's own background (xterm's viewport is
  // see-through: the colour is on the terminal's wrapper)
  const bg = opaque(body.querySelector('.xterm-viewport'), body.firstElementChild, body)
  const sw = body.offsetWidth
  const sh = body.offsetHeight
  const make = () => {
    const below = part(body, 'ld-cover')
    below.style.cssText += `;width:${sw}px;height:${sh}px;background:${bg}`
    const rest = part(body, 'ld-cover')
    rest.style.cssText += `;width:${sw}px;background:${bg}`
    const cursor = part(body, 'ld-cursor')
    cursor.style.width = `${cw}px`
    cursor.style.height = `${rows[0].h}px`
    return [below, rest, cursor]
  }
  return {
    body,
    parts: [],
    make,
    delay,
    // a line or two is a flick of keystrokes; a full screen never drags
    dur: Math.min(460, Math.max(180, 120 + lines * 14)),
    type: {
      rows,
      total,
      cw,
      w: sr.width / k,
      h: sr.height / k,
      ox: (sr.left - br.left) / k,
      oy: (sr.top - br.top) / k,
    },
    bh: sh,
  }
}

/** The card: one cover in the widget's lamp colour (the widget's data-st,
 *  global.css) slides down off the body. */
function lamp(body: HTMLElement, br: DOMRect, delay: number): Job {
  const bh = body.offsetHeight || br.height
  const make = () => {
    const cover = part(body, 'ld-cover ld-cover--lamp')
    cover.style.cssText += `;width:100%;height:${bh + FEATHER}px`
    cover.style.transform = `translate3d(0, ${-FEATHER}px, 0)`
    return [cover]
  }
  return { body, parts: [], make, delay, dur: FILL, bh }
}

/** The first of these with a background you can't see through. */
function opaque(...nodes: Array<Element | null>): string {
  for (const n of nodes) {
    if (!n) continue
    const c = getComputedStyle(n).backgroundColor
    if (c && c !== 'transparent' && !/^rgba\(.*,\s*0\)$/.test(c)) return c
  }
  return getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#000'
}
