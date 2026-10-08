// B2 layout: ParseResult → rows at one width (rows.ts), every row exactly one
// terminal row, so a viewer scrolls by rows. Inline wrapping lives in wrap.ts.

import type { AlertKind, Align, Block, Inline, List, ParseResult, Table } from './ast'
import type { Layout, MdRow, Role, Span, SpanStyle } from './rows'
import { colsOf, expandTabs } from '../../shared/hscroll'
import { cut, flatten, natural, type Pieces, spansWidth, wrap } from './wrap'

/** Narrowest layout width; smaller requests are laid out at this. */
export const MIN_WIDTH = 8
/** A container stops indenting (quote bars, list hangs) below this content width. */
const MIN_INNER = 4

const BULLETS = ['•', '◦', '▪']
const ALERTS: Record<AlertKind, { title: string; color: Role }> = {
  note: { title: 'ℹ Note', color: 'accent' },
  tip: { title: '💡 Tip', color: 'success' },
  important: { title: '❗ Important', color: 'accent' },
  warning: { title: '⚠ Warning', color: 'warning' },
  caution: { title: '⛔ Caution', color: 'danger' },
}

const S_BORDER: SpanStyle = { color: 'border' }
const S_MUTED: SpanStyle = { color: 'muted' }
const S_LABEL: SpanStyle = { color: 'muted', dim: true }
const S_ACCENT: SpanStyle = { color: 'accent' }
const S_BOLD: SpanStyle = { bold: true }
const S_CHECKED: SpanStyle = { color: 'success' }
const HEADING: Record<number, SpanStyle> = {
  1: { bold: true, color: 'accent' },
  2: { bold: true, color: 'accent' },
  3: { bold: true, color: 'accent' },
  4: { bold: true },
  5: { bold: true, color: 'muted' },
  6: { italic: true, color: 'muted' },
}

/** `code.n` numbers code blocks in document order (shared by every copy of a Ctx). */
type Ctx = { code: { n: number }; listDepth: number; muted: boolean }

/** Rows of one block or container, with heading anchors relative to its first row. */
class Out {
  rows: MdRow[] = []
  anchors: [string, number][] = []

  blank(): void {
    this.rows.push({ kind: 'text', spans: [] })
  }

  text(spans: Span[]): void {
    this.rows.push({ kind: 'text', spans })
  }

  /** Appends `o`, its first row prefixed by `first`, the rest by `rest` (empty rows by `blank`). */
  add(o: Out, first: Span[] = [], rest: Span[] = first, blank: Span[] = rest): void {
    const base = this.rows.length
    for (const [slug, i] of o.anchors) this.anchors.push([slug, i + base])
    const plain = !first.length && !rest.length
    for (let i = 0; i < o.rows.length; i++) {
      const r = o.rows[i]!
      if (plain) {
        this.rows.push(r)
        continue
      }
      const pre = i === 0 ? first : r.kind === 'text' && r.spans.length === 0 ? blank : rest
      if (r.kind === 'text') this.rows.push({ ...r, spans: pre.length ? [...pre, ...r.spans] : r.spans })
      else this.rows.push({ ...r, prefix: [...pre, ...r.prefix] })
    }
  }
}

const sp = (n: number): Span => ({ text: ' '.repeat(Math.max(0, n)) })

/** Text rows of inlines wrapped at `w` over a base style. */
function inlineRows(nodes: readonly Inline[], w: number, base?: SpanStyle): Span[][] {
  return wrap(flatten(nodes, base), w)
}

/** Base style for body text: muted inside a checked task. */
const bodyStyle = (ctx: Ctx): SpanStyle | undefined => (ctx.muted ? S_MUTED : undefined)

/** The one image of a paragraph that holds nothing else (whitespace aside). */
function soleImage(nodes: readonly Inline[]): Extract<Inline, { type: 'image' }> | null {
  let img: Extract<Inline, { type: 'image' }> | null = null
  for (const n of nodes) {
    if (n.type === 'softBreak' || n.type === 'html') continue
    if (n.type === 'text' && !n.text.trim()) continue
    if (n.type !== 'image' || img) return null
    img = n
  }
  return img
}

function layBlocks(blocks: readonly Block[], w: number, ctx: Ctx, tight = false): Out {
  const out = new Out()
  for (const b of blocks) {
    const o = layBlock(b, w, ctx)
    if (!o.rows.length) continue
    if (out.rows.length && !tight) out.blank()
    out.add(o)
  }
  return out
}

