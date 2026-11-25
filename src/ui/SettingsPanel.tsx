import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store/workspace'
import {
  useSettings,
  PALETTES,
  AGENT_CLIS,
  TEXT_SIZES,
  comboFrom,
  formatSeq,
  isModifierKey,
  keyRecorder,
  type KeySeq,
} from '../lib/settings'
import { IconClose, IconPlus, IconSearch } from './icons'
import { isTauri } from '../lib/backend'
import { invoke } from '@tauri-apps/api/core'
import '../styles/agent-tools.css'

// How long to wait after the first press for a second one (a chord like ⌃X ⌃F).
const CHORD_WAIT = 900

// Preferences: which shortcuts open the tab finder, the colour palette and text size.
export function SettingsPanel() {
  const setOpenPanel = useStore((s) => s.setOpenPanel)
  const s = useSettings()

  return (
    <div className="panel">
      <div className="panel__head">
        <span className="panel__title">Settings</span>
        <span className="panel__spacer" />
        <button className="panel__x" title="Close" onClick={() => setOpenPanel(null)}>
          <IconClose size={14} />
        </button>
      </div>

      <div className="panel__body set">
        <div className="set__section">Agents</div>
        {AGENT_CLIS.map((c) => (
          <label key={c.id} className="set__row">
            <input
              type="radio"
              name="agent-cli"
              checked={s.agentCli === c.id}
              onChange={() => s.update({ agentCli: c.id })}
            />
            <span className="set__main">
              <span className="set__label">
                {c.name} <kbd className="set__kbd">{c.cmd}</kbd>
              </span>
            </span>
          </label>
        ))}
        <div className="set__hint">
          New agents open with this CLI; existing agents keep the one they started with. Needs{' '}
          <code>{s.agentCli === 'codex' ? 'codex' : 'claude'}</code> on your PATH.
        </div>

        <div className="set__section">Switch tabs</div>
        <Toggle
          on={s.emacsKeys}
          onChange={(v) => s.update({ emacsKeys: v })}
          title="Emacs"
          keys="⌃X ⌃F"
          hint="Opens the tab finder from anywhere, including inside a terminal."
        />
        <Toggle
          on={s.vimKeys}
          onChange={(v) => s.update({ vimKeys: v })}
          title="Vim"
          keys=": · gt · gT"
          hint=": opens the finder as :b, gt / gT go to the next / previous tab. Works on the canvas, not while typing in a terminal (⌘Esc leaves one)."
        />
        <CustomKeys />

        <div className="set__section">Colour palette</div>
        <div className="set__palettes">
          {PALETTES.map((p) => (
            <button
              key={p.id}
              className={`set__swatch${s.palette === p.id ? ' set__swatch--on' : ''}`}
              title={p.name}
              onClick={() => s.update({ palette: p.id })}
            >
              <span className="set__chip" style={{ background: p.bg, borderColor: p.panel }}>
                <span style={{ background: p.panel }} />
                <span style={{ background: p.ink }} />
                <span style={{ background: p.accent }} />
              </span>
              <span className="set__swatch-name">{p.name}</span>
            </button>
          ))}
        </div>
        <div className="set__hint">Terminals keep the colours from your iTerm2 profile.</div>

        <div className="set__section">Text size</div>
        <div className="set__sizes">
          {TEXT_SIZES.map((t) => (
            <button
              key={t.id}
              className={`set__size${s.textSize === t.id ? ' set__size--on' : ''}`}
              title={`${Math.round(t.scale * 100)}%`}
              onClick={() => s.update({ textSize: t.id })}
            >
              <span className="set__size-a" style={{ fontSize: 13 * t.scale }}>
                Aa
              </span>
              <span className="set__swatch-name">{t.name}</span>
            </button>
          ))}
        </div>
        <div className="set__hint">
          Scales text in widgets, terminals and panels; widgets keep their size.
        </div>

        <div className="set__section">Web sign-ins</div>
        <WebSignIns />
      </div>
    </div>
  )
}

