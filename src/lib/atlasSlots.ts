// A fix for stray glyphs in WebGL terminals (xterm's WebGL addon 0.19).
//
// The addon keeps its glyphs in atlas pages, each uploaded to a GPU texture
// slot, and re-uploads a slot only when its page's version differs from the
// version the slot last got. Versions count draws per page, so full pages end
// up with nearly the same number. When pages merge, the pages after them move
// down a slot and their version goes up by one, which often lands on exactly
// the version the slot already holds: the slot keeps the old page, and cells
// drawn from it show slivers of other glyphs. Programs that paint many colours
// in half blocks (rootop, image viewers) fill and merge pages constantly, and
// WebKit merges far more often than Chromium, so the app showed it most.
//
// Upstream gives every page a unique version (addon 0.20, still in beta). Until
// that ships, the glyph renderer also notes which page each slot holds and
// re-uploads a slot whenever the page in it changed.

type Page = { canvas: unknown; version: number }
type Slot = { version: number }
type GlyphRenderer = {
  _atlas?: { pages: Page[] }
  _atlasTextures?: Slot[]
  __slotPages?: unknown[]
  render(model: unknown): void
  _bindAtlasPageTexture(gl: unknown, atlas: { pages: Page[] }, i: number): void
}

const GUARDED = Symbol.for('ccanvas.atlasSlotGuard')

/** Mark every texture slot that holds a different page than the atlas has at
 *  that index as stale, so the renderer uploads it again. */
export function staleSlots(r: Pick<GlyphRenderer, '_atlas' | '_atlasTextures' | '__slotPages'>): number {
  const pages = r._atlas?.pages
  const slots = r._atlasTextures
  if (!pages || !slots) return 0
  let n = 0
  for (let i = 0; i < pages.length && i < slots.length; i++) {
    if (r.__slotPages?.[i] !== pages[i].canvas && slots[i].version !== -1) {
      slots[i].version = -1
      n++
    }
  }
  return n
}

/** Patch the glyph renderer class behind a loaded WebglAddon, once per page
 *  load. Does nothing when the addon's internals aren't the expected shape. */
export function guardAtlasSlots(addon: unknown): boolean {
  const renderer = (addon as { _renderer?: { _glyphRenderer?: { value?: GlyphRenderer } } })?._renderer
  const glyphs = renderer?._glyphRenderer?.value
  if (!glyphs) return false
  const proto = Object.getPrototypeOf(glyphs) as GlyphRenderer & { [GUARDED]?: true }
  if (proto[GUARDED]) return true
  if (typeof proto.render !== 'function' || typeof proto._bindAtlasPageTexture !== 'function') return false
  if (!Array.isArray(glyphs._atlasTextures)) return false

  const bind = proto._bindAtlasPageTexture
  const render = proto.render
  proto._bindAtlasPageTexture = function (this: GlyphRenderer, gl, atlas, i) {
    ;(this.__slotPages ??= [])[i] = atlas.pages[i]?.canvas
    return bind.call(this, gl, atlas, i)
  }
  proto.render = function (this: GlyphRenderer, model) {
    staleSlots(this)
    return render.call(this, model)
  }
  proto[GUARDED] = true
  return true
}