function paragraph(nodes: readonly Inline[], w: number, ctx: Ctx): Out {
  const out = new Out()
  const img = soleImage(nodes)
  if (img) {
    out.rows.push({ kind: 'image', prefix: [], src: img.src, alt: img.alt })
    return out
  }
  for (const r of inlineRows(nodes, w, bodyStyle(ctx))) out.text(r)
  return out
}

function layBlock(b: Block, w: number, ctx: Ctx): Out {
  switch (b.type) {
    case 'heading': {
      const out = new Out()
      out.anchors.push([b.slug, 0])
      const rows = inlineRows(b.inlines, w, HEADING[b.level])
      if (!rows.length) rows.push([])
      for (const r of rows) out.text(r)
      if (b.level <= 2) out.text([{ text: (b.level === 1 ? '═' : '─').repeat(w), style: S_BORDER }])
      return out
    }
    case 'paragraph':
      return paragraph(b.inlines, w, ctx)
    case 'html':
      return b.comment ? new Out() : paragraph(b.inlines, w, ctx)
    case 'thematicBreak': {
      const out = new Out()
      out.text([{ text: '─'.repeat(w), style: S_BORDER }])
      return out
    }
    case 'quote': {
      const alert = b.alert ? ALERTS[b.alert] : undefined
      const nest = w - 2 >= MIN_INNER
      const iw = nest ? w - 2 : w
      const inner = new Out()
      if (alert) for (const r of inlineRows([{ type: 'text', text: alert.title }], iw, { bold: true, color: alert.color })) inner.text(r)
      inner.add(layBlocks(b.children, iw, ctx))
      if (!inner.rows.length) inner.blank()
      const out = new Out()
      if (!nest) {
        out.add(inner)
        return out
      }
      const bar: SpanStyle = alert ? { color: alert.color } : S_MUTED
      const pre = [{ text: '▎ ', style: bar }]
      out.add(inner, pre, pre, [{ text: '▎', style: bar }])
      return out
    }
    case 'list':
      return layList(b, w, ctx)
    case 'code':
      return layCode(b.text, b.lang, b.lang, w, ctx)
    case 'frontMatter':
      return layCode(b.text, b.format, 'front matter', w, ctx)
    case 'table':
      return layTable(b, w)
    case 'details': {
      const out = new Out()
      const nest = w - 2 >= MIN_INNER
      const iw = nest ? w - 2 : w
      const summary = new Out()
      const rows = inlineRows(b.summary, iw, S_BOLD)
      if (!rows.length) rows.push([])
      for (const r of rows) summary.text(r)
      const arrow: Span[] = [{ text: '▸ ', style: S_BOLD }]
      if (nest) out.add(summary, arrow, [sp(2)], [])
      else {
        out.text(arrow)
        out.add(summary)
      }
      const body = layBlocks(b.children, iw, ctx)
      if (nest) out.add(body, [sp(2)], [sp(2)], [])
      else out.add(body)
      return out
    }
  }
}

function layList(list: List, w: number, ctx: Ctx): Out {
  const out = new Out()
  const bullet = BULLETS[ctx.listDepth % BULLETS.length]!
  const last = list.start + list.items.length - 1
  const numW = list.ordered ? Math.max(String(list.start).length, String(last).length) + list.marker.length : 0
  const markers: Span[][] = list.items.map((item, i) => {
    const m: Span[] = []
    if (list.ordered) m.push({ text: `${list.start + i}${list.marker}`.padStart(numW) + ' ', style: bodyStyle(ctx) })
    if (item.task) m.push({ text: item.task === 'checked' ? '☑ ' : '☐ ', style: item.task === 'checked' ? S_CHECKED : S_MUTED })
    else if (!list.ordered) m.push({ text: `${bullet} `, style: bodyStyle(ctx) })
    return m
  })
  const indent = Math.max(...markers.map(spansWidth))
  const nest = w - indent >= MIN_INNER
  const iw = nest ? w - indent : w
  const sub: Ctx = { ...ctx, listDepth: ctx.listDepth + 1 }
  list.items.forEach((item, i) => {
    const content = layBlocks(item.children, iw, item.task === 'checked' ? { ...sub, muted: true } : sub, list.tight)
    if (i > 0 && !list.tight) out.blank()
    const marker = markers[i]!
    const pad = indent - spansWidth(marker)
    const first = pad > 0 ? [...marker, sp(pad)] : marker
    if (!nest) {
      out.text(spansWidth(first) <= w ? first : [{ text: cut(first.map((s) => s.text).join(''), w).head, style: bodyStyle(ctx) }])
      out.add(content)
      return
    }
    if (!content.rows.length) content.blank()
    out.add(content, first, [sp(indent)], [])
  })
  return out
}

