/**
 * Visitor tracking wiring for this site.
 *
 * Page views, dwell time and engagement (active time, attention time, scroll
 * depth, whether the visitor moved, scrolled, tapped or typed) come from the
 * shared trackhub tracker at track.cyberjosef.dev/t.js, which every site now
 * loads. This file used to carry its own copy of that logic; four copies
 * drifted apart and one of them silently dropped every visitor's client
 * context, which is why there is now exactly one.
 *
 * What stays here is site-specific: `cta_click` for elements marked
 * `data-track-cta`, and `form_field` the first time each form field is filled
 * in (fired on blur, so abandoned forms are recorded too).
 *
 * Beacons go to POST /track on this app, which forwards them server-side to
 * the central trackhub API. Nothing here blocks rendering and tracking must
 * never break the page.
 */

import { router } from '@inertiajs/react'
import FingerprintJS from '@fingerprintjs/fingerprintjs'

const TRACKER_SRC = import.meta.env.VITE_TRACKHUB_SCRIPT ?? 'https://track.cyberjosef.dev/t.js'

/** localStorage key for the visitor token. Unchanged, so returning visitors
 *  stay the same visitor rather than all looking new on deploy day. */
const TOKEN_KEY = 'cj_vid'

type EventName = 'cta_click' | 'form_field'

type EventOptions = {
  label?: string
  path?: string
  meta?: Record<string, unknown>
}

type TrackhubAPI = {
  __loaded?: boolean
  q?: unknown[][]
  pageview?: (path?: string) => void
  event?: (name: string, options?: EventOptions) => void
  fingerprint?: (value: string) => void
}

declare global {
  interface Window {
    trackhub?: TrackhubAPI
  }
}

/**
 * Calls the shared tracker, queueing when the script has not landed yet.
 * Every path swallows its errors: tracking must never break the page.
 */
function call(method: string, ...args: unknown[]): void {
  if (typeof window === 'undefined') return

  try {
    if (!window.trackhub) window.trackhub = { q: [] }
    const api = window.trackhub

    if (api.__loaded) {
      const fn = (api as Record<string, unknown>)[method]
      if (typeof fn === 'function') (fn as (...a: unknown[]) => void)(...args)
      return
    }

    if (!api.q) api.q = []
    api.q.push([method, ...args])
  } catch {
    // Tracking must never break the page.
  }
}

export function trackEvent(name: EventName, options: EventOptions = {}): void {
  call('event', name, options)
}

function loadTracker(): void {
  if (document.querySelector('script[data-trackhub]')) return

  const script = document.createElement('script')
  script.src = TRACKER_SRC
  script.async = true
  script.dataset.trackhub = ''
  script.dataset.endpoint = '/track'
  script.dataset.key = TOKEN_KEY
  document.head.appendChild(script)
}

async function reportFingerprint(): Promise<void> {
  try {
    const fp = await FingerprintJS.load()
    const result = await fp.get()
    if (result.visitorId) call('fingerprint', result.visitorId)
  } catch {
    // A missing fingerprint costs device grouping, nothing more.
  }
}

// ---------------------------------------------------------------------------
// Ambient wiring
// ---------------------------------------------------------------------------

let started = false

export function startTracking(): void {
  if (typeof window === 'undefined' || started) return
  started = true

  loadTracker()
  void reportFingerprint()

  // The shared tracker hooks the history API, which Inertia navigations go
  // through, so page views are already covered. This is the explicit belt to
  // that braces; the tracker de-duplicates by path, so it costs nothing.
  router.on('navigate', () => call('pageview'))

  // CTA clicks: anything marked data-track-cta.
  document.addEventListener(
    'click',
    (event) => {
      const target = event.target as HTMLElement | null
      const el = target?.closest('a, button') as HTMLElement | null
      if (!el) return

      const cta = el.closest('[data-track-cta]') as HTMLElement | null
      if (cta) {
        const named = cta.dataset.trackCta?.trim()
        const label = named && named !== 'true' ? named : elementLabel(el)
        trackEvent('cta_click', { label })
      }
    },
    true
  )

  // Form fills — capture abandoned forms: a field counts as filled the moment
  // it has a value, reported on blur or flushed when the visitor leaves.
  const reported = new Set<string>()
  const pending = new Map<string, FormField>()

  const report = (el: FormField) => {
    const value = el.value?.trim()
    const field = el.getAttribute('name') || el.id
    if (!value || !field) return

    const key = `${window.location.pathname}:${field}`
    pending.delete(key)
    if (reported.has(key)) return
    reported.add(key)

    trackEvent('form_field', {
      label: humanize(field),
      meta: { field, value: previewValue(el, value) },
    })
  }

  const trackable = (target: EventTarget | null): FormField | null => {
    const el = target as FormField | null
    if (!el || !isFormField(el) || el.closest('[data-track-ignore]')) return null
    return el
  }

  document.addEventListener(
    'input',
    (event) => {
      const el = trackable(event.target)
      if (!el) return
      const field = el.getAttribute('name') || el.id
      if (field) pending.set(`${window.location.pathname}:${field}`, el)
    },
    true
  )
  document.addEventListener(
    'focusout',
    (event) => {
      const el = trackable(event.target)
      if (el) report(el)
    },
    true
  )

  const flushPending = () => {
    pending.forEach((el) => report(el))
    pending.clear()
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPending()
  })
  window.addEventListener('pagehide', flushPending)
}

type FormField = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement

function isFormField(el: Element): el is FormField {
  const tag = el.tagName
  if (tag === 'SELECT' || tag === 'TEXTAREA') return true
  if (tag !== 'INPUT') return false

  const type = (el as HTMLInputElement).type
  return !['submit', 'button', 'reset', 'hidden', 'file'].includes(type)
}

/** Passwords are never recorded; secret-ish fields reduce to a length. */
function previewValue(el: HTMLElement, value: string): string {
  const type = (el as HTMLInputElement).type
  const name = (el.getAttribute('name') || el.id || '').toLowerCase()

  if (type === 'password' || /card|cvc|cvv|secret|token/.test(name)) {
    return `${value.length} chars`
  }
  return value.slice(0, 120)
}

function elementLabel(el: HTMLElement): string {
  return (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80)
}

function humanize(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim()
}
