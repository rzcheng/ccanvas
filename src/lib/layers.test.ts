import { describe, expect, it } from 'vitest'
import type { CanvasElement, Workspace } from './types'
import {
  BASE_LAYER_ID,
  OV,
  activeLayerElements,
  activeLayerId,
  hasLayers,
  landingCamera,
  layerDir,
  layerForPath,
  layerOf,
  layerStatus,
  layersOf,
  glyphCounts,
  labelSpots,
  matchesQuery,
  widgetGlyph,
  widgetType,
  normalizeLayers,
  ovBoost,
  ovProject,
  ovRailTarget,
  ovSolve,
  ovZ,
  ovZBase,
  pathWithin,
  shortPath,
} from './layers'
import { fromFile, toFile } from './persistence'

const note = (id: string, layer?: string, x = 0, y = 0): CanvasElement => ({
  id,
  type: 'widget',
  kind: 'note',
  x,
  y,
  w: 100,
  h: 80,
  z: 1,
  title: id,
  ...(layer ? { layer } : {}),
})
const term = (id: string, layer?: string): CanvasElement => ({ ...note(id, layer), kind: 'terminal' }) as CanvasElement

const ws = (over: Partial<Workspace> = {}): Workspace => ({
  id: 't',
  name: 't',
  elements: [],
  camera: { x: 0, y: 0, zoom: 1 },
  createdAt: 0,
  ...over,
})

const layered = () =>
  ws({
    dir: '/Users/me/p/main',
    layers: [
      { id: 'base', name: 'base' },
      { id: 'L-a', name: 'rootop', dir: '/Users/me/p/rootop' },
      { id: 'L-b', name: 'site' },
    ],
    activeLayerId: 'L-a',
    elements: [note('n1'), note('n2', 'L-a'), term('t1', 'L-a'), note('n3', 'L-b')],
  })

describe('layer basics', () => {
  it('a tab without layers is one implicit base layer', () => {
    const w = ws({ elements: [note('a')] })
    expect(layersOf(w).map((l) => l.id)).toEqual([BASE_LAYER_ID])
    expect(hasLayers(w)).toBe(false)
    expect(activeLayerId(w)).toBe(BASE_LAYER_ID)
    expect(activeLayerElements(w)).toBe(w.elements)
  })

  it('elements without a layer are on the base layer', () => {
    expect(layerOf(note('a'))).toBe(BASE_LAYER_ID)
    expect(layerOf(note('a', 'L-x'))).toBe('L-x')
  })

  it('filters to the active layer and falls back from a stale id', () => {
    const w = layered()
    expect(activeLayerElements(w).map((e) => e.id)).toEqual(['n2', 't1'])
    expect(activeLayerId({ ...w, activeLayerId: 'gone' })).toBe('base')
  })

  it("a layer's folder falls back to the tab's", () => {
    const w = layered()
    expect(layerDir(w, 'L-a')).toBe('/Users/me/p/rootop')
    expect(layerDir(w, 'L-b')).toBe('/Users/me/p/main')
    expect(layerDir(w)).toBe('/Users/me/p/rootop') // the active layer
  })
})

describe('layerForPath', () => {
  const w = ws({
    dir: '/Users/me/p',
    layers: [
      { id: 'base', name: 'base' },
      { id: 'a', name: 'p', dir: '/Users/me/p' },
      { id: 'b', name: 'rootop', dir: '/Users/me/p/rootop/' },
    ],
  })
  it('picks the deepest folder that contains the path', () => {
    expect(layerForPath(w, '/Users/me/p/rootop/src')).toBe('b')
    expect(layerForPath(w, '/Users/me/p/rootop')).toBe('b')
    expect(layerForPath(w, '/Users/me/p/other')).toBe('a')
  })
  it("doesn't match a sibling folder that only shares a prefix", () => {
    expect(layerForPath(w, '/Users/me/p/rootop-v2')).toBe('a')
    expect(pathWithin('/a/b', '/a/bc')).toBe(false)
    expect(pathWithin('/a/b', '/a/b/c')).toBe(true)
  })
  it('returns null with no match, no path, or no layers', () => {
    expect(layerForPath(w, '/elsewhere')).toBeNull()
    expect(layerForPath(w, undefined)).toBeNull()
    expect(layerForPath(ws(), '/Users/me/p')).toBeNull()
  })
})

