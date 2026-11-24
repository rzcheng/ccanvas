import { describe, expect, it } from 'vitest'
import { buildScript, parseOutput, pickSample, positionNow, type Track } from './nowplaying'

const US = '\u001f'
const RS = '\u001e'
const rec = (...f: string[]) => f.join(US)

describe('parseOutput', () => {
  it('reads a Spotify track (duration in ms, artwork URL)', () => {
    const out = rec('spotify', 'paused', 'Sentimental', 'B.U.G Antman', "Y'all Ugly", '151741', '0', 'spotify:track:5k8p', 'https://i.scdn.co/image/x') + '\n'
    expect(parseOutput(out)).toEqual([
      {
        source: 'spotify',
        state: 'paused',
        title: 'Sentimental',
        artist: 'B.U.G Antman',
        album: "Y'all Ugly",
        durationMs: 151741,
        positionMs: 0,
        id: 'spotify:track:5k8p',
        art: 'https://i.scdn.co/image/x',
      },
    ])
  })

  it('reads both apps, stopped and denied states, and locale numbers', () => {
    const out = [
      rec('spotify', 'denied'),
      rec('music', 'fast forwarding', 'Song', 'missing value', '', '245300', '1,5E+4', 'ABC', '='),
    ].join(RS)
    const [sp, mu] = parseOutput(out)
    expect(sp).toEqual({ source: 'spotify', state: 'denied' })
    expect(mu).toMatchObject({ state: 'playing', artist: '', durationMs: 245300, positionMs: 15000, art: '=' })
    expect(parseOutput(rec('music', 'stopped'))).toEqual([{ source: 'music', state: 'stopped' }])
  })

  it('is empty when nothing runs, and skips junk', () => {
    expect(parseOutput('')).toEqual([])
    expect(parseOutput('\n')).toEqual([])
    expect(parseOutput(rec('winamp', 'playing', 'x'))).toEqual([])
  })
})

describe('pickSample', () => {
  const s = (source: 'spotify' | 'music', state: 'playing' | 'paused') =>
    parseOutput(rec(source, state, 't', 'a', 'al', '1', '0', 'id', ''))[0]

  it('prefers a playing app, then Spotify', () => {
    expect(pickSample([s('spotify', 'paused'), s('music', 'playing')])?.source).toBe('music')
    expect(pickSample([s('music', 'playing'), s('spotify', 'playing')])?.source).toBe('spotify')
    expect(pickSample([s('music', 'paused'), s('spotify', 'paused')])?.source).toBe('spotify')
  })

  it('reports a refusal only when nothing else is there', () => {
    const denied = parseOutput(rec('spotify', 'denied'))
    expect(pickSample(denied)?.state).toBe('denied')
    expect(pickSample([...denied, s('music', 'paused')])?.source).toBe('music')
    expect(pickSample(parseOutput(rec('music', 'stopped')))).toBeNull()
    expect(pickSample([])).toBeNull()
  })
})

describe('buildScript', () => {
  it('checks each app is running before telling it anything', () => {
    for (const src of [['spotify'], ['music'], ['spotify', 'music']] as const) {
      const sc = buildScript([...src])
      for (const app of ['Spotify', 'Music']) {
        const tell = sc.indexOf(`tell application "${app}"`)
        if (tell < 0) continue
        expect(sc.indexOf(`if application "${app}" is running then`)).toBeGreaterThanOrEqual(0)
        expect(sc.indexOf(`if application "${app}" is running then`)).toBeLessThan(tell)
      }
    }
    expect(buildScript(['music'])).not.toContain('Spotify')
  })
})

describe('positionNow', () => {
  const t: Track = {
    source: 'spotify',
    playing: true,
    title: '',
    artist: '',
    album: '',
    durationMs: 10_000,
    positionMs: 4000,
    at: 1000,
    id: '',
    artwork: null,
  }
  it('moves on while playing, stops at the end, holds while paused', () => {
    expect(positionNow(t, 2500)).toBe(5500)
    expect(positionNow(t, 99_000)).toBe(10_000)
    expect(positionNow({ ...t, playing: false }, 2500)).toBe(4000)
  })
})
