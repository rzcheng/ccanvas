import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useStore, selectActive } from '../store/workspace'
import { useAgents, useDisplayStatus, RECENT_FINISH_MS } from '../lib/agents'
import type { Camera, CanvasElement, WidgetElement } from '../lib/types'
import {
  OV,
  MAX_LAYERS,
  activeLayerId,
  landingCamera,
  layerDir,
  layerNumber,
  layerOf,
  layerStatus,
  layersOf,
  ovBoost,
  ovFit,
  ovRailTarget,
  ovSolve,
  ovStageY,
  ovZ,
  ovZBase,
  pathWithin,
  shortPath,
  type LedStatus,
  type OvGeom,
} from '../lib/layers'
import { baseName } from '../lib/backend'
import { IconLayers } from './icons'
import { LayerProxy } from './LayerProxy'
import '../styles/layers.css'

// The layers overview: the canvas tilts back into a card file of every layer
// on this tab, drawn as cheap proxies. Mounted only while open (App.tsx), so
// it costs nothing otherwise: no listeners, timers or rAF.
//
// Ported from the layers prototype. React renders the structure (sheets,
// proxies, rail text); the motion is applied imperatively to refs, as CSS
// transitions on transform and opacity only, so a transition runs with no JS
// per frame. `will-change` is set only while something moves (.lo--moving).

const T = {
  enter: 380,
  focus: 170,
  dive: 320,
  fade: 120,
  tilt: 260, // flat canvas → tilted slab in the middle of the stack
  exDelay: 190, // the fan-out starts as the slab settles
  expand: 440, // slab → card file, springy
  exStagger: 18,
}
const EASE_OUT = 'cubic-bezier(0.16, 1, 0.3, 1)'
const EASE_DIVE = 'cubic-bezier(0.55, 0, 0.1, 1)'
const EASE_FOCUS = 'cubic-bezier(0.2, 0.8, 0.2, 1)'
const EASE_SPRING = 'cubic-bezier(0.34, 1.3, 0.64, 1)' // a small overshoot, then settles
const PROXY_CAP = 60 // per sheet; past this, coloured boxes only
const RAIL_W0 = 236
const GLASS_KEY = 'ccanvas:layers:glass'
const WORD: Record<string, string> = { working: 'working', waiting: 'needs you', idle: 'idle', done: 'done' }

type Rec = {
  el?: HTMLDivElement | null
  sheet?: HTMLDivElement | null
  glass?: HTMLDivElement | null
  world?: HTMLDivElement | null
  dim?: HTMLDivElement | null
  item?: HTMLDivElement | null
  lead?: HTMLDivElement | null
}
type State = 'opening' | 'open' | 'diving'

function camT(c: Camera): string {
  const d = window.devicePixelRatio || 1
  const sn = (v: number) => Math.round(v * d) / d
  return `translate(${sn(c.x)}px, ${sn(c.y)}px) scale(${c.zoom})`
}
function trans(node: HTMLElement | null | undefined, props: string[], dur: number, ease: string, delay = 0) {
  if (!node) return
  node.style.transition = dur ? props.map((p) => `${p} ${dur}ms ${ease} ${delay}ms`).join(', ') : 'none'
}
const STAGE_FLAT = 'translate3d(0, 0, 0) rotateX(0deg) scale3d(1, 1, 1)'
const stageOpen = (g: OvGeom) => `translate3d(0, ${g.Y}px, 0) rotateX(${OV.TILT}deg) scale3d(${g.k}, ${g.k}, ${g.k})`

function prefersReduced(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}
function textScale(): number {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ts'))
  return Number.isFinite(v) && v > 0 ? v : 1.1
}