describe('normalizeLayers', () => {
  it('leaves a single-layer tab untouched (same object)', () => {
    const w = ws({ elements: [note('a')] })
    expect(normalizeLayers(w)).toBe(w)
  })
  it('drops a degenerate layer list so the tab saves as before', () => {
    const w = ws({ elements: [note('a')], layers: [{ id: 'base', name: 'base' }], activeLayerId: 'base' })
    const n = normalizeLayers(w)
    expect(n.layers).toBeUndefined()
    expect(n.activeLayerId).toBeUndefined()
  })
  it('rebuilds entries for ids an older build kept on elements', () => {
    const n = normalizeLayers(ws({ elements: [note('a'), note('b', 'L-x'), note('c', 'L-y')] }))
    expect(n.layers!.map((l) => [l.id, l.name])).toEqual([
      ['base', 'base'],
      ['L-x', 'layer 2'],
      ['L-y', 'layer 3'],
    ])
    expect(n.activeLayerId).toBe('base')
  })
  it('adds a missing base and clamps a stale active id', () => {
    const n = normalizeLayers(
      ws({ layers: [{ id: 'L-x', name: 'x' }], activeLayerId: 'nope', elements: [note('b', 'L-x')] }),
    )
    expect(n.layers!.map((l) => l.id)).toEqual(['base', 'L-x'])
    expect(n.activeLayerId).toBe('base')
  })
})

describe('persistence', () => {
  it('a single-layer canvas saves byte-identical to before layers', () => {
    const file = {
      format: 'ccnvs' as const,
      version: 1 as const,
      name: 'old',
      camera: { x: 1, y: 2, zoom: 0.5 },
      elements: [note('a')],
    }
    const text = JSON.stringify(file, null, 2)
    expect(JSON.stringify(toFile(fromFile(JSON.parse(text), 'old')), null, 2)).toBe(text)
  })
  it('a layered canvas round-trips, and writes layers only then', () => {
    const w = layered()
    const f = toFile(w)
    expect(f.layers).toHaveLength(3)
    expect(f.activeLayer).toBe('L-a')
    const back = toFile(fromFile(JSON.parse(JSON.stringify(f)), 'x'))
    expect(back).toEqual(f)
    expect(toFile(ws({ elements: [note('a')] }))).not.toHaveProperty('layers')
  })
})

describe('landingCamera', () => {
  it('prefers the remembered view, else frames the content, else centres', () => {
    const w = layered()
    w.layers![2].camera = { x: 5, y: 6, zoom: 0.7 }
    expect(landingCamera(w, 'L-b', 1000, 800)).toEqual({ x: 5, y: 6, zoom: 0.7 })
    const framed = landingCamera(w, 'L-a', 1000, 800)
    expect(framed.zoom).toBeGreaterThan(0)
    expect(framed.zoom).toBeLessThanOrEqual(1)
    expect(landingCamera(ws({ layers: [{ id: 'base', name: 'b' }, { id: 'e', name: 'e' }] }), 'e', 1000, 800)).toEqual({
      x: 500,
      y: 400,
      zoom: 1,
    })
  })
})

describe('layerStatus', () => {
  it('counts widgets and rolls up agent LEDs on one layer', () => {
    const w = layered()
    w.elements.push(term('t2', 'L-a'), term('t3', 'L-a'))
    const st = layerStatus(w, 'L-a', (id) => ({ t1: 'working', t2: 'waiting', t3: 'done' })[id] as never)
    expect(st).toEqual({ count: 4, working: 1, waiting: 1, done: 1, idle: 0 })
  })
})

describe('shortPath', () => {
  it('abbreviates the home folder', () => {
    expect(shortPath('/Users/me/p/rootop/')).toBe('~/p/rootop')
    expect(shortPath('/home/me')).toBe('~')
    expect(shortPath('/opt/x')).toBe('/opt/x')
  })
})

describe('overview solver', () => {
  const RAIL = 236
  for (const [n, W, H] of [
    [2, 1280, 780],
    [3, 1440, 860],
    [5, 1440, 860],
    [9, 1280, 780],
    [9, 900, 600],
  ] as const) {
    it(`${n} layers in ${W}×${H} fit between header and footer`, () => {
      const g = ovSolve(n, W, H, n - 1, RAIL)
      expect(g.k).toBeGreaterThanOrEqual(0.29)
      expect(g.k).toBeLessThanOrEqual(0.6)
      let top = Infinity
      let bottom = -Infinity
      for (let i = 0; i < n; i++) {
        top = Math.min(top, ovProject(g, 0, 0, ovZ(g, i), g.Y).y)
        bottom = Math.max(bottom, ovProject(g, 0, H, ovZ(g, i), g.Y).y)
      }
      // centred between the header and the footer, within a pixel
      expect(Math.abs((top + bottom) / 2 - (OV.HEAD_H + H - OV.FOOT_H) / 2)).toBeLessThan(1)
      if (g.k > 0.3) expect(bottom - top).toBeLessThanOrEqual(H - OV.HEAD_H - OV.FOOT_H + 4)
    })
  }

  it('stacks sheets upward with the focused one lifted and revealed', () => {
    const g = ovSolve(4, 1280, 800, 1, RAIL)
    const z = [0, 1, 2, 3].map((i) => ovZBase(g, i))
    expect(z).toEqual([...z].sort((a, b) => a - b))
    expect(z[2] - z[1]).toBeGreaterThan(z[1] - z[0]) // the reveal gap sits above the focus
  })

  it('the cursor spread peaks at the gap under the pointer and closes with no pointer', () => {
    const g = ovSolve(5, 1280, 800, 2, RAIL)
    const rail = [0, 1, 2, 3, 4].map((i) => ovRailTarget(g, i, RAIL).y)
    const y = (rail[0] + rail[1]) / 2
    const b = ovBoost(g, y)
    expect(b).toHaveLength(4)
    expect(b.indexOf(Math.max(...b))).toBe(0)
    expect(ovBoost(g, null).every((v) => v === 0)).toBe(true)
  })
})