function layCode(text: string, lang: string, label: string, w: number, ctx: Ctx): Out {
  const out = new Out()
  const block = ctx.code.n++
  if (label) {
    const c = cut(label, w)
    out.text([sp(w - c.headW), { text: c.head, style: S_LABEL }])
  }
  const lines = text.split('\n')
  lines.forEach((raw, line) => {
    let rest = expandTabs(raw)
    if (!rest) {
      out.rows.push({ kind: 'code', prefix: [], text: '', lang, block, line })
      return
    }
    while (rest) {
      const c = cut(rest, w)
      out.rows.push({ kind: 'code', prefix: [], text: c.head, lang, block, line })
      rest = c.rest
    }
  })
  return out
}

/**
 * Column widths for `avail` columns: natural when they fit, else shrunk in
 * proportion, not below `min` (nor below a column's longest word, `words`,
 * while those all fit).
 */
export function fitColumns(nat: readonly number[], avail: number, min: number, words?: readonly number[]): number[] {
  const sum = nat.reduce((a, b) => a + b, 0)
  if (sum <= avail) return nat.slice()
  let lower = nat.map((n) => Math.min(n, min))
  if (words) {
    const byWord = nat.map((n, i) => Math.min(n, Math.max(min, words[i]!)))
    if (byWord.reduce((a, b) => a + b, 0) <= avail) lower = byWord
  }
  const ws = nat.map((n, i) => Math.max(lower[i]!, Math.floor((n * avail) / sum)))
  let total = ws.reduce((a, b) => a + b, 0)
  while (total > avail) {
    let k = -1
    for (let i = 0; i < ws.length; i++) if (ws[i]! > lower[i]! && (k < 0 || ws[i]! > ws[k]!)) k = i
    if (k < 0) break
    ws[k]!--
    total--
  }
  while (total < avail) {
    let k = -1
    for (let i = 0; i < ws.length; i++) if (ws[i]! < nat[i]! && (k < 0 || nat[i]! - ws[i]! > nat[k]! - ws[k]!)) k = i
    if (k < 0) break
    ws[k]!++
    total++
  }
  return ws
}

/** Widest unbreakable run of a cell (a word, a code span). */
function longestWord(pieces: Pieces): number {
  return natural(pieces.map((p) => (p === null ? null : p.nb ? p : { ...p, text: p.text.replace(/ +/g, '\n') })).flatMap(splitNl))
}

const splitNl = (p: Pieces[number]): Pieces =>
  p === null || !p.text.includes('\n') ? [p] : p.text.split('\n').flatMap((t, i) => (i ? [null, { ...p, text: t }] : [{ ...p, text: t }]))

function aligned(spans: Span[], cw: number, align: Align): Span[] {
  const free = cw - spansWidth(spans)
  if (free <= 0) return spans
  const left = align === 'right' ? free : align === 'center' ? Math.floor(free / 2) : 0
  const out: Span[] = []
  if (left) out.push(sp(left))
  out.push(...spans)
  if (free - left) out.push(sp(free - left))
  return out
}

