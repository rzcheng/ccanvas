// Frame sampler for the layers overview (concept §7, "measure first").
// Off by default: `P` in the overview turns it on (persisted), and then each
// open and dive records where the time went and the frame deltas while it
// animates. Read it in the overview's corner readout. When off, the only cost
// is one performance.now() at the keypress.

const KEY = 'ccanvas:layers:perf'

export type PerfRun = {
  kind: 'open' | 'dive'
  /** keypress → first render of the overview */
  render?: number
  /** keypress → layout effect (React commit done) */
  commit?: number
  /** time spent in the open's layout effect (measure, frame 0, slab) */
  effect?: number
  /** keypress → first animation frame after the commit */
  frame0?: number
  /** frame deltas during the transition (the first one, frame0's, excluded) */
  n: number
  p50: number
  p95: number
  max: number
  /** frames over 1.5× the refresh interval */
  drops: number
  /** the first frame after frame 0: where the raster of new layers lands */
  first: number
}

const listeners = new Set<() => void>()
export const layersPerf = {
  on: typeof localStorage !== 'undefined' && localStorage.getItem(KEY) === '1',
  keyAt: 0,
  runs: [] as PerfRun[],
}

export function setPerfOn(on: boolean) {
  layersPerf.on = on
  try {
    localStorage.setItem(KEY, on ? '1' : '0')
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l())
}

export function subscribePerf(l: () => void) {
  listeners.add(l)
  return () => void listeners.delete(l)
}

/** Stamp the keypress (or click) that asked for the overview. */
export function markOpenRequest() {
  layersPerf.keyAt = performance.now()
}

/**
 * Sample rAF deltas for `ms` after now, then record a run. `stamps` are
 * absolute performance.now() times (render, commit, effect end) to report
 * relative to the keypress.
 */
export function sampleTransition(
  kind: 'open' | 'dive',
  ms: number,
  stamps: { render?: number; commit?: number; effectEnd?: number } = {},
) {
  if (!layersPerf.on) return
  const start = kind === 'open' && layersPerf.keyAt ? layersPerf.keyAt : performance.now()
  const deltas: number[] = []
  let prev = 0
  let frame0 = 0
  const until = performance.now() + ms + 80
  const tick = (t: number) => {
    if (!frame0) frame0 = t
    else deltas.push(t - prev)
    prev = t
    if (t < until) requestAnimationFrame(tick)
    else finish()
  }
  const finish = () => {
    const s = [...deltas].sort((a, b) => a - b)
    const q = (p: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0)
    const refresh = q(0.5) < 11 ? 1000 / 120 : 1000 / 60
    const rel = (v?: number) => (v ? v - start : undefined)
    layersPerf.runs = [
      {
        kind,
        render: kind === 'open' ? rel(stamps.render) : undefined,
        commit: kind === 'open' ? rel(stamps.commit) : undefined,
        effect: stamps.effectEnd && stamps.commit ? stamps.effectEnd - stamps.commit : undefined,
        frame0: frame0 - start,
        n: deltas.length,
        p50: q(0.5),
        p95: q(0.95),
        max: s[s.length - 1] ?? 0,
        drops: deltas.filter((d) => d > refresh * 1.5).length,
        first: deltas[0] ?? 0,
      },
      ...layersPerf.runs,
    ].slice(0, 12)
    listeners.forEach((l) => l())
  }
  requestAnimationFrame(tick)
}