describe('glyphs, types and find', () => {
  const ed = { ...note('e'), kind: 'editor', title: 'editor', path: 'src/ui/LayerOverview.tsx' } as CanvasElement
  const mirror = { ...note('m'), kind: 'transcript', title: 'Build Layers', mirrorOf: 'desktop' } as CanvasElement
  const web = { ...note('w'), kind: 'web', title: 'preview', url: 'http://localhost:5173/app' } as CanvasElement
  it('names what a widget is at a glance', () => {
    expect(widgetGlyph(term('t'))).toBe('shell')
    expect(widgetGlyph(mirror)).toBe('mirror')
    expect(widgetType(ed)).toBe('LayerOverview.tsx')
    expect(widgetType(web)).toBe('localhost:5173')
    expect(glyphCounts([term('a'), term('b'), ed, mirror])).toEqual([
      ['mirror', 1],
      ['shell', 2],
      ['code', 1],
    ])
  })
  it('find matches every word across title, type, path and url', () => {
    expect(matchesQuery(ed, 'overview')).toBe(true)
    expect(matchesQuery(ed, 'editor tsx')).toBe(true)
    expect(matchesQuery(ed, 'editor rust')).toBe(false)
    expect(matchesQuery(web, '5173')).toBe(true)
    expect(matchesQuery(mirror, 'desktop')).toBe(true)
  })
})

describe('labelSpots', () => {
  const box = (id: string, x: number, y: number, w = 400, h = 300) => ({ id, x, y, w, h })
  it('centres a label nothing covers', () => {
    expect(labelSpots([box('a', 0, 0)], 120, 50).get('a')).toEqual([0.5, 0.5, 0.88])
  })
  it('moves a covered label to a free part of its tile', () => {
    // b covers the lower-right of a, including its centre
    const s = labelSpots([box('a', 0, 0), box('b', 150, 120)], 120, 50)
    expect(s.get('a')).toEqual([0.5, 0.3, 0.88])
    expect(s.get('b')).toEqual([0.5, 0.5, 0.88]) // topmost: always centred
  })
  it('falls back to a free half, at half width, when the middle is covered', () => {
    // b covers the right half of a, top to bottom
    const s = labelSpots([box('a', 0, 0), box('b', 200, -10, 400, 400)], 150, 50)
    expect(s.get('a')).toEqual([0.27, 0.5, 0.46])
  })
  it('hides the label of a fully covered tile', () => {
    const s = labelSpots([box('a', 50, 50, 100, 100), box('b', 0, 0)], 60, 30)
    expect(s.get('a')).toBeNull()
  })
})

describe('loading odd layer lists', () => {
  it('keeps the first of duplicate ids and names unnamed layers', () => {
    const n = normalizeLayers(
      ws({
        layers: [{ id: 'base', name: 'base' }, { id: 'L-a', name: 'a' }, { id: 'L-a', name: 'dup' }, { id: 'L-b' } as never],
        elements: [note('x', 'L-a')],
      }),
    )
    expect(n.layers!.map((l) => [l.id, l.name])).toEqual([
      ['base', 'base'],
      ['L-a', 'a'],
      ['L-b', 'layer 3'],
    ])
  })
  it('an unknown active layer falls back to the bottom; an empty layer survives a round trip', () => {
    const f = toFile(ws({ layers: [{ id: 'base', name: 'base' }, { id: 'L-e', name: 'empty' }], activeLayerId: 'L-e' }))
    const back = fromFile({ ...JSON.parse(JSON.stringify(f)), activeLayer: 'gone' }, 'x')
    expect(back.layers!.map((l) => l.id)).toEqual(['base', 'L-e'])
    expect(back.activeLayerId).toBe('base')
  })
})