function Toggle(props: {
  on: boolean
  onChange: (v: boolean) => void
  title: string
  keys: string
  hint: string
}) {
  return (
    <label className="set__row">
      <input type="checkbox" checked={props.on} onChange={(e) => props.onChange(e.target.checked)} />
      <span className="set__main">
        <span className="set__label">
          {props.title} <kbd className="set__kbd">{props.keys}</kbd>
        </span>
        <span className="set__hint">{props.hint}</span>
      </span>
    </label>
  )
}

// Record a shortcut: press one combo, or two in a row for a chord. Esc cancels.
function CustomKeys() {
  const keys = useSettings((s) => s.customFinderKeys)
  const update = useSettings((s) => s.update)
  const [recording, setRecording] = useState(false)
  const [draft, setDraft] = useState<KeySeq>([])
  const draftRef = useRef<KeySeq>([])

  useEffect(() => {
    if (!recording) return
    keyRecorder.active = true
    let timer: number | undefined
    const finish = () => {
      const seq = draftRef.current
      const cur = useSettings.getState().customFinderKeys
      if (seq.length && !cur.some((k) => formatSeq(k) === formatSeq(seq)))
        update({ customFinderKeys: [...cur, seq] })
      setRecording(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (isModifierKey(e)) return
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        draftRef.current = []
        setRecording(false)
        return
      }
      const seq = [...draftRef.current, comboFrom(e)]
      draftRef.current = seq
      setDraft(seq)
      window.clearTimeout(timer)
      if (seq.length >= 2) finish()
      else timer = window.setTimeout(finish, CHORD_WAIT)
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      keyRecorder.active = false
      window.clearTimeout(timer)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [recording, update])

  const start = () => {
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    draftRef.current = []
    setDraft([])
    setRecording(true)
  }

  return (
    <div className="set__row set__row--custom">
      <span className="set__main">
        <span className="set__label">Custom</span>
        {keys.map((k) => (
          <span key={formatSeq(k)} className="set__bind">
            <kbd className="set__kbd">{formatSeq(k)}</kbd>
            <button
              className="set__rm"
              title="Remove shortcut"
              onClick={() => update({ customFinderKeys: keys.filter((x) => x !== k) })}
            >
              <IconClose size={11} />
            </button>
          </span>
        ))}
        {recording ? (
          <span className="set__rec">
            {draft.length ? <kbd className="set__kbd">{formatSeq(draft)}</kbd> : 'Press a shortcut…'}
            <span className="set__hint">A second press makes a chord · Esc cancels</span>
          </span>
        ) : (
          <button className="set__add" onClick={start}>
            <IconPlus size={12} /> Add shortcut
          </button>
        )}
        <span className="set__hint">
          Opens the tab finder. Include ⌃, ⌥ or ⌘ for it to work inside terminals.
        </span>
      </span>
    </div>
  )
}

// ---- web sign-ins (src-tauri/src/chrome_import.rs) ----
// The web widget's browser keeps its own sign-ins. Here they can be brought
// over from a Chrome profile, site by site (nothing is chosen for you), or
// all signed out. Cookie values never come through here: only profile names,
// site domains and counts.

type ChromeProfile = { dir: string; name: string }
type CookieSite = { domain: string; cookies: number }
type ImportReport = { imported: number; skipped: number }

function WebSignIns() {
  const [open, setOpen] = useState(false)
  const [profiles, setProfiles] = useState<ChromeProfile[] | null>(null)
  const [profile, setProfile] = useState('')
  const [sites, setSites] = useState<CookieSite[] | null>(null)
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState<null | 'list' | 'import' | 'signout'>(null)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [armed, setArmed] = useState(false)

  if (!isTauri())
    return <div className="set__hint">Sign-ins are kept by the desktop app's browser.</div>

  const fail = (e: unknown) => setNote({ ok: false, text: typeof e === 'string' ? e : 'That didn’t work.' })

  const start = async () => {
    setOpen(true)
    setNote(null)
    setSites(null)
    setChosen(new Set())
    try {
      const ps = await invoke<ChromeProfile[]>('chrome_profiles')
      setProfiles(ps)
      if (ps.length === 1) void pick(ps[0].dir)
      else if (!ps.length) setNote({ ok: false, text: 'No Chrome profile with cookies was found.' })
    } catch (e) {
      fail(e)
    }
  }

  const pick = async (dir: string) => {
    setProfile(dir)
    setSites(null)
    setChosen(new Set())
    setNote(null)
    if (!dir) return
    setBusy('list')
    try {
      setSites(await invoke<CookieSite[]>('chrome_cookie_sites', { profile: dir }))
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }

  const run = async () => {
    if (!chosen.size) return
    setBusy('import')
    setNote(null)
    try {
      const r = await invoke<ImportReport>('chrome_import', { profile, sites: [...chosen] })
      setNote({
        ok: true,
        text: `Signed in to ${chosen.size} site${chosen.size === 1 ? '' : 's'} (${r.imported} cookie${r.imported === 1 ? '' : 's'}${
          r.skipped ? `; ${r.skipped} in a format that can’t be read were left out` : ''
        }). Reload a page that's open to see it.`,
      })
      setChosen(new Set())
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }

  const signOut = async () => {
    if (!armed) {
      setArmed(true)
      window.setTimeout(() => setArmed(false), 4000)
      return
    }
    setArmed(false)
    setBusy('signout')
    setNote(null)
    try {
      await invoke('web_sign_out_all')
      setNote({ ok: true, text: 'Signed out of every site in the web browser.' })
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }

  const q = filter.trim().toLowerCase()
  const shown = (sites ?? []).filter((x) => !q || x.domain.includes(q))
  const toggle = (d: string) =>
    setChosen((c) => {
      const n = new Set(c)
      if (n.has(d)) n.delete(d)
      else n.add(d)
      return n
    })

  return (
    <div className="set__web">
      <div className="set__hint">
        Web widgets share one browser that remembers your sign-ins, apart from the app. Sites that sign
        in with Google often refuse to inside an app; bringing the sign-in over from Chrome gets
        round that.
      </div>
      <div className="set__web-actions">
        {!open && (
          <button className="set__btn" onClick={() => void start()}>
            Import sign-ins from Chrome…
          </button>
        )}
        <button
          className={`set__btn${armed ? ' set__btn--danger' : ''}`}
          disabled={busy === 'signout'}
          onClick={() => void signOut()}
        >
          {armed ? 'Click again to sign out everywhere' : 'Sign out of all sites'}
        </button>
      </div>

      {open && (
        <div className="set__import">
          {profiles && profiles.length > 1 && (
            <select className="set__select" value={profile} onChange={(e) => void pick(e.target.value)}>
              <option value="">Choose a Chrome profile…</option>
              {profiles.map((p) => (
                <option key={p.dir} value={p.dir}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          {busy === 'list' && <div className="set__hint">Reading the profile's sites…</div>}
          {sites && (
            <>
              <label className="set__find">
                <IconSearch size={12} />
                <input
                  value={filter}
                  placeholder={`Find among ${sites.length} sites`}
                  spellCheck={false}
                  onChange={(e) => setFilter(e.target.value)}
                  onKeyDown={(e) => e.stopPropagation()}
                />
              </label>
              <div className="set__sites">
                {shown.map((x) => (
                  <label key={x.domain} className="set__site">
                    <input type="checkbox" checked={chosen.has(x.domain)} onChange={() => toggle(x.domain)} />
                    <span className="set__site-name">{x.domain}</span>
                    <span className="set__site-n">{x.cookies}</span>
                  </label>
                ))}
                {!shown.length && <div className="set__hint">No sites match.</div>}
              </div>
              <div className="set__web-actions">
                <button className="set__btn set__btn--go" disabled={!chosen.size || busy === 'import'} onClick={() => void run()}>
                  {busy === 'import'
                    ? 'Importing…'
                    : chosen.size
                      ? `Import ${chosen.size} site${chosen.size === 1 ? '' : 's'}`
                      : 'Choose the sites to import'}
                </button>
                <button className="set__btn" onClick={() => setOpen(false)}>
                  Cancel
                </button>
              </div>
              <div className="set__hint">
                macOS will ask to let ccanvas use “Chrome Safe Storage”: that is Chrome's key to its
                cookies. It is used for this import only, never kept, and the cookies go straight into the
                web browser's own store.
              </div>
            </>
          )}
        </div>
      )}
      {note && <div className={`set__note${note.ok ? '' : ' set__note--err'}`}>{note.text}</div>}
    </div>
  )
}
