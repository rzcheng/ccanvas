// Layers: a tab's stack of planes (see README → Layers). Pure helpers only —
// no store, no DOM — so the model rules live in one place:
//  • An element's `layer` is missing for the base layer, so single-layer
//    canvases (and every file from before layers) are unchanged.
//  • `ws.layers` is materialised only once a second layer exists.
//  • A layer may carry its own folder (`dir`) and remembers its own camera.
// The overview's card-file geometry (ported from the layers prototype) is at
// the bottom: a few hundred multiplications per layout, no DOM reads.

import type { Camera, CanvasElement, Layer, Workspace } from './types'
import type { AgentStatus } from './agents'
import { boundsOfMany, clamp } from './geometry'

export const BASE_LAYER_ID = 'base'
/** the digit keys jump to layers, so the stack stops at nine */
export const MAX_LAYERS = 9

const BASE: Layer = { id: BASE_LAYER_ID, name: 'base' }

/** The tab's layers, bottom first. A tab without any is one implicit base layer. */
export function layersOf(ws: Workspace): Layer[] {
  return ws.layers && ws.layers.length ? ws.layers : [BASE]
}

export const hasLayers = (ws: Workspace) => !!ws.layers && ws.layers.length >= 2

/** The layer being shown. Falls back to the bottom layer if the id is stale. */
export function activeLayerId(ws: Workspace): string {
  const ls = layersOf(ws)
  return ws.activeLayerId && ls.some((l) => l.id === ws.activeLayerId)
    ? ws.activeLayerId
    : ls[0].id
}

export const layerOf = (el: CanvasElement): string => el.layer ?? BASE_LAYER_ID

export const onLayer = (el: CanvasElement, id: string) => layerOf(el) === id

/** Elements on the layer being shown. */
export function activeLayerElements(ws: Workspace): CanvasElement[] {
  if (!hasLayers(ws)) return ws.elements
  const id = activeLayerId(ws)
  return ws.elements.filter((e) => layerOf(e) === id)
}

export function layerIndex(ws: Workspace, id: string): number {
  return layersOf(ws).findIndex((l) => l.id === id)
}

export function findLayer(ws: Workspace, id: string): Layer | undefined {
  return layersOf(ws).find((l) => l.id === id)
}

/** "02" for the second layer from the bottom. */
export const layerNumber = (i: number) => String(i + 1).padStart(2, '0')

/** The folder new widgets on this layer open in: the layer's, else the tab's. */
export function layerDir(ws: Workspace, id: string = activeLayerId(ws)): string | undefined {
  return findLayer(ws, id)?.dir ?? ws.dir
}

const trimSlash = (p: string) => p.replace(/[\\/]+$/, '')
/** Is `path` the folder `dir` or inside it? */
export function pathWithin(dir: string, path: string): boolean {
  const d = trimSlash(dir)
  const p = trimSlash(path)
  return p === d || p.startsWith(d + '/') || p.startsWith(d + '\\')
}

/**
 * The layer whose own folder contains `cwd` (the deepest such folder wins), or
 * null when none does. Used to sort desktop mirrors onto their project's layer.
 */
export function layerForPath(ws: Workspace, cwd: string | undefined): string | null {
  if (!cwd || !hasLayers(ws)) return null
  let best: Layer | null = null
  for (const l of layersOf(ws))
    if (l.dir && pathWithin(l.dir, cwd) && (!best || l.dir.length > best.dir!.length)) best = l
  return best?.id ?? null
}

/**
 * Repair a tab's layer list after loading: every layer id that elements use
 * gets an entry (an older build may have dropped `layers` while keeping the
 * elements' ids), and the active id is clamped. A tab left with fewer than two
 * layers goes back to having none, so it saves exactly as before layers.
 */
export function normalizeLayers(ws: Workspace): Workspace {
  const used = new Set<string>()
  for (const e of ws.elements) if (e.layer) used.add(e.layer)
  const have = ws.layers?.filter((l) => l && typeof l.id === 'string') ?? []
  if (!have.length && ![...used].some((id) => id !== BASE_LAYER_ID)) {
    if (ws.layers === undefined && ws.activeLayerId === undefined) return ws
    const { layers: _l, activeLayerId: _a, ...rest } = ws
    return rest
  }
  const layers = have.some((l) => l.id === BASE_LAYER_ID) ? [...have] : [{ ...BASE }, ...have]
  for (const id of used)
    if (!layers.some((l) => l.id === id)) layers.push({ id, name: `layer ${layers.length + 1}` })
  const activeLayerId = layers.some((l) => l.id === ws.activeLayerId)
    ? ws.activeLayerId
    : layers[0].id
  return { ...ws, layers, activeLayerId }
}

/** "~/p/rootop" for a folder under the home directory. */
export function shortPath(p: string): string {
  return trimSlash(p).replace(/^\/(Users|home)\/[^/]+(?=\/|$)/, '~')
}

