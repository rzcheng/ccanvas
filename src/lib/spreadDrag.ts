// Dragging a card in a stack's spread view. Pure geometry, no DOM or store:
// the hook in widgets/useSpreadCardDrag.ts feeds it pointer positions and the
// spread's slots and applies what comes back.
//
// The slots are captured once, when the drag starts, and never move while it
// lasts. The order is only a preview (which slot the dragged card would take)
// until the card is let go, so a card sliding aside can never end up under the
// pointer and swap straight back.

export type Pt = { x: number; y: number }
export type Rect = { x: number; y: number; w: number; h: number }

/** how far past the halfway line to the next slot the card has to go before
 *  it takes that slot, as a fraction of a slot's shorter side */
export const SWAP_HYST = 0.24

const center = (r: Rect): Pt => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)

/**
 * The slot a card centred at `p` should take. It only leaves `current` once
 * `p` is clearly nearer another slot: the halfway line between two slots has a
 * dead band of `hyst` × the slot's shorter side, so a hand jiggling on the
 * line never flips the order back and forth. `current` null picks the
 * nearest slot outright.
 */
export function targetSlot(slots: Rect[], p: Pt, current: number | null, hyst = SWAP_HYST): number {
  if (!slots.length) return 0
  let best = 0
  let bestD = Infinity
  slots.forEach((s, i) => {
    const d = dist(p, center(s))
    if (d < bestD) {
      bestD = d
      best = i
    }
  })
  if (current == null || current < 0 || current >= slots.length || best === current) return best
  const cur = slots[current]
  const band = hyst * Math.min(cur.w, cur.h)
  return dist(p, center(cur)) - bestD > band ? best : current
}

/** `ids` with `id` moved to index `to`. */
export function moveTo(ids: string[], id: string, to: number): string[] {
  const out = ids.filter((x) => x !== id)
  out.splice(Math.max(0, Math.min(to, out.length)), 0, id)
  return out
}

/**
 * Which slot each member shows in while a card is dragged. The dragged card
 * keeps its own slot as a base (it is moved from there by the pointer); the
 * rest fill the other slots in order around its target.
 */
export function previewSlots(
  ids: string[],
  drag: { id: string; to: number | null } | null | undefined,
): Map<string, { base: number; slot: number }> {
  const out = new Map<string, { base: number; slot: number }>()
  const from = drag ? ids.indexOf(drag.id) : -1
  if (!drag || from < 0) {
    ids.forEach((id, i) => out.set(id, { base: i, slot: i }))
    return out
  }
  const order = drag.to == null ? ids : moveTo(ids, drag.id, drag.to)
  order.forEach((id, i) => out.set(id, { base: i, slot: i }))
  out.set(drag.id, { base: from, slot: drag.to ?? from })
  return out
}
