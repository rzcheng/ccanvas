import { describe, expect, it } from 'vitest'
import { spreadRects } from './stacks'
import { SWAP_HYST, moveTo, previewSlots, targetSlot, type Rect } from './spreadDrag'

const center = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })
const VW = 1440
const VH = 900
const slotsFor = (n: number) => spreadRects(n, VW, VH, 16 / 10)

describe('targetSlot', () => {
  it('stays put over its own slot and takes a slot it is clearly over', () => {
    const slots = slotsFor(3)
    expect(targetSlot(slots, center(slots[0]), 0)).toBe(0)
    expect(targetSlot(slots, center(slots[2]), 0)).toBe(2)
  })

  it('needs to get past the halfway line by the dead band before swapping', () => {
    const slots = slotsFor(2)
    const a = center(slots[0])
    const b = center(slots[1])
    const mid = (a.x + b.x) / 2
    const band = SWAP_HYST * Math.min(slots[0].w, slots[0].h)
    // just past halfway: still slot 0
    expect(targetSlot(slots, { x: mid + band / 2 - 2, y: a.y }, 0)).toBe(0)
    // clearly past: slot 1
    expect(targetSlot(slots, { x: mid + band / 2 + 2, y: a.y }, 0)).toBe(1)
    // and the same band on the way back
    expect(targetSlot(slots, { x: mid - band / 2 + 2, y: a.y }, 1)).toBe(1)
    expect(targetSlot(slots, { x: mid - band / 2 - 2, y: a.y }, 1)).toBe(0)
  })

  it('picks the nearest slot outright with no current slot', () => {
    const slots = slotsFor(3)
    const a = center(slots[0])
    const b = center(slots[1])
    expect(targetSlot(slots, { x: (a.x + b.x) / 2 + 1, y: a.y }, null)).toBe(1)
  })

  // A pointer jiggling a few px either side of every boundary, for every
  // layout the spread uses: the target may change at most once per boundary.
  for (const n of [2, 3, 5, 8]) {
    it(`never ping-pongs on a boundary with ${n} cards`, () => {
      const slots = slotsFor(n)
      for (let i = 0; i < n; i++)
        for (let j = 0; j < n; j++) {
          if (i === j) continue
          const a = center(slots[i])
          const b = center(slots[j])
          const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
          const len = Math.hypot(b.x - a.x, b.y - a.y)
          const u = { x: (b.x - a.x) / len, y: (b.y - a.y) / len }
          for (const start of [i, j]) {
            let cur = start
            let flips = 0
            for (let t = 0; t < 200; t++) {
              const wiggle = Math.sin(t * 1.7) * 6 + Math.cos(t * 0.9) * 3
              const next = targetSlot(slots, { x: mid.x + u.x * wiggle, y: mid.y + u.y * wiggle }, cur)
              if (next !== cur) flips++
              cur = next
            }
            expect(flips).toBeLessThanOrEqual(1)
          }
        }
    })

    it(`always takes a slot once over its centre with ${n} cards`, () => {
      const slots = slotsFor(n)
      for (let cur = 0; cur < n; cur++)
        for (let dest = 0; dest < n; dest++) expect(targetSlot(slots, center(slots[dest]), cur)).toBe(dest)
    })
  }
})

describe('preview order', () => {
  const ids = ['a', 'b', 'c', 'd']

  it('moves an id to an index', () => {
    expect(moveTo(ids, 'a', 2)).toEqual(['b', 'c', 'a', 'd'])
    expect(moveTo(ids, 'd', 0)).toEqual(['d', 'a', 'b', 'c'])
    expect(moveTo(ids, 'b', 9)).toEqual(['a', 'c', 'd', 'b'])
  })

  it('lays the others out around the target; the dragged card keeps its own base', () => {
    const m = previewSlots(ids, { id: 'a', to: 2 })
    expect(m.get('b')).toEqual({ base: 0, slot: 0 })
    expect(m.get('c')).toEqual({ base: 1, slot: 1 })
    expect(m.get('d')).toEqual({ base: 3, slot: 3 })
    expect(m.get('a')).toEqual({ base: 0, slot: 2 })
  })

  it('is the plain order with no drag', () => {
    const m = previewSlots(ids, null)
    ids.forEach((id, i) => expect(m.get(id)).toEqual({ base: i, slot: i }))
  })
})