/** A fresh, unused layer id. */
export function newLayerId(ws: Workspace): string {
  const taken = new Set(layersOf(ws).map((l) => l.id))
  for (;;) {
    const id = 'L-' + Math.random().toString(36).slice(2, 7)
    if (!taken.has(id)) return id
  }
}

/** Where to land on a layer: its remembered view, else framing its content. */
export function landingCamera(ws: Workspace, id: string, vw: number, vh: number): Camera {
  const saved = findLayer(ws, id)?.camera
  if (saved) return saved
  const b = boundsOfMany(ws.elements.filter((e) => layerOf(e) === id))
  if (!b) return { x: vw / 2, y: vh / 2, zoom: 1 }
  const pad = 90
  const zoom = clamp(Math.min(vw / (b.w + pad * 2), vh / (b.h + pad * 2)), 0.1, 1)
  return { zoom, x: vw / 2 - (b.x + b.w / 2) * zoom, y: vh / 2 - (b.y + b.h / 2) * zoom }
}

// ---------- status roll-up ----------

export type LedStatus = AgentStatus | 'done'
export type LayerStats = { count: number; working: number; waiting: number; done: number; idle: number }

const isTerm = (e: CanvasElement) =>
  e.type === 'widget' && (e.kind === 'terminal' || e.kind === 'agent')

/** Widget count and agent LEDs on one layer, for the chip and the overview. */
export function layerStatus(
  ws: Workspace,
  id: string,
  statusOf: (widgetId: string) => LedStatus | undefined,
): LayerStats {
  const st: LayerStats = { count: 0, working: 0, waiting: 0, done: 0, idle: 0 }
  for (const e of ws.elements) {
    if (e.type !== 'widget' || layerOf(e) !== id) continue
    st.count++
    if (!isTerm(e)) continue
    const s = statusOf(e.id)
    if (s === 'working') st.working++
    else if (s === 'waiting') st.waiting++
    else if (s === 'done') st.done++
    else if (s === 'idle') st.idle++
  }
  return st
}

/** The LED a whole layer shows: waiting beats working beats done. */
export function layerLed(st: LayerStats): LedStatus | null {
  return st.waiting ? 'waiting' : st.working ? 'working' : st.done ? 'done' : null
}

// ---------- overview geometry (the card file) ----------
//
// One perspective stage holds every layer as a viewport-sized sheet at
// translate3d(0, 0, z_i), tilted back by TILT and scaled by k. Each sheet shows
// a strip `g` px tall; the focused sheet lifts and the ones above it move up by
// a reveal gap so it is fully visible. Everything is in screen px, converted
// to stage units with u = k·sin(TILT).

export const OV = {
  TILT: 58, // deg, rotateX of the stage
  PERSP: 2600, // px; keep in sync with .lo-view in layers.css
  PO_Y: 0.42, // perspective-origin y; keep in sync with .lo-view
  COMPRESS: 0.62, // the resting stack is tighter than the solver's maximum
  SLAB: 6, // screen px between plates while collapsed on open
  MAG_MAX: 28, // cursor spread: extra px at the cursor
  MAG_SIGMA: 64, // cursor spread: falloff px
  FAR: 900, // how far other sheets fly on a dive (stage px)
  HEAD_H: 62,
  FOOT_H: 64,
  RAIL_X: 18,
} as const

const RAD = Math.PI / 180

export type OvGeom = {
  n: number
  W: number
  H: number
  k: number
  /** screen px per stage unit of Z */
  u: number
  /** strip, reveal gap and lift, in stage units */
  G: number
  R: number
  LIFT: number
  focus: number
  /** extra Z per gap from the cursor spread (gap j sits between sheets j and j+1) */
  boost: number[]
  /** stage translateY that centres the stack */
  Y: number
}

/** Screen position of point (x, y) on a sheet lifted to z, replicating the CSS. */
export function ovProject(g: OvGeom, x: number, y: number, z: number, Y: number) {
  const cx = g.W / 2
  const cy = g.H / 2
  const c = Math.cos(OV.TILT * RAD)
  const s = Math.sin(OV.TILT * RAD)
  const X = (x - cx) * g.k
  const Yl = (y - cy) * g.k
  const Z = z * g.k
  const y2 = Yl * c - Z * s
  const z2 = Yl * s + Z * c
  const X3 = X + cx
  const Y3 = y2 + cy + Y
  const f = OV.PERSP / (OV.PERSP - z2)
  const ox = g.W / 2
  const oy = g.H * OV.PO_Y
  return { x: ox + (X3 - ox) * f, y: oy + (Y3 - oy) * f }
}

