// Wheel routing: every two-finger scroll, pinch and mouse wheel over the app
// goes to exactly one place, decided by the region under the pointer when the
// gesture starts.
//
// Regions are declared in the DOM. The nearest ancestor with `data-wheel`
// decides, except that anything inside a `data-wheel-lock` element is a zoom
// surface:
//
//   canvas    the board itself: scrolling pans, a pinch (or ⌘-scroll) zooms.
//   zoom      a surface that doesn't scroll: the app's bars, widget title bars,
//             a widget you haven't clicked into (WidgetFrame locks its body),
//             Now playing. A steady, straight up/down swipe zooms the canvas
//             around the pointer; a fast fling or a diagonal or sideways
//             swipe pans it the way the fingers move (sideways only scrolls something under the pointer
//             that scrolls that way, like the tab strip).
//   content   something that scrolls itself: xterm, Monaco, the plot. It gets
//             the wheel; a sideways swipe it can't follow pans the canvas; a
//             pinch still zooms the canvas.
//   auto      an entered widget's body: content where something under the
//             pointer scrolls up and down (a chat's message list), zoom where
//             nothing does (its header, tabs, empty space).
//   (none)    panels, menus, dialogs, the layers overview: left alone.
//
// A new widget gets all of this from WidgetFrame. It only needs a
// `data-wheel="content"` on an element that scrolls without native overflow
// (a canvas, a virtualised list, an editor) or handles the wheel itself.
//
// A gesture keeps the region it started in, and its direction once known,
// until it really ends: LATCH_MS without a wheel event, the pointer moving, or
// a pinch starting or stopping. A short pause mid-pan, or the gap before
// momentum starts, doesn't end it, so the board sliding under a still pointer
// never turns a pan into a zoom. Pan is the safe default: a gesture holds at
// most HOLD_MS before deciding, an unclear one pans, and a zoom whose fingers
// drift sideways turns into a pan (never the other way).
//
// Prior art: browsers latch wheel gestures the same way (Chromium 500 ms and
// 10 px of pointer movement, Firefox 1.5 s); MapLibre tells a mouse wheel from
// a trackpad by its deltas.

export type WheelRegion = 'canvas' | 'zoom' | 'content' | 'pass'

export type WheelAction =
  | { do: 'native' } // let the event through untouched
  | { do: 'hold' } // swallow it: the gesture's direction isn't known yet
  | { do: 'pan'; dx: number; dy: number }
  | { do: 'zoom'; dy: number }

/** a gesture as decided at its start */
export type Gesture = {
  region: WheelRegion
  /** 'y' for a clearly up/down swipe, 'x' for a clearly sideways one, 'xy'
   *  for a diagonal; null until it's moved far enough to tell */
  axis: 'x' | 'y' | 'xy' | null
  /** a sideways gesture moves the canvas (nothing under the pointer scrolls that way) */
  sideToCanvas: boolean
}

/** a gesture ends after this long without a wheel event */
export const LATCH_MS = 600
/** … or when the pointer moves this far (a trackpad scroll doesn't move it) */
const MOVE_END = 10
/** px of movement before a gesture's direction is decided */
const AXIS_MIN = 16
/** … or this long after it starts, whatever has arrived by then */
const HOLD_MS = 60
/** a zoom turns into a pan once it has moved this far since deciding … */
const DRIFT_MIN = 40
/** … with sideways movement past this share of the vertical (about 37°) */
const DRIFT_RATIO = 0.75
/** a swipe moving this many px per event when its direction is read is a
 *  fling across the board, so it pans even if it's straight up/down */
const FAST_PER_EVENT = 24
/** a straight swipe on a zoom surface zooms this much more than ⌘-scroll */
export const SWIPE_GAIN = 1.4

/** The direction of a movement: 'y' within about 22° of straight up/down,
 *  'x' within about 34° of sideways, 'xy' between (and for no movement). */
export function axisOf(dx: number, dy: number): 'x' | 'y' | 'xy' {
  const ax = Math.abs(dx)
  const ay = Math.abs(dy)
  if (ay > 0 && ay >= ax * 2.4) return 'y'
  if (ax > ay * 1.5) return 'x'
  return 'xy'
}

