// Inline flattening and word wrap (M1, M3) for layout.ts: inlines → styled
// pieces → rows of spans no wider than the width.

import type { Inline } from './ast'
import { plainText } from './inlines'
import type { Span, SpanStyle } from './rows'
import { colsOf, expandTabs, widthOf } from '../../shared/hscroll'

/** A run of inline text in one style; `nb` keeps its spaces unbreakable (code spans, kbd). */
type Piece = { text: string; style?: SpanStyle; nb?: boolean }
/** `null` is a hard break (B4, `<br>`). */
export type Pieces = (Piece | null)[]

/** Total columns of spans. */
export function spansWidth(spans: readonly Span[]): number {
  let n = 0
  for (const s of spans) n += colsOf(s.text)
  return n
}

/**
 * Splits `s` after at most `w` columns; at least one code point is taken so a
 * caller always advances (a code point wider than `w` becomes `?`).
 */
export function cut(s: string, w: number): { head: string; headW: number; rest: string } {
  let i = 0
  let used = 0
  while (i < s.length) {
    const cp = s.codePointAt(i)!
    const len = cp > 0xffff ? 2 : 1
    const cw = widthOf(cp)
    if (used + cw > w) {
      if (i === 0) return { head: '?', headW: 1, rest: s.slice(len) }
      break
    }
    used += cw
    i += len
  }
  return { head: s.slice(0, i), headW: used, rest: s.slice(i) }
}

const merge = (base: SpanStyle | undefined, add: SpanStyle): SpanStyle => ({ ...base, ...add })

/** Inline nodes → pieces, each styled over `base`. */
export function flatten(nodes: readonly Inline[], base: SpanStyle | undefined, out: Pieces = []): Pieces {
  for (const n of nodes) {
    switch (n.type) {
      case 'text':
        // a tab is white space, as a newline is (colsOf counts it as 0)
        if (n.text) out.push({ text: n.text.replace(/[\n\t]/g, ' '), style: base })
        break
      case 'softBreak':
        out.push({ text: ' ', style: base })
        break
      case 'hardBreak':
        out.push(null)
        break
      case 'emph':
        flatten(n.children, merge(base, { italic: true }), out)
        break
      case 'strong':
        flatten(n.children, merge(base, { bold: true }), out)
        break
      case 'strike':
        flatten(n.children, merge(base, { strike: true, color: 'muted' }), out)
        break
      case 'underline':
        flatten(n.children, merge(base, { underline: true }), out)
        break
      case 'mark':
        flatten(n.children, merge(base, { background: 'warning' }), out)
        break
      case 'kbd':
        out.push({ text: ` ${plainText(n.children).replace(/\s+/g, ' ').trim()} `, style: merge(base, { inverse: true }), nb: true })
        break
      case 'code':
        // tabs expanded as a code row's (layout.ts), so the width is exact
        if (n.text) out.push({ text: expandTabs(n.text), style: merge(base, { color: 'accent', background: 'surface' }), nb: true })
        break
      case 'link':
        flatten(n.children, merge(base, { underline: true, color: 'accent', href: n.href }), out)
        break
      case 'image': {
        const muted = merge(base, { color: 'muted' })
        out.push({ text: '🖼', style: muted }, { text: ' ', style: muted })
        if (n.alt) out.push({ text: n.alt.replace(/\t/g, ' '), style: muted })
        if (n.title) out.push({ text: ' ', style: muted }, { text: n.title.replace(/\t/g, ' '), style: merge(base, { color: 'muted', dim: true }) })
        break
      }
      case 'footnoteRef':
        out.push({ text: `[${n.n}]`, style: merge(base, { color: 'accent' }) })
        break
      default: // inline html: nothing
        break
    }
  }
  return out
}

/** Joins neighbours of one style (same object) into one span. */
function compact(spans: Span[]): Span[] {
  const out: Span[] = []
  for (const s of spans) {
    if (!s.text) continue
    const last = out[out.length - 1]
    if (last && last.style === s.style) out[out.length - 1] = { text: last.text + s.text, style: last.style }
    else out.push(s)
  }
  return out
}

const SPLIT = /( +)|([^ ]+)/g

/**
 * Greedy word wrap of pieces into rows of at most `width` columns (width ≥ 1).
 * Space runs collapse to one and are dropped at a wrap; a word wider than the width starts a new row
 * and breaks by column; each hard break ends a row (empty rows kept).
 */
export function wrap(pieces: Pieces, width: number): Span[][] {
  const W = Math.max(1, width)
  const rows: Span[][] = []
  let line: Span[] = []
  let lw = 0
  let pend: Span[] = []
  let pendW = 0
  let word: Span[] = []
  let wordW = 0
  let started = false // the row has a word on it

  const flush = (): void => {
    rows.push(compact(line))
    line = []
    lw = 0
    pend = []
    pendW = 0
    started = false
  }

  const placeWord = (): void => {
    if (!word.length) return
    const spans = word
    const w = wordW
    word = []
    wordW = 0
    if (started && lw + pendW + w <= W) {
      for (const s of pend) line.push(s)
      for (const s of spans) line.push(s)
      lw += pendW + w
      pend = []
      pendW = 0
      return
    }
    if (started) flush()
    pend = []
    pendW = 0
    if (w <= W) {
      line = spans.slice()
      lw = w
      started = true
      return
    }
    // a word wider than the row: break by column
    let room = W
    for (const s of spans) {
      let text = s.text
      while (text) {
        // a wide char that no longer fits the row moves to the next one
        if (room === 0 || (room < W && widthOf(text.codePointAt(0)!) > room)) {
          flush()
          room = W
        }
        const c = cut(text, room)
        line.push({ text: c.head, style: s.style })
        lw += c.headW
        room -= c.headW
        text = c.rest
        started = true
      }
    }
  }

  for (const p of pieces) {
    if (p === null) {
      placeWord()
      flush()
      continue
    }
    if (p.nb) {
      word.push({ text: p.text, style: p.style })
      wordW += colsOf(p.text)
      continue
    }
    SPLIT.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = SPLIT.exec(p.text))) {
      if (m[1]) {
        placeWord()
        if (started && !pend.length) {
          // runs collapse to one space, as HTML draws them
          pend.push({ text: ' ', style: p.style })
          pendW = 1
        }
      } else {
        word.push({ text: m[2]!, style: p.style })
        wordW += colsOf(m[2]!)
      }
    }
  }
  placeWord()
  if (started || line.length) flush()
  return rows
}

/** Widest row of the pieces laid out without a width limit. */
export function natural(pieces: Pieces): number {
  let most = 0
  for (const r of wrap(pieces, Number.MAX_SAFE_INTEGER)) most = Math.max(most, spansWidth(r))
  return most
}
