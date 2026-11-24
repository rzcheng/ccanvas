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
//             Now playing. Up/down zooms the canvas around the pointer;
//             sideways pans it, unless something under the pointer scrolls
//             sideways (the tab strip).
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
// A gesture keeps the region and direction it started with until the wheel
// rests for REST_MS, so momentum never flips between scrolling and zooming as
// things move under the pointer.

export type WheelRegion = 'canvas' | 'zoom' | 'content' | 'pass'

export type WheelAction =
  | { do: 'native' } // let the event through untouched
  | { do: 'hold' } // swallow it: the gesture's direction isn't known yet
  | { do: 'pan'; dx: number; dy: number }
  | { do: 'zoom'; dy: number }

/** a gesture as decided at its start */
export type Gesture = {
  region: WheelRegion
  /** 'x' for a clearly sideways swipe, 'y' otherwise; null until it's moved far enough to tell */
  axis: 'x' | 'y' | null
  /** a sideways gesture moves the canvas (nothing under the pointer scrolls that way) */
  sideToCanvas: boolean
}

export const REST_MS = 150
/** px of movement before a gesture's direction is decided */
const AXIS_MIN = 4

/** 'x' when the movement is clearly sideways, 'y' otherwise, null while too small to tell */
export function axisOf(dx: number, dy: number): 'x' | 'y' | null {
  const ax = Math.abs(dx)
  const ay = Math.abs(dy)
  if (ax < AXIS_MIN && ay < AXIS_MIN) return null
  return ax > ay * 1.5 ? 'x' : 'y'
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
      if (g.axis === 'y') return { do: 'zoom', dy }
      return g.sideToCanvas ? { do: 'pan', dx, dy: 0 } : { do: 'native' }
    case 'content':
      return g.axis === 'x' && g.sideToCanvas ? { do: 'pan', dx, dy: 0 } : { do: 'native' }
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

/** The gesture in progress: decided on its first event, kept until the wheel rests. */
let current: (Gesture & { t: number; target: Element | null; root: Element | null }) | null = null

/** Route one wheel event: what it should do, keeping the gesture it belongs to. */
export function routeWheel(e: WheelEvent, page: { w: number; h: number }, now = performance.now()): WheelAction {
  const { dx, dy } = wheelDelta(e, page)
  if (current && now - current.t > REST_MS) current = null
  if (!current) {
    const target = e.target as Element | null
    const { region, root } = regionAt(target)
    current = { region, root, target, axis: null, sideToCanvas: false, t: now }
  }
  current.t = now
  if (current.axis === null) {
    current.axis = axisOf(dx, dy)
    if (current.axis === 'x' && current.target && current.root)
      current.sideToCanvas = !canScrollX(current.target, current.root, dx)
  }
  return decide(current, dx, dy, e.ctrlKey || e.metaKey)
}