function params(g: OvGeom, k: number, sc: number) {
  const cosT = Math.cos(OV.TILT * RAD)
  const sinT = Math.sin(OV.TILT * RAD)
  const avail = (g.H - OV.HEAD_H - OV.FOOT_H) * sc
  const sheetH = g.H * k * cosT
  const strip = (g.n > 2 ? clamp((avail - 2 * sheetH - 40) / (g.n - 2), 42, 120) : 110) * OV.COMPRESS
  const lift = 16
  const reveal = Math.max(0, sheetH - strip + lift + 18)
  g.k = k
  g.u = k * sinT
  g.G = strip / g.u
  g.R = reveal / g.u
  g.LIFT = lift / g.u
}

/** Z of sheet i without the cursor spread. */
export function ovZBase(g: OvGeom, i: number): number {
  return i * g.G + (i > g.focus ? g.R : 0) + (i === g.focus ? g.LIFT : 0)
}

/** Z of sheet i, including the cursor spread of every gap below it. */
export function ovZ(g: OvGeom, i: number): number {
  let b = 0
  for (let j = 0; j < i; j++) b += g.boost[j] || 0
  return ovZBase(g, i) + b
}

function extents(g: OvGeom, Y: number) {
  let top = Infinity
  let bottom = -Infinity
  let left = Infinity
  for (let i = 0; i < g.n; i++) {
    const z = ovZ(g, i)
    const a = ovProject(g, 0, 0, z, Y)
    const b = ovProject(g, 0, g.H, z, Y)
    top = Math.min(top, a.y)
    bottom = Math.max(bottom, b.y)
    left = Math.min(left, a.x, b.x)
  }
  return { top, bottom, left }
}

/** Stage Y that keeps the stack centred between header and footer. */
export function ovStageY(g: OvGeom): number {
  const target = (OV.HEAD_H + g.H - OV.FOOT_H) / 2
  let Y = 0
  for (let it = 0; it < 3; it++) {
    const e = extents(g, Y)
    Y += target - (e.top + e.bottom) / 2
  }
  return Y
}

/**
 * Solve the layout once per open or resize: the largest sheets whose stack
 * fits between header and footer and clears the rail, shrinking the strips
 * first and then k. (Perspective enlarges near sheets past a naive estimate,
 * which is why this projects instead of estimating.)
 */
export function ovSolve(n: number, W: number, H: number, focus: number, railW: number): OvGeom {
  const g: OvGeom = { n, W, H, k: 0.56, u: 1, G: 0, R: 0, LIFT: 0, focus: 0, boost: [], Y: 0 }
  const availH = H - OV.HEAD_H - OV.FOOT_H + 4 - OV.MAG_MAX * 1.6
  const railEnd = OV.RAIL_X + railW + 34
  solve: for (let k = 0.6; k >= 0.3; k -= 0.02) {
    for (let sc = 1; sc >= 0.5; sc -= 0.04) {
      params(g, k, sc)
      const e = extents(g, ovStageY(g))
      if (e.bottom - e.top <= availH) {
        if (e.left >= railEnd) break solve
        break
      }
    }
  }
  g.focus = clamp(focus, 0, n - 1)
  g.Y = ovStageY(g)
  return g
}

/** Cursor spread: the gaps nearest the pointer open up (Gaussian falloff).
 *  Measured against the un-spread layout, so the sheet under the pointer
 *  doesn't slide away from it. `y` null = no pointer, everything closes. */
export function ovBoost(g: OvGeom, y: number | null): number[] {
  const B = OV.MAG_MAX / g.u
  const s2 = 2 * OV.MAG_SIGMA * OV.MAG_SIGMA
  const out: number[] = []
  for (let j = 0; j < g.n - 1; j++) {
    if (y == null) {
      out.push(0)
      continue
    }
    const mid = (ovProject(g, 0, g.H, ovZBase(g, j), g.Y).y + ovProject(g, 0, g.H, ovZBase(g, j + 1), g.Y).y) / 2
    const d = y - mid
    out.push(B * Math.exp(-(d * d) / s2))
  }
  return out
}

/** Where a sheet's rail label sits: the projected near-left corner, and the
 *  length of the 1px leader drawn from the label to that corner. */
export function ovRailTarget(g: OvGeom, i: number, railW: number) {
  const p = ovProject(g, 0, g.H, ovZ(g, i), g.Y)
  return { y: p.y, lead: Math.max(0, p.x - OV.RAIL_X - railW - 3) }
}

/** Fit a layer's content into a sheet (90% × 84% of the viewport). */
export function ovFit(els: CanvasElement[], W: number, H: number): Camera {
  const b = boundsOfMany(els)
  if (!b) return { x: W / 2, y: H / 2, zoom: 1 }
  const zoom = Math.min((W * 0.9) / Math.max(1, b.w), (H * 0.84) / Math.max(1, b.h), 1.4)
  return { zoom, x: W / 2 - (b.x + b.w / 2) * zoom, y: H / 2 - (b.y + b.h / 2) * zoom }
}