/** A mouse wheel rather than a trackpad: line-mode deltas, or a purely
 *  vertical delta that is a whole notch (Chrome on macOS sends multiples of
 *  4.000244; most wheels send 50 or more, always whole numbers). */
export function isMouseWheel(deltaMode: number, deltaX: number, deltaY: number): boolean {
  if (deltaMode === 1) return true
  if (deltaX !== 0 || deltaY === 0) return false
  const ay = Math.abs(deltaY)
  const notch = 4.000244140625
  return Math.abs(ay / notch - Math.round(ay / notch)) < 1e-6 || (ay >= 50 && Number.isInteger(ay))
}

/** one wheel event, as the tracker sees it */
export type WheelInput = {
  /** the event's own timestamp, so a slow frame doesn't look like a pause */
  t: number
  x: number
  y: number
  dx: number
  dy: number
  pinch: boolean
  mouse: boolean
}

export type Tracked = Gesture & {
  t0: number
  t: number
  x: number
  y: number
  pinch: boolean
  /** movement summed, and events counted, while the direction is undecided */
  sx: number
  sy: number
  n: number
  /** movement since the direction was decided, for the zoom-to-pan fallback */
  ddx: number
  ddy: number
}

/** Fold one event into the gesture in progress, starting a new one if the
 *  last has ended. Pure apart from the two callbacks, which read the DOM:
 *  `start` gives the region under the pointer, `sideScrolls` whether
 *  something under it scrolls sideways by dx. */
export function track(
  prev: Tracked | null,
  ev: WheelInput,
  start: () => WheelRegion,
  sideScrolls: (dx: number) => boolean,
): Tracked {
  const ended =
    !prev ||
    ev.t - prev.t > LATCH_MS ||
    Math.hypot(ev.x - prev.x, ev.y - prev.y) > MOVE_END ||
    ev.pinch !== prev.pinch
  const g: Tracked = ended
    ? {
        region: start(),
        axis: null,
        sideToCanvas: false,
        t0: ev.t,
        t: ev.t,
        x: ev.x,
        y: ev.y,
        pinch: ev.pinch,
        sx: 0,
        sy: 0,
        n: 0,
        ddx: 0,
        ddy: 0,
      }
    : { ...prev, t: ev.t }
  if (g.axis === null) {
    g.sx += ev.dx
    g.sy += ev.dy
    g.n++
    const dist = Math.hypot(g.sx, g.sy)
    if (ev.mouse) g.axis = 'y'
    else if (dist >= AXIS_MIN || ev.t - g.t0 >= HOLD_MS) {
      g.axis = axisOf(g.sx, g.sy)
      // a fast swipe is a fling across the board, never a zoom
      if (g.axis === 'y' && dist / g.n >= FAST_PER_EVENT) g.axis = 'xy'
    }
    if (g.axis === 'x') g.sideToCanvas = !sideScrolls(g.sx)
  } else if (g.axis === 'y' && !ev.mouse) {
    g.ddx += ev.dx
    g.ddy += ev.dy
    if (Math.hypot(g.ddx, g.ddy) >= DRIFT_MIN && Math.abs(g.ddx) > DRIFT_RATIO * Math.abs(g.ddy)) g.axis = 'xy'
  }
  return g
}

/** What one wheel event does, given its gesture. Pure: no DOM, no state. */
export function decide(g: Gesture, dx: number, dy: number, pinch: boolean): WheelAction {
  if (g.region === 'pass') return { do: 'native' }
  if (pinch) return { do: 'zoom', dy }
  switch (g.region) {
    case 'canvas':
      return { do: 'pan', dx, dy }
    case 'zoom':
      if (g.axis === null) return { do: 'hold' }
      if (g.axis === 'y') return { do: 'zoom', dy: dy * SWIPE_GAIN }
      if (g.axis === 'xy') return { do: 'pan', dx, dy }
      // a pan follows the fingers every way, however it started
      return g.sideToCanvas ? { do: 'pan', dx, dy } : { do: 'native' }
    case 'content':
      return g.axis === 'x' && g.sideToCanvas ? { do: 'pan', dx, dy } : { do: 'native' }
  }
}

/** The canvas zoom factor for one event's vertical delta: gentle, and clamped
 *  so a single mouse-wheel notch never jumps far. */
export function zoomFactor(dy: number): number {
  return Math.exp(-Math.max(-100, Math.min(100, dy)) * 0.0017)
}

