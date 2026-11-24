import { describe, expect, it } from 'vitest'
import {
  axisOf,
  decide,
  isMouseWheel,
  track,
  wheelDelta,
  zoomFactor,
  SWIPE_GAIN,
  type Gesture,
  type Tracked,
  type WheelInput,
  type WheelRegion,
} from './wheel'

const g = (region: Gesture['region'], axis: Gesture['axis'], sideToCanvas = false): Gesture => ({
  region,
  axis,
  sideToCanvas,
})

describe('axisOf', () => {
  it('needs a nearly straight swipe (within about 22°) to call it up/down', () => {
    expect(axisOf(0, -12)).toBe('y')
    expect(axisOf(8, 20)).toBe('y')
    expect(axisOf(10, 20)).toBe('xy')
    expect(axisOf(30, 4)).toBe('x')
    expect(axisOf(30, 25)).toBe('xy')
    expect(axisOf(0, 0)).toBe('xy')
  })
})

describe('isMouseWheel', () => {
  it('knows a wheel notch from a trackpad', () => {
    expect(isMouseWheel(1, 0, 3)).toBe(true)
    expect(isMouseWheel(0, 0, 4.000244140625)).toBe(true)
    expect(isMouseWheel(0, 0, -8.00048828125)).toBe(true)
    expect(isMouseWheel(0, 0, 100)).toBe(true)
    expect(isMouseWheel(0, 0, 3)).toBe(false)
    expect(isMouseWheel(0, 2, 100)).toBe(false)
    expect(isMouseWheel(0, 0, 57.5)).toBe(false)
  })
})

describe('track', () => {
  const ev = (t: number, dx: number, dy: number, o: Partial<WheelInput> = {}): WheelInput => ({
    t, x: 100, y: 100, dx, dy, pinch: false, mouse: false, ...o,
  })
  const run = (evs: WheelInput[], regions: WheelRegion[] = ['zoom']) => {
    let g: Tracked | null = null
    let i = 0
    const out: Tracked[] = []
    for (const e of evs) {
      g = track(g, e, () => regions[Math.min(i++, regions.length - 1)], () => false)
      out.push(g)
    }
    return out
  }
  it('holds until it has moved enough to read the direction', () => {
    const [a, b] = run([ev(0, 1, -5), ev(10, 1, -12)])
    expect(a.axis).toBeNull()
    expect(b.axis).toBe('y')
  })
  it('decides after a short wait even if the movement is tiny, and pans if unclear', () => {
    const [, b] = run([ev(0, 2, -2), ev(70, 2, -2)])
    expect(b.axis).toBe('xy')
  })
  it('reads a diagonal that starts nearly straight as a diagonal', () => {
    const gs = run([ev(0, 1, -6), ev(8, 4, -6), ev(16, 5, -6)])
    const g = gs[gs.length - 1]
    expect(g.axis).toBe('xy')
  })
  it('keeps the gesture through a short pause, so a pan stays a pan', () => {
    const gs = run([ev(0, 0, 20), ev(300, 0, 20)], ['canvas', 'zoom'])
    expect(gs[1].region).toBe('canvas')
  })
  it('starts a new gesture after a long pause, a pointer move, or a pinch', () => {
    expect(run([ev(0, 0, 20), ev(700, 0, 20)], ['canvas', 'zoom'])[1].region).toBe('zoom')
    expect(run([ev(0, 0, 20), ev(20, 0, 20, { x: 140 })], ['canvas', 'zoom'])[1].region).toBe('zoom')
    expect(run([ev(0, 0, 20), ev(20, 0, 2, { pinch: true })], ['canvas', 'zoom'])[1].region).toBe('zoom')
  })
  it('turns a zoom into a pan when the fingers drift well sideways, never back', () => {
    const gs = run([ev(0, 0, -20), ev(10, 15, -15), ev(20, 15, -15), ev(30, 15, -15), ev(40, 0, -20)])
    expect(gs[0].axis).toBe('y')
    expect(gs[3].axis).toBe('xy')
    expect(gs[4].axis).toBe('xy')
  })
  it('keeps zooming through the small wobble of a straight swipe', () => {
    const gs = run([ev(0, 0, -20), ev(10, 4, -12), ev(20, -3, -12), ev(30, 5, -12), ev(40, 2, -12)])
    expect(gs.map((g) => g.axis)).toEqual(['y', 'y', 'y', 'y', 'y'])
  })
  it('pans a fast fling even when it is straight up/down', () => {
    expect(run([ev(0, 1, -40)])[0].axis).toBe('xy')
    expect(run([ev(0, 0, -10), ev(8, 1, -12)])[1].axis).toBe('y')
  })
  it('zooms straight away on a mouse wheel notch', () => {
    expect(run([ev(0, 0, 4.000244140625, { mouse: true })])[0].axis).toBe('y')
  })
})

