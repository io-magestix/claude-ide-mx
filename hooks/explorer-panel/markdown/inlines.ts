// Inline parser (I1–I13): CommonMark delimiter-run algorithm over a linked
// list of nodes (the commonmark.js design), so emphasis wrapping is linear.
// GFM additions: `~`/`~~` strikethrough, bare URL/email autolinks (a pass
// over the final text nodes), footnote refs; I12 inline HTML tags pair up
// through their own opener stack.

import { normalizeLabel } from './ast'
import type { Inline, LinkRef } from './ast'
import { decodeEntity, unescapeString } from './entities'

/** Resolves a footnote label (normalized) to its number, or undefined when not defined. */
export type FootnoteResolver = (label: string) => number | undefined

type LNode = { v: Inline; prev: LNode | null; next: LNode | null; delim?: boolean }

type Delim = {
  cc: string
  node: LNode // a text node holding only the delimiter run
  num: number
  orig: number
  canOpen: boolean
  canClose: boolean
  prev: Delim | null
  next: Delim | null
}

type Bracket = {
  node: LNode
  prev: Bracket | null
  prevDelim: Delim | null
  index: number // start of the bracketed text
  image: boolean
  active: boolean
  bracketAfter: boolean
  tagDepth: number
}

type TagOpen = {
  name: string
  node: LNode
  attrs: Record<string, string>
  prevDelim: Delim | null
  bracket: Bracket | null
}