export function LayerOverview() {
  const ws = useStore(selectActive)
  const layers = layersOf(ws)
  const n = layers.length
  const curId = activeLayerId(ws)
  const curIdx = Math.max(0, layers.findIndex((l) => l.id === curId))

  // agent LEDs for the rail's roll-ups (re-renders only while the overview is up)
  const status = useAgents((s) => s.status)
  const finishedAt = useAgents((s) => s.finishedAt)
  const statusOf = useCallback(
    (id: string): LedStatus | undefined => {
      const st = status[id]
      const f = finishedAt[id]
      return st === 'idle' && f != null && Date.now() - f < RECENT_FINISH_MS ? 'done' : st
    },
    [status, finishedAt],
  )

  const [focus, setFocusState] = useState(curIdx)
  const [frost, setFrost] = useState(() => localStorage.getItem(GLASS_KEY) !== 'solid')
  const [renaming, setRenaming] = useState<string | null>(null)

  const rootRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const bgRef = useRef<HTMLDivElement>(null)
  const headRef = useRef<HTMLDivElement>(null)
  const footRef = useRef<HTMLDivElement>(null)
  const recs = useRef<Rec[]>([])
  const rec = (i: number) => (recs.current[i] ??= {})

  // everything the appliers share; a ref, never state, so motion never re-renders
  const C = useRef({
    state: 'opening' as State,
    g: null as OvGeom | null,
    fits: [] as Camera[],
    top: 0,
    railW: RAIL_W0,
    reduced: prefersReduced(),
    timers: [] as number[],
    busyTimer: 0,
    magRaf: 0,
    magY: null as number | null,
    lastMove: 0,
    n,
    wheel: { acc: 0, step: 0, prev: 0, pinch: 0 },
  })
  const later = (fn: () => void, ms: number) => {
    C.current.timers.push(window.setTimeout(fn, ms))
  }

  // elements per layer, for the sheets and the rail
  const byLayer = useMemo(() => {
    const m = new Map<string, CanvasElement[]>()
    for (const l of layers) m.set(l.id, [])
    for (const e of ws.elements) m.get(layerOf(e))?.push(e)
    return m
  }, [ws.elements, layers])

  // ---------- geometry ----------
  const measure = () => {
    const root = rootRef.current!
    const W = root.clientWidth
    const H = root.clientHeight
    const c = C.current
    c.railW = Math.round((RAIL_W0 * Math.min(textScale(), 1.4)) / 1.1)
    c.g = ovSolve(n, W, H, c.g?.focus ?? focus, c.railW)
    c.top = root.getBoundingClientRect().top
    const stage = stageRef.current!
    stage.style.width = W + 'px'
    stage.style.height = H + 'px'
    // custom properties set once per layout, never per frame
    stage.style.setProperty('--k', String(c.g.k))
    stage.style.setProperty('--uy', String(1 / Math.cos((OV.TILT * Math.PI) / 180)))
    root.style.setProperty('--lr-w', c.railW + 'px')
    c.fits = layers.map((l) => ovFit(byLayer.get(l.id) ?? [], W, H))
    layers.forEach((_, i) => {
      rec(i).world?.style.setProperty('--fs', String(c.fits[i].zoom * c.g!.k))
    })
  }

  const busy = (cls: string, ms: number) => {
    const root = rootRef.current
    if (!root) return
    root.classList.add('lo--moving', 'lo--busy', cls)
    window.clearTimeout(C.current.busyTimer)
    C.current.busyTimer = window.setTimeout(() => root.classList.remove('lo--moving', 'lo--busy', cls), ms)
  }
  const chrome = (on: boolean, dur: number, delay = 0) => {
    for (const node of [bgRef.current, headRef.current, footRef.current]) {
      trans(node, ['opacity'], dur, 'ease', delay)
      if (node) node.style.opacity = on ? '1' : '0'
    }
  }
  const railTarget = (i: number) => ovRailTarget(C.current.g!, i, C.current.railW)
  const placeRail = (i: number, dur: number, ease: string, delay = 0) => {
    const r = rec(i)
    const g = C.current.g!
    const t = railTarget(i)
    trans(r.item, ['transform', 'opacity'], dur, ease, delay)
    if (r.item) {
      r.item.style.transform = `translate3d(0, ${t.y}px, 0)`
      r.item.style.opacity = i === g.focus ? '1' : '0.82'
    }
    trans(r.lead, ['transform'], dur, ease, delay)
    if (r.lead) r.lead.style.transform = `scaleX(${t.lead / 100})`
  }

  /** Open layout: tilted card file, focused sheet lifted and fully revealed.
   *  'grow' = a new layer drops in, 'focus' = focus moved, 'layout' = no motion. */
  const applyOpen = (kind: 'grow' | 'focus' | 'layout') => {
    const g = C.current.g!
    const dur = kind === 'grow' ? T.enter : kind === 'focus' ? T.focus : 0
    const ease = kind === 'grow' ? EASE_OUT : EASE_FOCUS
    g.Y = ovStageY(g)
    const stage = stageRef.current!
    trans(stage, ['transform'], dur, ease)
    stage.style.transform = stageOpen(g)
    for (let i = 0; i < n; i++) {
      const r = rec(i)
      trans(r.el, ['transform'], dur, ease)
      if (r.el) r.el.style.transform = `translate3d(0, 0, ${ovZ(g, i)}px)`
      trans(r.sheet, ['opacity'], kind === 'grow' ? 240 : 0, 'ease')
      if (r.sheet) r.sheet.style.opacity = '1'
      trans(r.dim, ['opacity'], dur, 'ease')
      if (r.dim) r.dim.style.opacity = i === g.focus ? '0' : '1'
      trans(r.glass, ['opacity'], 0, 'ease')
      if (r.glass) {
        r.glass.style.opacity = '1'
        r.glass.style.background = ''
      }
      if (r.world) {
        r.world.style.transition = `transform 0ms, opacity ${T.focus}ms ease`
        r.world.style.transform = camT(C.current.fits[i])
        r.world.style.opacity = ''
      }
      placeRail(i, dur, ease)
    }
  }

  /** Flat layout: sheet j fills the viewport exactly over the live canvas at
   *  `cam`; the others either sit stacked at z=0 ('collapse', frame 0 of the
   *  open) or fly away from you ('fly', a dive). */
  const applyFlat = (j: number, cam: Camera, others: 'collapse' | 'fly', dur: number, ease: string) => {
    const stage = stageRef.current!
    trans(stage, ['transform'], dur, ease)
    stage.style.transform = STAGE_FLAT
    for (let i = 0; i < n; i++) {
      const r = rec(i)
      const me = i === j
      trans(r.el, ['transform'], dur, ease)
      if (r.el)
        r.el.style.transform = `translate3d(0, 0, ${me || others === 'collapse' ? 0 : i > j ? OV.FAR : -OV.FAR}px)`
      trans(r.sheet, ['opacity'], me ? 0 : Math.min(dur, 200), 'ease')
      if (r.sheet) r.sheet.style.opacity = me ? '1' : '0'
      trans(r.dim, ['opacity'], dur ? 120 : 0, 'ease')
      if (r.dim) r.dim.style.opacity = '0'
      trans(r.glass, ['opacity'], dur ? Math.round(dur * 0.6) : 0, 'ease', dur ? Math.round(dur * 0.4) : 0)
      if (r.glass) r.glass.style.opacity = '0'
      if (me || others === 'collapse') {
        trans(r.world, ['transform', 'opacity'], dur, ease)
        if (r.world) {
          r.world.style.transform = camT(cam)
          r.world.style.opacity = me ? '1' : ''
        }
      }
      trans(r.item, ['opacity'], dur ? 110 : 0, 'ease')
      if (r.item) r.item.style.opacity = '0'
    }
  }

  /** Open, step 1: the canvas tilts back into one thin slab of every layer,
   *  centred where the stack will be. Your layer stays on top and drawn; the
   *  others are bare outlines a few px apart. */
  const applySlab = (a: number) => {
    const g = C.current.g!
    const zMid = (ovZBase(g, 0) + ovZBase(g, n - 1)) / 2
    const step = OV.SLAB / g.u
    const wT = T.tilt + 60
    const stage = stageRef.current!
    trans(stage, ['transform'], T.tilt, EASE_OUT)
    stage.style.transform = stageOpen(g)
    for (let i = 0; i < n; i++) {
      const r = rec(i)
      const me = i === a
      trans(r.el, ['transform'], T.tilt, EASE_OUT)
      if (r.el) r.el.style.transform = `translate3d(0, 0, ${zMid + (i - a) * step}px)`
      trans(r.sheet, ['opacity'], 160, 'ease', me ? 0 : 90) // outlines appear once it's tilting
      if (r.sheet) r.sheet.style.opacity = '1'
      trans(r.glass, ['opacity'], 180, 'ease')
      if (r.glass) {
        r.glass.style.opacity = '1'
        r.glass.style.background = me ? '' : 'transparent'
      }
      trans(r.dim, ['opacity'], 0, 'ease')
      if (r.dim) r.dim.style.opacity = '0'
      if (r.world) {
        r.world.style.transition = `transform ${wT}ms ${EASE_OUT}, opacity 160ms ease`
        r.world.style.transform = camT(C.current.fits[i])
        r.world.style.opacity = me ? '' : '0'
      }
    }
  }

  /** Open, step 2: the slab fans out into the card file, nearest layers first,
   *  with a small spring; each plate fills in once it has pulled away. */
  const applyExpand = (a: number) => {
    const g = C.current.g!
    const wT = T.tilt + 60
    for (let i = 0; i < n; i++) {
      const r = rec(i)
      const delay = Math.abs(i - a) * T.exStagger
      trans(r.el, ['transform'], T.expand, EASE_SPRING, delay)
      if (r.el) r.el.style.transform = `translate3d(0, 0, ${ovZ(g, i)}px)`
      if (r.glass) {
        r.glass.style.transition = `opacity 180ms ease, background-color 240ms ease ${110 + delay}ms`
        r.glass.style.background = ''
      }
      if (r.world) {
        r.world.style.transition = `transform ${wT}ms ${EASE_OUT}, opacity 260ms ease ${150 + delay}ms`
        r.world.style.opacity = ''
      }
      trans(r.dim, ['opacity'], 260, 'ease', 150 + delay)
      if (r.dim) r.dim.style.opacity = i === g.focus ? '0' : '1'
      placeRail(i, 300, EASE_OUT, 90 + delay)
    }
  }

  /** Cursor spread: rAF-batched, transforms only. */
  const applyMag = () => {
    const c = C.current
    c.magRaf = 0
    if (c.state !== 'open' || !c.g) return
    c.g.boost = ovBoost(c.g, c.magY)
    for (let i = 0; i < n; i++) {
      const r = rec(i)
      trans(r.el, ['transform'], 180, EASE_FOCUS)
      if (r.el) r.el.style.transform = `translate3d(0, 0, ${ovZ(c.g, i)}px)`
      placeRail(i, 180, EASE_FOCUS)
    }
  }
  const queueMag = (y: number | null) => {
    const c = C.current
    c.magY = y
    if (!c.magRaf) c.magRaf = requestAnimationFrame(applyMag)
  }

  // ---------- actions ----------
  const setFocus = (i: number) => {
    const c = C.current
    if (!c.g || c.state !== 'open') return
    i = Math.max(0, Math.min(n - 1, i))
    if (i === c.g.focus) return
    c.g.focus = i
    setFocusState(i)
    applyOpen(c.reduced ? 'layout' : 'focus')
  }

  const close = () => {
    const root = rootRef.current
    const store = useStore.getState()
    store.setLayerOverview('closing') // the live canvas shows again under the fade
    if (!root) return store.setLayerOverview(false)
    const ms = C.current.reduced ? T.fade : 90
    root.style.transition = `opacity ${ms}ms ease`
    root.style.opacity = '0'
    later(() => useStore.getState().setLayerOverview(false), ms)
  }

  /** Dive into layer j (and select one of its widgets). */
  const dive = (j: number, selectId?: string) => {
    const c = C.current
    if (c.state !== 'open' && c.state !== 'opening') return
    j = Math.max(0, Math.min(n - 1, j))
    const target = layers[j].id
    const root = rootRef.current!
    const cam = target === curId ? ws.camera : landingCamera(ws, target, root.clientWidth, root.clientHeight)
    c.state = 'diving'
    root.classList.remove('lo--open')
    for (const t of c.timers) window.clearTimeout(t)
    c.timers = []
    cancelAnimationFrame(c.magRaf)
    c.magRaf = 0
    if (c.g) c.g.boost = []
    hint(null)
    const finish = () => {
      const store = useStore.getState()
      // switching drops focus and selection either way (the focus-leak rule)
      store.setActiveLayer(target, target === curId ? undefined : cam)
      if (selectId) {
        store.setSelection([selectId])
        store.bringToFront([selectId])
      }
      close()
    }
    if (c.reduced) return finish()
    busy('lo--diving', T.dive)
    applyFlat(j, cam, 'fly', T.dive, EASE_DIVE)
    chrome(false, 140, T.dive - 140)
    later(finish, T.dive + 10)
  }

  const newLayer = () => {
    if (C.current.state !== 'open' || n >= MAX_LAYERS) return
    void useStore.getState().newLayerWithPicker()
  }

  const toggleGlass = () =>
    setFrost((f) => {
      localStorage.setItem(GLASS_KEY, f ? 'solid' : 'frosted')
      return !f
    })

  // hovering a rail row outlines its card on the sheet
  const hinted = useRef<string | null>(null)
  const hint = (id: string | null) => {
    if (hinted.current === id) return
    const stage = stageRef.current
    if (hinted.current) stage?.querySelector(`[data-pid="${hinted.current}"]`)?.classList.remove('pc--hint')
    hinted.current = id
    if (id) stage?.querySelector(`[data-pid="${id}"]`)?.classList.add('pc--hint')
  }

  // ---------- open ----------
  useLayoutEffect(() => {
    const c = C.current
    const root = rootRef.current!
    measure()
    if (c.reduced) {
      // reduced motion: an opacity crossfade to a static stack, no tilt or spread
      applyOpen('layout')
      chrome(true, 0)
      root.style.opacity = '0'
      void root.offsetWidth
      root.style.transition = `opacity ${T.fade}ms ease`
      root.style.opacity = '1'
      c.state = 'open'
      root.classList.add('lo--open')
      return
    }
    // frame 0: your sheet sits exactly over the live canvas, so the swap is invisible
    root.classList.add('lo--entering-start')
    applyFlat(curIdx, ws.camera, 'collapse', 0, 'linear')
    chrome(false, 0)
    for (let i = 0; i < n; i++) {
      // rail items wait at their final height, nudged left
      const r = rec(i)
      const t = railTarget(i)
      trans(r.item, ['transform'], 0, 'ease')
      if (r.item) r.item.style.transform = `translate3d(-12px, ${t.y}px, 0)`
      trans(r.lead, ['transform'], 0, 'ease')
      if (r.lead) r.lead.style.transform = 'scaleX(0)'
    }
    void stageRef.current!.offsetWidth // commit the start values
    root.classList.remove('lo--entering-start')
    const total = T.exDelay + T.expand + T.exStagger * (n - 1)
    busy('lo--entering', total)
    applySlab(curIdx)
    chrome(true, 220)
    later(() => C.current.state === 'opening' && applyExpand(curIdx), T.exDelay)
    later(() => {
      if (C.current.state !== 'opening') return
      C.current.state = 'open'
      root.classList.add('lo--open')
    }, total)
    return () => {
      for (const t of C.current.timers) window.clearTimeout(t)
      window.clearTimeout(C.current.busyTimer)
      cancelAnimationFrame(C.current.magRaf)
    }
    // mount only: the open sequence runs once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // a layer was added while open (N): it drops in from above, focused
  useLayoutEffect(() => {
    const c = C.current
    const prev = c.n
    c.n = n
    if (n <= prev || c.state !== 'open' || !c.g) return
    c.g.focus = n - 1
    measure()
    const g = c.g
    const r = rec(n - 1)
    for (const node of [r.el, r.sheet, r.world, r.item, r.lead, r.dim]) trans(node, ['transform'], 0, 'ease')
    if (r.el) r.el.style.transform = `translate3d(0, 0, ${ovZ(g, n - 1) + 420}px)`
    if (r.sheet) r.sheet.style.opacity = '0'
    if (r.world) r.world.style.transform = camT(c.fits[n - 1])
    if (r.item) {
      r.item.style.transform = `translate3d(-12px, ${railTarget(n - 1).y}px, 0)`
      r.item.style.opacity = '0'
    }
    void r.el?.offsetWidth
    busy('lo--adding', T.enter)
    applyOpen('grow')
    setFocusState(n - 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n])

  // ---------- input: keys, wheel, pointer, resize ----------
  const live = useRef({ dive, setFocus, newLayer, toggleGlass, focus, curIdx, n, setRenaming, layers })
  live.current = { dive, setFocus, newLayer, toggleGlass, focus, curIdx, n, setRenaming, layers }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.isContentEditable) return
      const L = live.current
      const c = C.current
      const k = e.key
      const done = () => {
        e.preventDefault()
        e.stopPropagation()
      }
      if (e.ctrlKey && e.metaKey && e.code === 'ArrowDown') return done(), L.dive(c.g?.focus ?? L.focus)
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (k === 'Escape' || k === 'l' || k === 'L') return done(), L.dive(L.curIdx)
      if (/^[1-9]$/.test(k)) {
        done()
        if (+k <= L.n) L.dive(+k - 1)
        return
      }
      if (k === 'Enter' || k === ' ') return done(), L.dive(c.g?.focus ?? L.focus)
      if (k === 'ArrowUp' || k === 'k' || k === 'K') return done(), L.setFocus((c.g?.focus ?? 0) + 1)
      if (k === 'ArrowDown' || k === 'j' || k === 'J') return done(), L.setFocus((c.g?.focus ?? 0) - 1)
      if (k === 'n' || k === 'N') return done(), L.newLayer()
      if (k === 'g' || k === 'G') return done(), L.toggleGlass()
      if ((k === 'r' || k === 'R') && c.state === 'open') return done(), L.setRenaming(L.layers[c.g?.focus ?? 0]?.id ?? null)
      // every other bare key stops here: nothing reaches the canvas underneath
      done()
    }
    const root = rootRef.current!
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const c = C.current
      if (c.state !== 'open') return
      const w = c.wheel
      if (e.ctrlKey || e.metaKey) {
        // pinch in dives into the focused layer
        if (e.deltaY < 0) {
          w.pinch -= e.deltaY
          if (w.pinch > 60) {
            w.pinch = 0
            live.current.dive(c.g!.focus)
          }
        }
        return
      }
      // one step per 48px, then a cooldown so trackpad inertia can't race
      const now = performance.now()
      if (now - w.prev > 250) w.acc = 0
      w.prev = now
      if (now - w.step < 140) return
      w.acc += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY
      if (Math.abs(w.acc) >= 48) {
        live.current.setFocus(c.g!.focus + (w.acc < 0 ? 1 : -1)) // scroll up = up the stack
        w.acc = 0
        w.step = now
      }
    }
    const onMove = (e: PointerEvent) => {
      const c = C.current
      c.lastMove = performance.now()
      if (!c.reduced) queueMag(e.clientY - c.top)
    }
    const onLeave = () => queueMag(null)
    const onResize = () => {
      if (C.current.state !== 'open') return
      measure()
      applyOpen('layout')
    }
    window.addEventListener('keydown', onKey, true)
    root.addEventListener('wheel', onWheel, { passive: false })
    root.addEventListener('pointermove', onMove, { passive: true })
    root.addEventListener('pointerleave', onLeave)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      root.removeEventListener('wheel', onWheel)
      root.removeEventListener('pointermove', onMove)
      root.removeEventListener('pointerleave', onLeave)
      window.removeEventListener('resize', onResize)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // hover moves the focus only after a real pointer move: a sheet sliding
  // under a still cursor (after ↑/↓) must not steal the keyboard's focus
  const hoverFocus = (i: number) => {
    if (performance.now() - C.current.lastMove < 60) setFocus(i)
  }
  const onSheetClick = (i: number, e: React.MouseEvent) => {
    e.stopPropagation()
    // inside a preserve-3d tree elementFromPoint can report the sheet's glass
    // while elementsFromPoint has the card first, so resolve from the full list
    const card = document
      .elementsFromPoint(e.clientX, e.clientY)
      .find((n) => n instanceof HTMLElement && n.classList.contains('pc') && n.dataset.pid) as
      | HTMLElement
      | undefined
    dive(i, card?.dataset.pid)
  }

  // ---------- render ----------
  const stats = layers.map((l) => layerStatus(ws, l.id, statusOf))
  const total = stats.reduce(
    (a, s) => ({ w: a.w + s.count, r: a.r + s.working, q: a.q + s.waiting }),
    { w: 0, r: 0, q: 0 },
  )

  return (
    <div
      className="lo"
      ref={rootRef}
      onClick={(e) => {
        // the backdrop: back to the layer you were on
        if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('lo-view'))
          dive(curIdx)
      }}
    >
      <div className="lo-bg" ref={bgRef} />
      <div className={`lo-view${frost ? ' lo--frost' : ''}`} onClick={() => dive(curIdx)}>
        <div className="lo-stage" ref={stageRef}>
          {layers.map((l, i) => (
            <div
              key={l.id}
              ref={(node) => void (rec(i).el = node)}
              className={`lo-layer${i === focus ? ' is-focus' : ''}${i === curIdx ? ' is-current' : ''}${
                stats[i].waiting ? ' has-waiting' : ''
              }`}
            >
              <div
                className="lo-sheet"
                ref={(node) => void (rec(i).sheet = node)}
                onPointerEnter={() => hoverFocus(i)}
                onClick={(e) => onSheetClick(i, e)}
              >
                <div className="lo-glass" ref={(node) => void (rec(i).glass = node)} />
                <div className="lo-world" ref={(node) => void (rec(i).world = node)}>
                  <SheetContent els={byLayer.get(l.id) ?? []} />
                </div>
                <div className="lo-dim" ref={(node) => void (rec(i).dim = node)} />
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="lo-rail">
        {layers.map((l, i) => {
          const st = stats[i]
          const here = i === curIdx
          const isFocus = i === focus
          const dir = l.dir
          const els = (byLayer.get(l.id) ?? []).filter((e): e is WidgetElement => e.type === 'widget')
          return (
            <div
              key={l.id}
              ref={(node) => void (rec(i).item = node)}
              className={`lr${isFocus ? ' is-focus' : ''}${st.waiting ? ' has-waiting' : ''}`}
            >
              <div
                className="lr__box"
                onPointerEnter={() => hoverFocus(i)}
                onPointerLeave={() => hint(null)}
                onClick={(e) => {
                  e.stopPropagation()
                  if (renaming === l.id || C.current.state !== 'open') return
                  const row = (e.target as HTMLElement).closest<HTMLElement>('.lr__row')
                  dive(i, row?.dataset.id)
                }}
              >
                <div className="lr__num">{layerNumber(i)}</div>
                <div className="lr__main">
                  <div className="lr__name">
                    {renaming === l.id ? (
                      <input
                        className="lr__input"
                        defaultValue={l.name}
                        autoFocus
                        onClick={(e) => e.stopPropagation()}
                        onBlur={(e) => {
                          useStore.getState().renameLayer(l.id, e.target.value)
                          setRenaming(null)
                        }}
                        onKeyDown={(e) => {
                          e.stopPropagation()
                          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                          if (e.key === 'Escape') setRenaming(null)
                        }}
                      />
                    ) : (
                      <span
                        className="lr__nm"
                        onDoubleClick={(e) => {
                          e.stopPropagation()
                          setRenaming(l.id)
                        }}
                      >
                        {l.name}
                      </span>
                    )}
                    {here && <span className="lr__here">here</span>}
                  </div>
                  <div className="lr__meta">
                    {dir && <span className="lr__dir">{"\u200e" + shortPath(dir)}</span>}
                    <span>{st.count ? `${st.count} widget${st.count > 1 ? 's' : ''}` : 'empty'}</span>
                    {st.working > 0 && <span className="m m--working">{st.working}</span>}
                    {st.waiting > 0 && <span className="m m--waiting">{st.waiting} needs you</span>}
                    {st.done > 0 && <span className="m m--done">{st.done}</span>}
                  </div>
                  {isFocus && els.length > 0 && (
                    <div className="lr__list" onPointerLeave={() => hint(null)}>
                      {els.slice(0, 14).map((e) => (
                        <RailRow
                          key={e.id}
                          el={e}
                          home={layerDir(ws, l.id)}
                          onHover={() => hint(e.id)}
                        />
                      ))}
                      {els.length > 14 && <div className="lr__more">+{els.length - 14} more</div>}
                    </div>
                  )}
                </div>
              </div>
              <div className="lr__lead" ref={(node) => void (rec(i).lead = node)} />
            </div>
          )
        })}
      </div>

      <div className="lo-head" ref={headRef}>
        <span className="lo-head__t">
          <IconLayers />
          Layers
        </span>
        <span className="lo-head__s">
          <b>{ws.name}</b> · {n} layer{n > 1 ? 's' : ''} · {total.w} widgets · <b>{total.r}</b> running
          {total.q > 0 && (
            <>
              {' · '}
              <b className="lo-head__q">
                {total.q} need{total.q === 1 ? 's' : ''} you
              </b>
            </>
          )}
        </span>
        <span className="lo-head__sp" />
        {n < MAX_LAYERS && (
          <button
            className="lo-btn"
            onClick={(e) => {
              e.stopPropagation()
              newLayer()
            }}
          >
            + new layer <span className="kbd">N</span>
          </button>
        )}
        <button
          className="lo-btn"
          onClick={(e) => {
            e.stopPropagation()
            toggleGlass()
          }}
        >
          glass: {frost ? 'frosted' : 'solid'} <span className="kbd">G</span>
        </button>
      </div>
      <div className="lo-foot" ref={footRef}>
        <div className="lo-keys">
          <span>
            <span className="kbd">↑</span>
            <span className="kbd">↓</span> or scroll · move
          </span>
          <span>
            <span className="kbd">⏎</span> or click · dive in
          </span>
          <span>
            <span className="kbd">1</span>–<span className="kbd">9</span> · jump
          </span>
          <span>
            <span className="kbd">R</span> · rename
          </span>
          <span>
            <span className="kbd">esc</span> · back
          </span>
        </div>
      </div>
    </div>
  )
}

/** One sheet's proxies. Memoised on the layer's element list, so a focus change
 *  (which re-renders the overview) never touches them. */
const SheetContent = memo(function SheetContent({ els }: { els: CanvasElement[] }) {
  let widgets = 0
  return (
    <>
      {els.map((e) => {
        const capped = e.type === 'widget' && ++widgets > PROXY_CAP
        return <LayerProxy key={e.id} el={e} rect={capped} />
      })}
    </>
  )
})

function RailRow({ el, home, onHover }: { el: WidgetElement; home?: string; onHover: () => void }) {
  const isTerm = el.kind === 'terminal' || el.kind === 'agent'
  const s = useDisplayStatus(el.id) ?? 'off'
  // a widget moved here from another project keeps its folder: say so
  const guest = home && el.cwd && !pathWithin(home, el.cwd) ? baseName(el.cwd) : null
  return (
    <div className="lr__row" data-id={el.id} onPointerEnter={onHover}>
      {isTerm ? <span className={`pc__led pc__led--${s}`} /> : <span className="lr__ic" />}
      <span className="lr__t">{el.title}</span>
      {guest && <span className="lr__guest">↗ {guest}</span>}
      <span className={`lr__s lr__s--${isTerm ? s : ''}`}>{isTerm ? (WORD[s] ?? s) : el.kind}</span>
    </div>
  )
}