describe('decide', () => {
  it('pans the canvas on the board', () => {
    expect(decide(g('canvas', 'y'), 5, 12, false)).toEqual({ do: 'pan', dx: 5, dy: 12 })
  })
  it('zooms on a surface that does not scroll', () => {
    expect(decide(g('zoom', 'y'), 1, -20, false)).toEqual({ do: 'zoom', dy: -20 * SWIPE_GAIN })
  })
  it('pans a diagonal swipe on a zoom surface the way the fingers move', () => {
    expect(decide(g('zoom', 'xy'), 12, -14, false)).toEqual({ do: 'pan', dx: 12, dy: -14 })
  })
  it('lets scrolling content take a diagonal swipe', () => {
    expect(decide(g('content', 'xy', true), 12, -14, false)).toEqual({ do: 'native' })
  })
  it('holds a zoom-surface gesture until its direction is known', () => {
    expect(decide(g('zoom', null), 1, 2, false)).toEqual({ do: 'hold' })
  })
  it('pans a sideways start every way the fingers go, not just sideways', () => {
    expect(decide(g('zoom', 'x', true), 2, -25, false)).toEqual({ do: 'pan', dx: 2, dy: -25 })
  })
  it('pans sideways on a zoom surface unless something there scrolls sideways', () => {
    expect(decide(g('zoom', 'x', true), 20, 3, false)).toEqual({ do: 'pan', dx: 20, dy: 3 })
    expect(decide(g('zoom', 'x', false), 20, 3, false)).toEqual({ do: 'native' })
  })
  it('leaves scrolling content alone, except a sideways swipe it cannot follow', () => {
    expect(decide(g('content', 'y'), 0, 40, false)).toEqual({ do: 'native' })
    expect(decide(g('content', null), 0, 1, false)).toEqual({ do: 'native' })
    expect(decide(g('content', 'x', false), 30, 0, false)).toEqual({ do: 'native' })
    expect(decide(g('content', 'x', true), 30, 12, false)).toEqual({ do: 'pan', dx: 30, dy: 12 })
  })
  it('zooms the canvas on a pinch everywhere but outside the app regions', () => {
    for (const r of ['canvas', 'zoom', 'content'] as const)
      expect(decide(g(r, 'y'), 0, -4, true)).toEqual({ do: 'zoom', dy: -4 })
    expect(decide(g('pass', 'y'), 0, -4, true)).toEqual({ do: 'native' })
  })
  it('never touches panels, menus and dialogs', () => {
    expect(decide(g('pass', 'y'), 0, 40, false)).toEqual({ do: 'native' })
  })
})

describe('zoomFactor', () => {
  it('zooms in on an upward scroll and out on a downward one', () => {
    expect(zoomFactor(-10)).toBeGreaterThan(1)
    expect(zoomFactor(10)).toBeLessThan(1)
  })
  it('caps a big mouse-wheel notch', () => {
    expect(zoomFactor(1000)).toBe(zoomFactor(100))
  })
})

describe('wheelDelta', () => {
  const ev = (deltaX: number, deltaY: number, deltaMode: number) =>
    ({ deltaX, deltaY, deltaMode }) as WheelEvent
  it('converts lines and pages to pixels', () => {
    expect(wheelDelta(ev(1, 2, 0), { w: 800, h: 600 })).toEqual({ dx: 1, dy: 2 })
    expect(wheelDelta(ev(1, 2, 1), { w: 800, h: 600 })).toEqual({ dx: 16, dy: 32 })
    expect(wheelDelta(ev(0, 1, 2), { w: 800, h: 600 })).toEqual({ dx: 0, dy: 600 })
  })
})
