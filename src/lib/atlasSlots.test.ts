import { describe, expect, it } from 'vitest'
import { guardAtlasSlots, staleSlots } from './atlasSlots'

// A stand-in for the addon's glyph renderer with the same upload rule:
// a slot is uploaded only when its page's version differs from the slot's.
class FakeGlyphs {
  _atlas: { pages: { canvas: object; version: number }[] }
  _atlasTextures: { version: number; holds?: object }[]
  constructor(pages: { canvas: object; version: number }[]) {
    this._atlas = { pages }
    this._atlasTextures = Array.from({ length: 8 }, () => ({ version: -1 }))
  }
  render(_model: unknown) {
    for (let i = 0; i < this._atlas.pages.length; i++)
      if (this._atlas.pages[i].version !== this._atlasTextures[i].version) this._bindAtlasPageTexture(null, this._atlas, i)
  }
  _bindAtlasPageTexture(_gl: unknown, atlas: FakeGlyphs['_atlas'], i: number) {
    this._atlasTextures[i].holds = atlas.pages[i].canvas
    this._atlasTextures[i].version = atlas.pages[i].version
  }
}
const page = (version: number) => ({ canvas: {}, version })
// what xterm 0.19 does when pages merge: delete one, the rest move down a slot
// and go up one version
function deletePage(pages: { canvas: object; version: number }[], at: number) {
  pages.splice(at, 1)
  for (let j = at; j < pages.length; j++) pages[j].version++
}
const wrong = (g: FakeGlyphs) => g._atlas.pages.filter((p, i) => g._atlasTextures[i].holds !== p.canvas).length

describe('atlas texture slots', () => {
  it('without the guard, a page that moves into a slot with its new version is never uploaded', () => {
    class Plain extends FakeGlyphs {}
    const g = new Plain([page(208), page(209), page(208)])
    g.render(null)
    deletePage(g._atlas.pages, 0) // page 1 (209→210) moves to slot 0; page 2 (208→209) to slot 1
    g.render(null)
    expect(wrong(g)).toBe(1) // slot 1 still holds the old 209 page
  })

  it('with the guard, every slot holds the page the atlas has there', () => {
    class Guarded extends FakeGlyphs {}
    const g = new Guarded([page(208), page(209), page(208)])
    expect(guardAtlasSlots({ _renderer: { _glyphRenderer: { value: g } } })).toBe(true)
    g.render(null)
    deletePage(g._atlas.pages, 0)
    g.render(null)
    expect(wrong(g)).toBe(0)
  })

  it('patches the class once and leaves unknown shapes alone', () => {
    class Guarded extends FakeGlyphs {}
    const a = new Guarded([page(1)])
    const addon = { _renderer: { _glyphRenderer: { value: a } } }
    expect(guardAtlasSlots(addon)).toBe(true)
    const render = Guarded.prototype.render
    expect(guardAtlasSlots(addon)).toBe(true)
    expect(Guarded.prototype.render).toBe(render)
    expect(guardAtlasSlots({})).toBe(false)
    expect(guardAtlasSlots({ _renderer: { _glyphRenderer: { value: {} } } })).toBe(false)
  })

  it('marks only slots whose page changed', () => {
    const p = [page(3), page(4)]
    const r = { _atlas: { pages: p }, _atlasTextures: [{ version: 3 }, { version: 4 }], __slotPages: [p[0].canvas, {}] }
    expect(staleSlots(r)).toBe(1)
    expect(r._atlasTextures.map((s) => s.version)).toEqual([3, -1])
  })
})
