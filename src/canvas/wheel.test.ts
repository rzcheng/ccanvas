import { describe, expect, it } from 'vitest'
import { axisOf, decide, wheelDelta, zoomFactor, type Gesture } from './wheel'

const g = (region: Gesture['region'], axis: Gesture['axis'], sideToCanvas = false): Gesture => ({
  region,
  axis,
  sideToCanvas,
})

describe('axisOf', () => {
  it('waits until the movement is big enough to read', () => {
    expect(axisOf(2, -3)).toBeNull()
    expect(axisOf(5, -7)).toBeNull()
  })
  it('tells up/down, sideways and diagonal apart', () => {
    expect(axisOf(0, -12)).toBe('y')
    expect(axisOf(5, 20)).toBe('y')
    expect(axisOf(30, 4)).toBe('x')
    expect(axisOf(30, 25)).toBe('xy')
    expect(axisOf(-12, 14)).toBe('xy')
  })
})

describe('decide', () => {
  it('pans the canvas on the board', () => {
    expect(decide(g('canvas', 'y'), 5, 12, false)).toEqual({ do: 'pan', dx: 5, dy: 12 })
  })
  it('zooms on a surface that does not scroll', () => {
    expect(decide(g('zoom', 'y'), 1, -20, false)).toEqual({ do: 'zoom', dy: -20 })
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
  it('pans sideways on a zoom surface unless something there scrolls sideways', () => {
    expect(decide(g('zoom', 'x', true), 20, 3, false)).toEqual({ do: 'pan', dx: 20, dy: 0 })
    expect(decide(g('zoom', 'x', false), 20, 3, false)).toEqual({ do: 'native' })
  })
  it('leaves scrolling content alone, except a sideways swipe it cannot follow', () => {
    expect(decide(g('content', 'y'), 0, 40, false)).toEqual({ do: 'native' })
    expect(decide(g('content', null), 0, 1, false)).toEqual({ do: 'native' })
    expect(decide(g('content', 'x', false), 30, 0, false)).toEqual({ do: 'native' })
    expect(decide(g('content', 'x', true), 30, 0, false)).toEqual({ do: 'pan', dx: 30, dy: 0 })
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