const ASCII_PUNCT = /^[!-\/:-@\[-`{-~]$/
const UNI_PUNCT = /^[\p{P}\p{S}]$/u
const UNI_WS = /^\s$/u

const TEXT_RUN = /[^\n\\`*_~\[\]!<&]+/y
const SPNL = /[ \t]*(?:\n[ \t]*)?/y
const LABEL = /\[(?:[^\\\[\]]|\\[\s\S]){0,999}\]/y
const ANGLE_DEST = /<((?:[^<>\n\\]|\\[\s\S])*)>/y
const TITLE = /"((?:\\[\s\S]|[^"\\])*)"|'((?:\\[\s\S]|[^'\\])*)'|\(((?:\\[\s\S]|[^()\\])*)\)/y
const ENTITY = /&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/y
const AUTO_URI = /<([A-Za-z][A-Za-z0-9.+-]{1,31}:[^<>\x00-\x20]*)>/y
const AUTO_EMAIL =
  /<([a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/y
const OPEN_TAG =
  /<([A-Za-z][A-Za-z0-9-]*)((?:\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*)\s*(\/?)>/y
const CLOSE_TAG = /<\/([A-Za-z][A-Za-z0-9-]*)\s*>/y
const ATTR = /([A-Za-z_:][\w.:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g

/** I12 tags that wrap their content; '' = unwrap (sub/sup draw plain). */
const PAIRED: Record<string, string> = {
  b: 'strong', strong: 'strong', i: 'emph', em: 'emph', u: 'underline', ins: 'underline',
  s: 'strike', del: 'strike', strike: 'strike', code: 'code', kbd: 'kbd', mark: 'mark',
  a: 'link', sub: '', sup: '', span: '', small: '', big: '', abbr: '', cite: '', q: '',
  samp: 'code', tt: 'code', var: 'emph', dfn: 'emph',
}

function isPunct(ch: string): boolean {
  return ch.length > 0 && (ASCII_PUNCT.test(ch) || UNI_PUNCT.test(ch))
}
function isWs(ch: string): boolean {
  return ch === '' || UNI_WS.test(ch)
}

/** The code point before index i ('' at the start). */
function charBefore(s: string, i: number): string {
  if (i <= 0) return ''
  const lo = s.charCodeAt(i - 1)
  if (lo >= 0xdc00 && lo <= 0xdfff && i >= 2) {
    const hi = s.charCodeAt(i - 2)
    if (hi >= 0xd800 && hi <= 0xdbff) return s.slice(i - 2, i)
  }
  return s[i - 1]!
}
function charAt(s: string, i: number): string {
  if (i >= s.length) return ''
  const cp = s.codePointAt(i)!
  return String.fromCodePoint(cp)
}

/** Plain text of inlines (image alt, slugs, `<code>` content). */
export function plainText(nodes: readonly Inline[]): string {
  let out = ''
  for (const n of nodes) {
    switch (n.type) {
      case 'text':
      case 'code':
        out += n.text
        break
      case 'image':
        out += n.alt
        break
      case 'softBreak':
      case 'hardBreak':
        out += ' '
        break
      case 'emph':
      case 'strong':
      case 'strike':
      case 'mark':
      case 'kbd':
      case 'underline':
      case 'link':
        out += plainText(n.children)
        break
      default:
        break
    }
  }
  return out
}

/** Scans a link destination at pos (inline links and B16). */
export function scanDestination(s: string, pos: number): { value: string; end: number } | null {
  if (s[pos] === '<') {
    ANGLE_DEST.lastIndex = pos
    const m = ANGLE_DEST.exec(s)
    if (!m) return null
    return { value: unescapeString(m[1]!), end: pos + m[0].length }
  }
  let i = pos
  let depth = 0
  while (i < s.length) {
    const c = s.charCodeAt(i)
    if (c === 92 /* \ */ && i + 1 < s.length && ASCII_PUNCT.test(s[i + 1]!)) {
      i += 2
      continue
    }
    if (c === 40 /* ( */) {
      depth++
      if (depth > 32) return null
    } else if (c === 41 /* ) */) {
      if (depth === 0) break
      depth--
    } else if (c <= 32 || c === 127) break
    i++
  }
  if (depth !== 0) return null
  if (i === pos && s[i] !== ')') return null
  return { value: unescapeString(s.slice(pos, i)), end: i }
}

/** Scans a link title at pos (`"…"`, `'…'`, `(…)`). */
export function scanTitle(s: string, pos: number): { value: string; end: number } | null {
  const c = s[pos]
  if (c !== '"' && c !== "'" && c !== '(') return null
  TITLE.lastIndex = pos
  const m = TITLE.exec(s)
  if (!m) return null
  return { value: unescapeString(m[1] ?? m[2] ?? m[3] ?? ''), end: pos + m[0].length }
}

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  ATTR.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = ATTR.exec(raw))) {
    const v = m[2] ?? m[3] ?? m[4] ?? ''
    out[m[1]!.toLowerCase()] = unescapeString(v)
  }
  return out
}

class InlineParser {
  private s: string
  private pos = 0
  private head: LNode | null = null
  private tail: LNode | null = null
  private delims: Delim | null = null
  private brackets: Bracket | null = null
  private tags: TagOpen[] = []
  /** backtick run length → position from which no closer of that length exists */
  private noTicks = new Map<number, number>()

  constructor(
    s: string,
    private refs: Map<string, LinkRef>,
    private footnote: FootnoteResolver | undefined,
  ) {
    this.s = s
  }

  parse(): Inline[] {
    const s = this.s
    while (this.pos < s.length) {
      const c = s[this.pos]!
      switch (c) {
        case '\n':
          this.newline()
          break
        case '\\':
          this.backslash()
          break
        case '`':
          this.backticks()
          break
        case '*':
        case '_':
        case '~':
          this.delimRun(c)
          break
        case '[':
          this.openBracket()
          break
        case '!':
          if (s[this.pos + 1] === '[') this.openBracket()
          else this.text('!', 1)
          break
        case ']':
          this.closeBracket()
          break
        case '<':
          this.angle()
          break
        case '&':
          this.entity()
          break
        default: {
          TEXT_RUN.lastIndex = this.pos
          const m = TEXT_RUN.exec(s)
          const t = m ? m[0] : c
          this.text(t, t.length)
        }
      }
    }
    this.processEmphasis(null)
    return autolink(this.collect(this.head, null), false)
  }

  // ---- node list ----

  private append(v: Inline): LNode {
    const n: LNode = { v, prev: this.tail, next: null }
    if (this.tail) this.tail.next = n
    else this.head = n
    this.tail = n
    return n
  }

  private text(t: string, advance: number): LNode {
    this.pos += advance
    return this.append({ type: 'text', text: t })
  }

  private unlink(n: LNode): void {
    if (n.prev) n.prev.next = n.next
    else this.head = n.next
    if (n.next) n.next.prev = n.prev
    else this.tail = n.prev
    n.prev = n.next = null
  }

  /** Detaches the nodes strictly between `from` and `to` (to null = list end) and returns them merged. */
  private take(from: LNode, to: LNode | null): Inline[] {
    const first = from.next
    if (first === to || !first) return []
    const last = to ? to.prev! : this.tail!
    from.next = to
    if (to) to.prev = from
    else this.tail = from
    first.prev = null
    last.next = null
    return this.collect(first, null)
  }

  private collect(first: LNode | null, stop: LNode | null): Inline[] {
    const out: Inline[] = []
    for (let n = first; n && n !== stop; n = n.next) {
      const v = n.v
      if (v.type === 'text') {
        if (!v.text) continue
        const prev = out[out.length - 1]
        if (prev && prev.type === 'text') {
          out[out.length - 1] = { type: 'text', text: prev.text + v.text }
          continue
        }
        out.push({ type: 'text', text: v.text })
      } else out.push(v)
    }
    return out
  }

  private insertAfter(at: LNode, v: Inline): LNode {
    const n: LNode = { v, prev: at, next: at.next }
    if (at.next) at.next.prev = n
    else this.tail = n
    at.next = n
    return n
  }

  // ---- handlers ----

  private newline(): void {
    this.pos++
    const t = this.tail
    let hard = false
    if (t && t.v.type === 'text' && !t.delim) {
      const txt = t.v.text
      let k = txt.length
      while (k > 0 && txt.charCodeAt(k - 1) === 32) k--
      hard = txt.length - k >= 2
      if (k < txt.length) t.v = { type: 'text', text: txt.slice(0, k) }
    }
    this.append(hard ? { type: 'hardBreak' } : { type: 'softBreak' })
    while (this.s.charCodeAt(this.pos) === 32) this.pos++
  }

  private backslash(): void {
    const next = this.s[this.pos + 1]
    if (next === '\n') {
      this.pos += 2
      this.append({ type: 'hardBreak' })
      while (this.s.charCodeAt(this.pos) === 32) this.pos++
    } else if (next !== undefined && ASCII_PUNCT.test(next)) {
      this.text(next, 2)
    } else this.text('\\', 1)
  }

  private backticks(): void {
    const s = this.s
    const start = this.pos
    let i = start
    while (s.charCodeAt(i) === 96) i++
    const n = i - start
    const after = i
    const failedFrom = this.noTicks.get(n)
    if (failedFrom === undefined || after < failedFrom) {
      let p = after
      while (true) {
        const q = s.indexOf('`', p)
        if (q < 0) break
        let r = q
        while (s.charCodeAt(r) === 96) r++
        if (r - q === n) {
          let content = s.slice(after, q).replace(/\n/g, ' ')
          if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && /[^ ]/.test(content))
            content = content.slice(1, -1)
          this.pos = r
          this.append({ type: 'code', text: content })
          return
        }
        p = r
      }
      this.noTicks.set(n, after)
    }
    this.text(s.slice(start, after), n)
  }

  private delimRun(cc: string): void {
    const s = this.s
    const start = this.pos
    let i = start
    while (s[i] === cc) i++
    const num = i - start
    if (cc === '~' && num > 2) {
      this.text(s.slice(start, i), num)
      return
    }
    const before = charBefore(s, start)
    const after = charAt(s, i)
    const bWs = isWs(before)
    const aWs = isWs(after)
    const bP = isPunct(before)
    const aP = isPunct(after)
    const left = !aWs && (!aP || bWs || bP)
    const right = !bWs && (!bP || aWs || aP)
    let canOpen: boolean
    let canClose: boolean
    if (cc === '_') {
      canOpen = left && (!right || bP)
      canClose = right && (!left || aP)
    } else {
      canOpen = left
      canClose = right
    }
    const node = this.text(s.slice(start, i), num)
    if (!canOpen && !canClose) return
    node.delim = true
    const d: Delim = { cc, node, num, orig: num, canOpen, canClose, prev: this.delims, next: null }
    if (this.delims) this.delims.next = d
    this.delims = d
  }

  private removeDelim(d: Delim): void {
    if (d.prev) d.prev.next = d.next
    if (d.next) d.next.prev = d.prev
    else this.delims = d.prev
  }

  private openBracket(): void {
    const s = this.s
    const image = s[this.pos] === '!'
    if (!image && s[this.pos + 1] === '^' && this.footnote) {
      const close = s.indexOf(']', this.pos + 2)
      if (close > this.pos + 2) {
        const label = s.slice(this.pos + 2, close)
        if (!/[\s\[\]]/.test(label)) {
          const n = this.footnote(normalizeLabel(label))
          if (n !== undefined) {
            this.pos = close + 1
            this.append({ type: 'footnoteRef', label, n })
            return
          }
        }
      }
    }
    const node = this.text(image ? '![' : '[', image ? 2 : 1)
    if (this.brackets) this.brackets.bracketAfter = true
    this.brackets = {
      node,
      prev: this.brackets,
      prevDelim: this.delims,
      index: this.pos,
      image,
      active: true,
      bracketAfter: false,
      tagDepth: this.tags.length,
    }
  }

  private closeBracket(): void {
    const s = this.s
    this.pos++
    const startpos = this.pos
    const opener = this.brackets
    if (!opener) {
      this.append({ type: 'text', text: ']' })
      return
    }
    if (!opener.active) {
      this.brackets = opener.prev
      this.append({ type: 'text', text: ']' })
      return
    }
    let matched = false
    let href = ''
    let title = ''
    if (s[this.pos] === '(') {
      const save = this.pos
      this.pos++
      this.spnl()
      const dest = scanDestination(s, this.pos)
      if (dest) {
        this.pos = dest.end
        const beforeTitle = this.pos
        this.spnl()
        let t: { value: string; end: number } | null = null
        if (this.pos !== beforeTitle) t = scanTitle(s, this.pos)
        if (t) this.pos = t.end
        else this.pos = beforeTitle
        this.spnl()
        if (s[this.pos] === ')') {
          this.pos++
          matched = true
          href = dest.value
          title = t ? t.value : ''
        }
      }
      if (!matched) this.pos = save
    }
    if (!matched) {
      const beforeLabel = this.pos
      LABEL.lastIndex = beforeLabel
      const m = s[beforeLabel] === '[' ? LABEL.exec(s) : null
      const n = m ? m[0].length : 0
      let reflabel: string | null = null
      if (n > 2) reflabel = s.slice(beforeLabel + 1, beforeLabel + n - 1)
      else if (!opener.bracketAfter) reflabel = s.slice(opener.index, startpos - 1)
      this.pos = beforeLabel + n
      if (reflabel !== null && reflabel.length <= 999) {
        const key = normalizeLabel(reflabel)
        const ref = this.refs.get(key)
        if (ref && key !== '') {
          href = ref.href
          title = ref.title
          matched = true
        }
      }
      if (!matched) this.pos = startpos
    }
    if (!matched) {
      this.brackets = opener.prev
      this.append({ type: 'text', text: ']' })
      return
    }
    this.processEmphasis(opener.prevDelim)
    if (this.tags.length > opener.tagDepth) this.tags.length = opener.tagDepth
    const children = this.take(opener.node, null)
    opener.node.v = opener.image
      ? { type: 'image', src: href, title, alt: plainText(children) }
      : { type: 'link', href, title, children }
    this.brackets = opener.prev
    if (!opener.image) for (let b = this.brackets; b; b = b.prev) if (!b.image) b.active = false
  }

  private spnl(): void {
    SPNL.lastIndex = this.pos
    const m = SPNL.exec(this.s)
    if (m) this.pos += m[0].length
  }

  private entity(): void {
    ENTITY.lastIndex = this.pos
    const m = ENTITY.exec(this.s)
    if (m) {
      const d = decodeEntity(m[1]!)
      if (d !== undefined) {
        this.text(d, m[0].length)
        return
      }
    }
    this.text('&', 1)
  }

  private angle(): void {
    const s = this.s
    const p = this.pos
    let m: RegExpExecArray | null
    AUTO_URI.lastIndex = p
    if ((m = AUTO_URI.exec(s))) {
      this.pos += m[0].length
      this.append({ type: 'link', href: m[1]!, title: '', children: [{ type: 'text', text: m[1]! }] })
      return
    }
    AUTO_EMAIL.lastIndex = p
    if ((m = AUTO_EMAIL.exec(s))) {
      this.pos += m[0].length
      this.append({
        type: 'link',
        href: 'mailto:' + m[1]!,
        title: '',
        children: [{ type: 'text', text: m[1]! }],
      })
      return
    }
    if (s.startsWith('<!--', p)) {
      let end: number
      if (s.startsWith('<!-->', p)) end = p + 5
      else if (s.startsWith('<!--->', p)) end = p + 6
      else {
        const q = s.indexOf('-->', p + 4)
        end = q < 0 ? -1 : q + 3
      }
      if (end > 0) {
        this.pos = end
        this.append({ type: 'html', raw: s.slice(p, end) })
        return
      }
    }
    CLOSE_TAG.lastIndex = p
    if ((m = CLOSE_TAG.exec(s))) {
      this.pos += m[0].length
      this.closeTag(m[1]!.toLowerCase(), m[0])
      return
    }
    OPEN_TAG.lastIndex = p
    if ((m = OPEN_TAG.exec(s))) {
      this.pos += m[0].length
      this.openTag(m[1]!.toLowerCase(), m[2] ?? '', m[3] === '/', m[0])
      return
    }
    this.text('<', 1)
  }

  private openTag(name: string, rawAttrs: string, selfClosing: boolean, raw: string): void {
    if (name === 'br') {
      this.append({ type: 'hardBreak' })
      return
    }
    if (name === 'img') {
      const a = parseAttrs(rawAttrs)
      this.append({ type: 'image', src: a.src ?? '', title: a.title ?? '', alt: a.alt ?? '' })
      return
    }
    const node = this.append({ type: 'html', raw })
    if (selfClosing || !(name in PAIRED)) return
    this.tags.push({ name, node, attrs: parseAttrs(rawAttrs), prevDelim: this.delims, bracket: this.brackets })
  }

  private closeTag(name: string, raw: string): void {
    if (name === 'br') {
      this.append({ type: 'hardBreak' })
      return
    }
    let k = this.tags.length - 1
    while (k >= 0 && this.tags[k]!.name !== name) k--
    if (k < 0) {
      this.append({ type: 'html', raw })
      return
    }
    const t = this.tags[k]!
    this.processEmphasis(t.prevDelim)
    this.tags.length = k
    this.brackets = t.bracket
    const children = this.take(t.node, null)
    const kind = PAIRED[name]!
    if (kind === '') {
      // unwrap: the opener node becomes empty text, children follow it
      t.node.v = { type: 'text', text: '' }
      let at = t.node
      for (const c of children) at = this.insertAfter(at, c)
      return
    }
    if (kind === 'code') t.node.v = { type: 'code', text: plainText(children) }
    else if (kind === 'link') t.node.v = { type: 'link', href: t.attrs.href ?? '', title: t.attrs.title ?? '', children }
    else t.node.v = { type: kind as 'emph', children }
  }

  // ---- emphasis (CommonMark "process emphasis") ----

  private processEmphasis(bottom: Delim | null): void {
    const openersBottom = new Map<string, Delim | null>()
    let closer = this.delims
    while (closer && closer.prev !== bottom) closer = closer.prev
    while (closer) {
      if (!closer.canClose) {
        closer = closer.next
        continue
      }
      const cc = closer.cc
      const key = cc === '~' ? '~' + closer.num : cc + (closer.canOpen ? '1' : '0') + (closer.orig % 3)
      const floor = openersBottom.has(key) ? openersBottom.get(key)! : bottom
      let opener = closer.prev
      let found = false
      while (opener && opener !== bottom && opener !== floor) {
        if (opener.cc === cc && opener.canOpen) {
          if (cc === '~') {
            if (opener.num === closer.num) {
              found = true
              break
            }
          } else {
            const odd =
              (closer.canOpen || opener.canClose) &&
              closer.orig % 3 !== 0 &&
              (opener.orig + closer.orig) % 3 === 0
            if (!odd) {
              found = true
              break
            }
          }
        }
        opener = opener.prev
      }
      const oldCloser = closer
      if (found && opener) {
        const use = cc === '~' ? closer.num : closer.num >= 2 && opener.num >= 2 ? 2 : 1
        opener.num -= use
        closer.num -= use
        const on = opener.node
        const cn = closer.node
        on.v = { type: 'text', text: (on.v as { text: string }).text.slice(0, opener.num) }
        cn.v = { type: 'text', text: (cn.v as { text: string }).text.slice(0, closer.num) }
        const children = this.take(on, cn)
        const kind = cc === '~' ? 'strike' : use === 2 ? 'strong' : 'emph'
        this.insertAfter(on, { type: kind, children })
        // drop delimiters between opener and closer
        opener.next = closer
        closer.prev = opener
        if (opener.num === 0) {
          this.unlink(on)
          this.removeDelim(opener)
        }
        if (closer.num === 0) {
          const nxt = closer.next
          this.unlink(cn)
          this.removeDelim(closer)
          closer = nxt
        }
      } else {
        closer = closer.next
        openersBottom.set(key, oldCloser.prev)
        if (!oldCloser.canOpen) this.removeDelim(oldCloser)
      }
    }
    while (this.delims && this.delims !== bottom) this.removeDelim(this.delims)
  }
}

// ---- GFM extended autolinks (I8) over final text nodes ----

const URL_BOUNDARY = /^[\s*_~(]?$/

function trimUrlEnd(u: string): string {
  while (u.length) {
    const last = u[u.length - 1]!
    if ('?!.,:*_~\'"'.includes(last)) {
      u = u.slice(0, -1)
      continue
    }
    if (last === ')') {
      let open = 0
      let close = 0
      for (const ch of u) {
        if (ch === '(') open++
        else if (ch === ')') close++
      }
      if (close > open) {
        u = u.slice(0, -1)
        continue
      }
    }
    if (last === ';') {
      const m = /&[A-Za-z0-9]+;$/.exec(u)
      if (m) {
        u = u.slice(0, m.index)
        continue
      }
    }
    break
  }
  return u
}

function validDomain(d: string): boolean {
  return /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(d)
}

const LOCAL_CH = /[A-Za-z0-9.+_-]/
const DOMAIN_CH = /[A-Za-z0-9._-]/

function linkifyText(t: string): Inline[] | null {
  if (t.indexOf('://') < 0 && t.indexOf('www.') < 0 && t.indexOf('@') < 0) return null
  const out: Inline[] = []
  let last = 0
  let i = 0
  const push = (start: number, end: number, href: string) => {
    if (start > last) out.push({ type: 'text', text: t.slice(last, start) })
    const label = t.slice(start, end)
    out.push({ type: 'link', href, title: '', children: [{ type: 'text', text: label }] })
    last = end
  }
  while (i < t.length) {
    const c = t[i]
    if ((c === 'h' || c === 'w') && i >= last && URL_BOUNDARY.test(i > 0 ? t[i - 1]! : '')) {
      const prefix = t.startsWith('https://', i)
        ? 8
        : t.startsWith('http://', i)
          ? 7
          : t.startsWith('www.', i)
            ? 0
            : -1
      if (prefix >= 0) {
        let j = i
        while (j < t.length && !/[\s<]/.test(t[j]!)) j++
        const url = trimUrlEnd(t.slice(i, j))
        const rest = url.slice(prefix)
        const domain = rest.split(/[\/?#]/)[0]!
        const ok = prefix === 0 ? domain.length > 4 && validDomain(domain) : validDomain(domain.split(':')[0]!)
        if (ok && url.length > prefix) {
          push(i, i + url.length, prefix === 0 ? 'http://' + url : url)
          i += url.length
          continue
        }
      }
    } else if (c === '@') {
      let a = i
      while (a > last && LOCAL_CH.test(t[a - 1]!)) a--
      let b = i + 1
      while (b < t.length && DOMAIN_CH.test(t[b]!)) b++
      while (b > i + 1 && t[b - 1] === '.') b--
      const domain = t.slice(i + 1, b)
      const lastCh = domain[domain.length - 1]
      if (a < i && domain.includes('.') && lastCh !== '-' && lastCh !== '_' && !domain.startsWith('.')) {
        const addr = t.slice(a, b)
        push(a, b, 'mailto:' + addr)
        i = b
        continue
      }
    }
    i++
  }
  if (!out.length) return null
  if (last < t.length) out.push({ type: 'text', text: t.slice(last) })
  return out
}

function autolink(nodes: Inline[], inLink: boolean): Inline[] {
  let changed = false
  const out: Inline[] = []
  for (const n of nodes) {
    if (n.type === 'text' && !inLink) {
      const parts = linkifyText(n.text)
      if (parts) {
        out.push(...parts)
        changed = true
        continue
      }
      out.push(n)
    } else if ('children' in n) {
      const kids = autolink(n.children, inLink || n.type === 'link')
      if (kids !== n.children) {
        out.push({ ...n, children: kids } as Inline)
        changed = true
      } else out.push(n)
    } else out.push(n)
  }
  return changed ? out : nodes
}

/**
 * Parses inline markdown. `refs` resolves reference links (B16), `footnote`
 * numbers `[^label]` refs (I13; unresolved stay literal text).
 */
export function parseInlines(
  text: string,
  refs: Map<string, LinkRef> = new Map(),
  footnote?: FootnoteResolver,
): Inline[] {
  if (!text) return []
  return new InlineParser(text, refs, footnote).parse()
}