function layTable(t: Table, w: number): Out {
  const out = new Out()
  const n = t.align.length
  const header: Pieces[] = t.header.map((c) => flatten(c, S_BOLD))
  const body: Pieces[][] = t.rows.map((r) => r.map((c) => flatten(c, undefined)))
  let pad = 1
  let avail = w - (n + 1) - 2 * n
  if (avail < 3 * n) {
    pad = 0
    avail = w - (n + 1)
  }
  if (n === 0 || avail < 2 * n) {
    // too many columns for the width: each row as wrapped cells joined by │
    for (const [ri, row] of [header, ...body].entries()) {
      const pieces: Pieces = []
      row.forEach((c, i) => {
        if (i) pieces.push({ text: ' │ ', style: S_BORDER })
        for (const p of c) pieces.push(p ?? { text: ' ' })
      })
      for (const r of wrap(pieces, w)) out.text(r)
      if (ri === 0) out.text([{ text: '─'.repeat(w), style: S_BORDER }])
    }
    return markTable(out)
  }
  const nat = Array.from({ length: n }, (_, i) => Math.max(1, natural(header[i]!), ...body.map((r) => natural(r[i]!))))
  const words = Array.from({ length: n }, (_, i) => Math.max(longestWord(header[i]!), ...body.map((r) => longestWord(r[i]!))))
  const ws = fitColumns(nat, avail, pad ? 3 : 2, words)
  const padS = sp(pad)
  const rule = (l: string, m: string, r: string): void =>
    out.text([{ text: l + ws.map((c) => '─'.repeat(c + 2 * pad)).join(m) + r, style: S_BORDER }])
  const bar: Span = { text: '│', style: S_BORDER }
  const drawRow = (cells: Pieces[]): void => {
    const wrapped = cells.map((c, i) => wrap(c, ws[i]!))
    const h = Math.max(1, ...wrapped.map((c) => c.length))
    for (let y = 0; y < h; y++) {
      const spans: Span[] = [bar]
      wrapped.forEach((c, i) => {
        if (pad) spans.push(padS)
        spans.push(...aligned(c[y] ?? [], ws[i]!, t.align[i] ?? null))
        if (pad) spans.push(padS)
        spans.push(bar)
      })
      out.text(spans)
    }
  }
  rule('┌', '┬', '┐')
  drawRow(header)
  if (body.length) {
    rule('├', '┼', '┤')
    // rows taller than one get a rule between them so their cells read apart
    const tall = body.some((r) => r.some((c, i) => wrap(c, ws[i]!).length > 1))
    body.forEach((r, i) => {
      if (i && tall) rule('├', '┼', '┤')
      drawRow(r)
    })
  }
  rule('└', '┴', '┘')
  return markTable(out)
}

/** Flags every text row of a table's Out (rows.ts `table`). */
function markTable(out: Out): Out {
  for (const r of out.rows) if (r.kind === 'text') r.table = true
  return out
}

function layFootnotes(result: ParseResult, w: number, ctx: Ctx): Out {
  const out = new Out()
  if (!result.footnotes.length) return out
  out.text([{ text: '─'.repeat(w), style: S_BORDER }])
  const mw = Math.max(...result.footnotes.map((f) => String(f.n).length + 3))
  const nest = w - mw >= MIN_INNER
  for (const f of result.footnotes) {
    const marker: Span[] = [{ text: `[${f.n}]`, style: S_ACCENT }, sp(mw - String(f.n).length - 2)]
    const content = layBlocks(f.children, nest ? w - mw : w, ctx)
    if (!nest) {
      out.text([marker[0]!])
      out.add(content)
      continue
    }
    if (!content.rows.length) content.blank()
    out.add(content, marker, [sp(mw)], [])
  }
  return out
}

/** Lays the parse out at `width` columns (clamped to MIN_WIDTH). */
export function layout(result: ParseResult, width: number): Layout {
  const w = Math.max(MIN_WIDTH, Math.floor(Number.isFinite(width) ? width : MIN_WIDTH))
  const ctx: Ctx = { code: { n: 0 }, listDepth: 0, muted: false }
  const out = layBlocks(result.blocks, w, ctx)
  const notes = layFootnotes(result, w, ctx)
  if (notes.rows.length) {
    if (out.rows.length) out.blank()
    out.add(notes)
  }
  if (result.truncated) {
    if (out.rows.length) out.blank()
    for (const r of inlineRows([{ type: 'text', text: `… truncated (first ${result.lineCount} lines)` }], w, S_MUTED)) out.text(r)
  }
  const anchors = new Map<string, number>()
  for (const [slug, i] of out.anchors) if (!anchors.has(slug)) anchors.set(slug, i)
  return { rows: out.rows, anchors, width: w }
}

/** Columns a row takes (prefix included). */
export function rowWidth(r: MdRow): number {
  if (r.kind === 'text') return spansWidth(r.spans)
  return spansWidth(r.prefix) + (r.kind === 'code' ? colsOf(r.text) : 0)
}

/** A row as plain text (spans flattened; images as `🖼 alt`), for tests and copy. */
export function plainRow(r: MdRow): string {
  if (r.kind === 'text') return r.spans.map((s) => s.text).join('')
  const pre = r.prefix.map((s) => s.text).join('')
  return r.kind === 'code' ? pre + r.text : `${pre}🖼 ${r.alt}`
}