/** A wheel event's delta in pixels, whatever its delta mode. */
export function wheelDelta(e: WheelEvent, page: { w: number; h: number }): { dx: number; dy: number } {
  const k = e.deltaMode === 1 ? [16, 16] : e.deltaMode === 2 ? [page.w, page.h] : [1, 1]
  return { dx: e.deltaX * k[0], dy: e.deltaY * k[1] }
}

// ---------- the DOM side ----------

const SCROLLS = /^(auto|scroll|overlay)$/

/** Can this element scroll natively by (dx, dy) from where it is now? */
export function canScroll(n: Element, dx: number, dy: number): boolean {
  const s = getComputedStyle(n)
  const y =
    dy !== 0 &&
    SCROLLS.test(s.overflowY) &&
    (dy > 0 ? n.scrollTop + n.clientHeight < n.scrollHeight - 1 : n.scrollTop > 0)
  const x =
    dx !== 0 &&
    SCROLLS.test(s.overflowX) &&
    (dx > 0 ? n.scrollLeft + n.clientWidth < n.scrollWidth - 1 : n.scrollLeft > 0)
  return x || y
}

/** Does this element scroll up and down at all (in either direction)? */
function scrollsY(n: Element): boolean {
  return SCROLLS.test(getComputedStyle(n).overflowY) && n.scrollHeight > n.clientHeight + 1
}

/** Monaco scrolls by moving its own layers, not native overflow: `.view-lines`
 *  is as wide as the scroll width, `.lines-content` sits at -scrollLeft. */
function monacoCanScrollX(ed: Element, dx: number): boolean {
  const sc = ed.querySelector<HTMLElement>('.editor-scrollable')
  const content = sc?.querySelector<HTMLElement>('.lines-content')
  const lines = content?.querySelector<HTMLElement>('.view-lines')
  if (!sc || !content || !lines) return false
  const left = -parseFloat(content.style.left) || 0
  const max = (parseFloat(lines.style.width) || 0) - sc.clientWidth
  return dx > 0 ? left < max - 1 : left > 0
}

/** Can anything between the pointer and `root` scroll sideways by dx? */
export function canScrollX(target: Element, root: Element, dx: number): boolean {
  const ed = target.closest('.monaco-editor')
  if (ed && root.contains(ed)) return monacoCanScrollX(ed, dx)
  for (let n: Element | null = target; n && n !== root.parentElement; n = n.parentElement) {
    if (canScroll(n, dx, 0)) return true
  }
  return false
}

/** The region under the pointer, and the element that declares it. */
export function regionAt(target: Element | null): { region: WheelRegion; root: Element | null } {
  if (!target?.closest) return { region: 'pass', root: null }
  const lock = target.closest('[data-wheel-lock]')
  if (lock) return { region: 'zoom', root: lock }
  const root = target.closest('[data-wheel]')
  if (!root) return { region: 'pass', root: null }
  const v = (root as HTMLElement).dataset.wheel
  if (v === 'canvas' || v === 'zoom' || v === 'content') return { region: v, root }
  if (v === 'auto') {
    for (let n: Element | null = target; n && n !== root.parentElement; n = n.parentElement) {
      if (scrollsY(n)) return { region: 'content', root }
    }
    return { region: 'zoom', root }
  }
  return { region: 'pass', root: null }
}

/** the gesture in progress, and where it started */
let current: Tracked | null = null
let startTarget: Element | null = null
let startRoot: Element | null = null

/** Route one wheel event: what it should do, keeping the gesture it belongs to. */
export function routeWheel(e: WheelEvent, page: { w: number; h: number }): WheelAction {
  const { dx, dy } = wheelDelta(e, page)
  const pinch = e.ctrlKey || e.metaKey
  current = track(
    current,
    {
      t: e.timeStamp || performance.now(),
      x: e.clientX,
      y: e.clientY,
      dx,
      dy,
      pinch,
      mouse: isMouseWheel(e.deltaMode, e.deltaX, e.deltaY),
    },
    () => {
      startTarget = e.target as Element | null
      const r = regionAt(startTarget)
      startRoot = r.root
      return r.region
    },
    (sx) => !!startTarget && !!startRoot && canScrollX(startTarget, startRoot, sx),
  )
  return decide(current, dx, dy, pinch)
}
