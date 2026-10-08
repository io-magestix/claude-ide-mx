// Block parser (B1–B21): the CommonMark two-phase container algorithm
// (commonmark.js design) — per line, match open containers, try block
// starts, then lazy paragraph continuation — plus GFM tables and footnote
// definitions. A conversion pass then builds the final AST (ast.ts),
// parsing inlines in document order so footnotes number by first reference.

import { normalizeLabel } from './ast'
import type {
  AlertKind,
  Align,
  Block,
  FootnoteDef,
  Inline,
  LineRange,
  LinkRef,
  ListItem,
} from './ast'
import { unescapeString } from './entities'
import { parseInlines, plainText, scanDestination, scanTitle } from './inlines'

type BType =
  | 'document'
  | 'quote'
  | 'list'
  | 'item'
  | 'paragraph'
  | 'heading'
  | 'thematicBreak'
  | 'code'
  | 'html'
  | 'table'
  | 'footnoteDef'

type ListData = {
  ordered: boolean
  marker: string // bullet char or ordered delimiter
  start: number
  markerOffset: number
  padding: number
  tight: boolean
}

class BNode {
  children: BNode[] = []
  parent: BNode | null = null
  open = true
  lastLineBlank = false
  lastLineChecked = false
  endLine: number
  lines: string[] = []
  level = 0
  setext = false
  fenced = false
  fenceChar = ''
  fenceLen = 0
  fenceOffset = 0
  info = ''
  closed = false
  htmlType = 0
  list: ListData | null = null
  label = ''
  align: Align[] = []
  constructor(
    public type: BType,
    public startLine: number,
  ) {
    this.endLine = startLine
  }
}

// ---- normalization (M2, M4) ----

/** Strips a BOM, folds CRLF/CR to LF, expands tabs to 4-column stops. */
export function normalize(text: string): string {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  if (text.indexOf('\r') >= 0) text = text.replace(/\r\n?/g, '\n')
  if (text.indexOf('\t') >= 0)
    text = text
      .split('\n')
      .map((l) => (l.indexOf('\t') >= 0 ? expandTabStops4(l) : l))
      .join('\n')
  return text
}

// CommonMark's 4-column tab stops (not the Code view's `expandTabs`).
function expandTabStops4(line: string): string {
  let out = ''
  let col = 0
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (c === '\t') {
      const n = 4 - (col % 4)
      out += ' '.repeat(n)
      col += n
    } else {
      out += c
      col++
    }
  }
  return out
}

// ---- line-level patterns ----

const MAYBE_SPECIAL = /^[#`~*+_=<>0-9\-|\[:]/
const ATX = /^#{1,6}(?: +|$)/
const FENCE_OPEN = /^`{3,}(?!.*`)|^~{3,}/
const FENCE_CLOSE = /^(?:`{3,}|~{3,}) *$/
const SETEXT = /^(?:=+|-+) *$/
const ORDERED = /^(\d{1,9})([.)])/
const FOOTNOTE_DEF = /^\[\^([^\]\s]+)\]:/
const ALERT = /^\[!(note|tip|important|warning|caution)\]$/i
const TASK = /^\[([ xX])\](?: +|$)/

const BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul'
const HTML_START: RegExp[] = [
  /^$/, // unused (types are 1-based)
  /^<(?:script|pre|style|textarea)(?:\s|>|$)/i,
  /^<!--/,
  /^<[?]/,
  /^<![A-Za-z]/,
  /^<!\[CDATA\[/,
  new RegExp(`^</?(?:${BLOCK_TAGS})(?:\\s|/?>|$)`, 'i'),
  /^(?:<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>)\s*$/,
]
const HTML_END: RegExp[] = [
  /^$/,
  /<\/(?:script|pre|style|textarea)>/i,
  /-->/,
  /\?>/,
  />/,
  /\]\]>/,
]

function isThematic(s: string): boolean {
  const c = s[0]
  if (c !== '*' && c !== '-' && c !== '_') return false
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === c) n++
    else if (ch !== ' ') return false
  }
  return n >= 3
}

/** Splits a GFM table row into trimmed cells; `\|` becomes `|`. */
export function splitRow(line: string): string[] {
  let t = line.trim()
  if (t.startsWith('|')) t = t.slice(1)
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1)
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < t.length; i++) {
    const c = t[i]
    if (c === '\\' && t[i + 1] === '|') {
      cur += '|'
      i++
    } else if (c === '|') {
      cells.push(cur.trim())
      cur = ''
    } else cur += c
  }
  cells.push(cur.trim())
  return cells
}

function delimiterRow(line: string): Align[] | null {
  if (line.indexOf('|') < 0) return null
  const cells = splitRow(line)
  const out: Align[] = []
  for (const c of cells) {
    if (!/^:?-+:?$/.test(c)) return null
    const l = c.startsWith(':')
    const r = c.endsWith(':')
    out.push(l && r ? 'center' : r ? 'right' : l ? 'left' : null)
  }
  return out
}

// ---- link reference definitions (B16) ----

/** Strips leading definitions from paragraph text into `refs`; returns the rest. */
function extractRefs(text: string, refs: Map<string, LinkRef>): string {
  while (text.startsWith('[')) {
    const n = parseRefDef(text, refs)
    if (!n) break
    text = text.slice(n)
  }
  return text
}

const REF_LABEL = /^\[((?:[^\\\[\]]|\\[\s\S]){1,999})\]:/
const SP = /[ \t]*/y
const SPNL = /[ \t]*(?:\n[ \t]*)?/y

function skip(re: RegExp, s: string, p: number): number {
  re.lastIndex = p
  const m = re.exec(s)
  return m ? p + m[0].length : p
}

function lineEndAt(s: string, p: number): number {
  p = skip(SP, s, p)
  if (p >= s.length) return p
  return s[p] === '\n' ? p + 1 : -1
}

function parseRefDef(s: string, refs: Map<string, LinkRef>): number {
  const m = REF_LABEL.exec(s)
  if (!m) return 0
  const label = m[1]!
  if (label.startsWith('^') || !/\S/.test(label)) return 0
  let p = skip(SPNL, s, m[0].length)
  const dest = scanDestination(s, p)
  if (!dest || (dest.end === p) || (s[p] !== '<' && dest.value === '' )) return 0
  p = dest.end
  const afterDest = p
  if (p < s.length && !/[ \t\n]/.test(s[p]!)) return 0
  p = skip(SPNL, s, p)
  let title: string | null = null
  if (p !== afterDest) {
    const t = scanTitle(s, p)
    if (t) {
      title = t.value
      p = t.end
    }
  }
  let end = title !== null ? lineEndAt(s, p) : -1
  if (end < 0) {
    title = null
    end = lineEndAt(s, afterDest)
    if (end < 0) return 0
  }
  const key = normalizeLabel(label)
  if (!refs.has(key)) refs.set(key, { href: dest.value, title: title ?? '' })
  return end
}

// ---- the block parser ----

class BlockParser {
  doc: BNode
  tip: BNode
  oldtip: BNode
  lastMatched: BNode
  allClosed = true
  line = ''
  lineNo = 0
  offset = 0
  nextNonspace = 0
  indent = 0
  blank = false
  /** the line opened a fence or a table and holds no content of its own */
  consumed = false
  refs =new Map<string, LinkRef>()
  footnoteDefs = new Map<string, BNode>()

  constructor(firstLine: number) {
    this.doc = new BNode('document', firstLine)
    this.tip = this.oldtip = this.lastMatched = this.doc
    this.lineNo = firstLine - 1
  }

  run(lines: string[]): BNode {
    for (const l of lines) this.incorporate(l)
    while (this.tip !== this.doc) this.finalize(this.tip)
    this.finalize(this.doc)
    return this.doc
  }

  private findNextNonspace(): void {
    let i = this.offset
    const l = this.line
    while (l.charCodeAt(i) === 32) i++
    this.nextNonspace = i
    this.indent = i - this.offset
    this.blank = i >= l.length
  }

  private advanceNextNonspace(): void {
    this.offset = this.nextNonspace
  }

  private closeUnmatched(): void {
    if (!this.allClosed) {
      while (this.oldtip !== this.lastMatched) {
        const parent = this.oldtip.parent!
        this.finalize(this.oldtip)
        this.oldtip = parent
      }
      this.allClosed = true
    }
  }

  private addChild(type: BType, start: number): BNode {
    while (!canContain(this.tip.type, type)) this.finalize(this.tip)
    const n = new BNode(type, start)
    n.parent = this.tip
    this.tip.children.push(n)
    this.tip = n
    return n
  }

  private addLine(): void {
    this.tip.lines.push(this.line.slice(this.offset))
    this.tip.endLine = this.lineNo
  }

  private incorporate(line: string): void {
    this.lineNo++
    this.line = line
    this.offset = 0
    this.consumed = false
    let container = this.doc
    this.oldtip = this.tip

    // 1. continuation of open containers
    for (;;) {
      const last = container.children[container.children.length - 1]
      if (!last || !last.open) break
      container = last
      this.findNextNonspace()
      const r = this.continues(container)
      if (r === 0) {
        if (container.type === 'quote') container.endLine = this.lineNo
        continue
      }
      if (r === 2) return
      container = container.parent!
      break
    }
    this.allClosed = container === this.oldtip
    this.lastMatched = container

    // 2. new block starts
    let matchedLeaf = container.type !== 'paragraph' && container.type !== 'table' && acceptsLines(container.type)
    while (!matchedLeaf) {
      this.findNextNonspace()
      if (this.indent < 4 && !MAYBE_SPECIAL.test(this.line[this.nextNonspace] ?? '')) {
        this.advanceNextNonspace()
        break
      }
      const r = this.blockStart(container)
      if (r === 1) {
        container = this.tip
        continue
      }
      if (r === 2) {
        container = this.tip
        matchedLeaf = true
        break
      }
      this.advanceNextNonspace()
      break
    }

    // 3. the rest of the line
    if (!this.allClosed && !this.blank && this.tip.type === 'paragraph') {
      this.tip.lines.push(this.line.slice(this.offset).replace(/^ +/, ''))
      this.tip.endLine = this.lineNo
      return
    }
    this.closeUnmatched()
    if (this.blank && container.children.length) container.children[container.children.length - 1]!.lastLineBlank = true
    const t = container.type
    const lastLineBlank =
      this.blank &&
      !(
        t === 'quote' ||
        (t === 'code' && container.fenced) ||
        (t === 'item' && !container.children.length && container.startLine === this.lineNo)
      )
    for (let c: BNode | null = container; c; c = c.parent) c.lastLineBlank = lastLineBlank
    if (this.consumed) return
    if (acceptsLines(t)) {
      if (t === 'paragraph') {
        container.lines.push(this.line.slice(this.offset).replace(/^ +/, ''))
        container.endLine = this.lineNo
      } else this.addLine()
      if (t === 'html' && container.htmlType >= 1 && container.htmlType <= 5) {
        if (HTML_END[container.htmlType]!.test(this.line.slice(this.offset))) this.finalize(container)
      }
    } else if (this.offset < this.line.length && !this.blank) {
      this.addChild('paragraph', this.lineNo)
      this.advanceNextNonspace()
      this.addLine()
    }
  }

  /** 0 matched, 1 not matched, 2 line consumed. */
  private continues(c: BNode): 0 | 1 | 2 {
    const l = this.line
    switch (c.type) {
      case 'list':
        return 0
      case 'quote':
        if (this.indent <= 3 && l[this.nextNonspace] === '>') {
          this.advanceNextNonspace()
          this.offset++
          if (l[this.offset] === ' ') this.offset++
          return 0
        }
        return 1
      case 'item': {
        const d = c.list!
        if (this.blank) {
          if (!c.children.length) return 1
          this.advanceNextNonspace()
          return 0
        }
        if (this.indent >= d.markerOffset + d.padding) {
          this.offset += d.markerOffset + d.padding
          return 0
        }
        return 1
      }
      case 'footnoteDef':
        if (this.blank) {
          this.advanceNextNonspace()
          return 0
        }
        if (this.indent >= 4) {
          this.offset += 4
          return 0
        }
        return 1
      case 'code':
        if (c.fenced) {
          if (this.indent <= 3 && l[this.nextNonspace] === c.fenceChar) {
            const rest = l.slice(this.nextNonspace)
            if (FENCE_CLOSE.test(rest)) {
              let n = 0
              while (rest[n] === c.fenceChar) n++
              if (n >= c.fenceLen) {
                c.closed = true
                c.endLine = this.lineNo
                this.finalize(c)
                return 2
              }
            }
          }
          let i = c.fenceOffset
          while (i > 0 && l[this.offset] === ' ') {
            this.offset++
            i--
          }
          return 0
        }
        if (this.indent >= 4) {
          this.offset += 4
          return 0
        }
        if (this.blank) {
          this.advanceNextNonspace()
          return 0
        }
        return 1
      case 'html':
        return this.blank && (c.htmlType === 6 || c.htmlType === 7) ? 1 : 0
      case 'paragraph':
      case 'table':
        return this.blank ? 1 : 0
      default:
        return 1
    }
  }

  /** 0 none, 1 container started, 2 leaf started. */
  private blockStart(container: BNode): 0 | 1 | 2 {
    const l = this.line
    const nns = this.nextNonspace
    const rest = l.slice(nns)
    const indented = this.indent >= 4
    const c0 = rest[0]

    // block quote
    if (!indented && c0 === '>') {
      this.advanceNextNonspace()
      this.offset++
      if (l[this.offset] === ' ') this.offset++
      this.closeUnmatched()
      this.addChild('quote', this.lineNo)
      return 1
    }
    // ATX heading
    if (!indented && c0 === '#') {
      const m = ATX.exec(rest)
      if (m) {
        this.closeUnmatched()
        const h = this.addChild('heading', this.lineNo)
        h.level = m[0].trim().length
        h.lines = [atxContent(rest.slice(m[0].length))]
        this.offset = l.length
        return 2
      }
    }
    // fenced code
    if (!indented && (c0 === '`' || c0 === '~')) {
      const m = FENCE_OPEN.exec(rest)
      if (m) {
        this.closeUnmatched()
        const f = this.addChild('code', this.lineNo)
        f.fenced = true
        f.fenceChar = c0
        f.fenceLen = m[0].length
        f.fenceOffset = this.indent
        f.info = unescapeString(rest.slice(m[0].length).trim())
        this.offset = l.length
        this.consumed = true
        return 2
      }
    }
    // HTML block
    if (!indented && c0 === '<') {
      for (let t = 1; t <= 7; t++) {
        if (
          HTML_START[t]!.test(rest) &&
          (t < 7 ||
            (container.type !== 'paragraph' &&
              container.type !== 'table' &&
              !(!this.allClosed && !this.blank && this.tip.type === 'paragraph')))
        ) {
          this.closeUnmatched()
          const h = this.addChild('html', this.lineNo)
          h.htmlType = t
          return 2
        }
      }
    }
    // GFM table: the paragraph's last line is the header, this line the delimiter row
    if (!indented && container.type === 'paragraph' && container.lines.length) {
      const align = delimiterRow(rest)
      if (align) {
        const header = container.lines[container.lines.length - 1]!
        if (splitRow(header).length === align.length) {
          this.closeUnmatched()
          const para = container
          para.lines.pop()
          para.endLine = this.lineNo - 2
          const parent = para.parent!
          if (!para.lines.length) parent.children.pop()
          else this.finalize(para)
          this.tip = parent
          const t = this.addChild('table', this.lineNo - 1)
          t.align = align
          t.lines = [header]
          t.endLine = this.lineNo
          this.offset = l.length
          this.consumed = true
          return 2
        }
      }
    }
    // setext heading
    if (!indented && container.type === 'paragraph' && SETEXT.test(rest)) {
      this.closeUnmatched()
      const text = extractRefs(container.lines.join('\n'), this.refs)
      if (text.trim()) {
        const removed = container.lines.length - text.split('\n').length
        const h = new BNode('heading', container.startLine + removed)
        h.level = c0 === '=' ? 1 : 2
        h.setext = true
        h.lines = [text.trim()]
        h.endLine = this.lineNo
        const parent = container.parent!
        parent.children[parent.children.length - 1] = h
        h.parent = parent
        this.tip = h
        this.offset = l.length
        return 2
      }
      container.lines = []
      // fall through: the line may be a thematic break
    }
    // thematic break
    if (!indented && isThematic(rest)) {
      this.closeUnmatched()
      this.addChild('thematicBreak', this.lineNo)
      this.offset = l.length
      return 2
    }
    // footnote definition (B21)
    if (!indented && c0 === '[') {
      const m = FOOTNOTE_DEF.exec(rest)
      if (m) {
        this.closeUnmatched()
        const f = this.addChild('footnoteDef', this.lineNo)
        f.label = m[1]!
        this.advanceNextNonspace()
        this.offset += m[0].length
        while (l[this.offset] === ' ') this.offset++
        const key = normalizeLabel(f.label)
        if (!this.footnoteDefs.has(key)) this.footnoteDefs.set(key, f)
        return 1
      }
    }
    // list item
    if (!indented) {
      const data = this.listMarker(container)
      if (data) {
        this.closeUnmatched()
        const tip = this.tip
        if (tip.type !== 'list' || !listsMatch(tip.list!, data)) {
          const list = this.addChild('list', this.lineNo)
          list.list = { ...data }
        }
        const item = this.addChild('item', this.lineNo)
        item.list = data
        return 1
      }
    }
    // indented code
    if (indented && this.tip.type !== 'paragraph' && this.tip.type !== 'table' && !this.blank) {
      this.offset += 4
      this.closeUnmatched()
      this.addChild('code', this.lineNo)
      return 2
    }
    return 0
  }

  private listMarker(container: BNode): ListData | null {
    const l = this.line
    const nns = this.nextNonspace
    const c0 = l[nns]
    let ordered = false
    let marker: string
    let start = 1
    let len: number
    if (c0 === '-' || c0 === '*' || c0 === '+') {
      marker = c0
      len = 1
    } else {
      const m = ORDERED.exec(l.slice(nns, nns + 11))
      if (!m || (container.type === 'paragraph' && m[1] !== '1')) return null
      ordered = true
      marker = m[2]!
      start = parseInt(m[1]!, 10)
      len = m[0].length
    }
    const after = l[nns + len]
    if (after !== undefined && after !== ' ') return null
    if (container.type === 'paragraph' && !/\S/.test(l.slice(nns + len))) return null
    const markerOffset = this.indent
    this.advanceNextNonspace()
    this.offset += len
    let i = this.offset
    while (l.charCodeAt(i) === 32) i++
    const spaces = i - this.offset
    const blankItem = i >= l.length
    let padding: number
    if (spaces >= 5 || spaces < 1 || blankItem) {
      padding = len + 1
      if (l[this.offset] === ' ') this.offset++
    } else {
      padding = len + spaces
      this.offset = i
    }
    return { ordered, marker, start, markerOffset, padding, tight: true }
  }

  finalize(b: BNode): void {
    const above = b.parent
    b.open = false
    switch (b.type) {
      case 'paragraph': {
        const before = b.lines.length
        const text = extractRefs(b.lines.join('\n'), this.refs)
        if (!text.trim()) {
          if (above) {
            const i = above.children.lastIndexOf(b)
            if (i >= 0) above.children.splice(i, 1)
          }
        } else {
          b.lines = text.split('\n')
          b.startLine += before - b.lines.length
        }
        break
      }
      case 'code':
        if (b.fenced) break
      // falls through: indented code drops trailing blank lines as html does
      case 'html': {
        let n = b.lines.length
        while (n > 0 && !/\S/.test(b.lines[n - 1]!)) n--
        b.endLine -= b.lines.length - n
        b.lines.length = n
        break
      }
      case 'list':
        b.list!.tight = listTight(b)
        break
      default:
        break
    }
    this.tip = above ?? b
  }
}

function canContain(parent: BType, child: BType): boolean {
  switch (parent) {
    case 'document':
    case 'quote':
    case 'item':
    case 'footnoteDef':
      return child !== 'item'
    case 'list':
      return child === 'item'
    default:
      return false
  }
}

function acceptsLines(t: BType): boolean {
  return t === 'paragraph' || t === 'code' || t === 'html' || t === 'table'
}

function listsMatch(a: ListData, b: ListData): boolean {
  return a.ordered === b.ordered && a.marker === b.marker
}

function endsWithBlankLine(b: BNode | undefined): boolean {
  while (b) {
    if (b.lastLineBlank) return true
    if (!b.lastLineChecked && (b.type === 'list' || b.type === 'item')) {
      b.lastLineChecked = true
      b = b.children[b.children.length - 1]
    } else {
      b.lastLineChecked = true
      break
    }
  }
  return false
}

function listTight(list: BNode): boolean {
  const items = list.children
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    const hasNext = i < items.length - 1
    if (endsWithBlankLine(item) && hasNext) return false
    const subs = item.children
    for (let j = 0; j < subs.length; j++) {
      if (endsWithBlankLine(subs[j]) && (hasNext || j < subs.length - 1)) return false
    }
  }
  return true
}

function atxContent(s: string): string {
  let t = s.replace(/ +$/, '')
  let k = t.length
  while (k > 0 && t[k - 1] === '#') k--
  if (k < t.length && (k === 0 || t[k - 1] === ' ')) t = t.slice(0, k)
  return t.trim()
}

// ---- conversion to the final AST ----

/** GitHub heading slug (github-slugger rules, without the duplicate suffix). */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-')
}

type Ctx = {
  refs: Map<string, LinkRef>
  slugs: Map<string, number>
  footnote: (label: string) => number | undefined
}

function inl(ctx: Ctx, text: string): Inline[] {
  return parseInlines(text, ctx.refs, ctx.footnote)
}

const BLOCK_TAG = /^<\/?(?:tr|p|div|li|h[1-6]|table|thead|tbody|tfoot|blockquote|ul|ol)(?=[\s/>])/i
const CELL_OPEN = /^<(?:td|th)(?=[\s/>])/i
const CELL_SEP = ' │ '

/**
 * B20: an HTML block's top-level inlines as text flow. Block tags (`<tr>`,
 * `<div>`, `<p>`, ...) become one hardBreak per run, none at the start or end;
 * a `<td>`/`<th>` after another cell on its row adds ` │ `. Whitespace at a
 * boundary is dropped. Tag nodes nested in inline elements are left alone.
 */
export function htmlFlow(nodes: readonly Inline[]): Inline[] {
  const out: Inline[] = []
  let pending: '' | 'break' | 'cell' = ''
  let lineHasContent = false
  const isSpace = (n: Inline) => n.type === 'softBreak' || (n.type === 'text' && n.text.trim() === '')
  const trimEnd = () => {
    for (let i = out.length - 1; i >= 0; i--) {
      const n = out[i]!
      if (n.type === 'html') continue
      if (isSpace(n)) {
        out.splice(i, 1)
        continue
      }
      if (n.type === 'text') out[i] = { ...n, text: n.text.replace(/\s+$/, '') }
      break
    }
  }
  for (const n of nodes) {
    if (n.type === 'html') {
      if (BLOCK_TAG.test(n.raw)) pending = 'break'
      else if (CELL_OPEN.test(n.raw)) pending ||= 'cell'
      else out.push(n)
      continue
    }
    if (isSpace(n) && (pending || !lineHasContent)) continue
    if (n.type === 'hardBreak') {
      // `<br>`: kept, but a block boundary already breaks the line
      if (pending !== 'break' || lineHasContent) {
        trimEnd()
        out.push(n)
      }
      pending = ''
      lineHasContent = false
      continue
    }
    if (pending && lineHasContent) {
      trimEnd()
      out.push(pending === 'break' ? { type: 'hardBreak' } : { type: 'text', text: CELL_SEP })
      if (pending === 'break') lineHasContent = false
    }
    out.push(!lineHasContent && n.type === 'text' ? { ...n, text: n.text.replace(/^\s+/, '') } : n)
    pending = ''
    lineHasContent = true
  }
  trimEnd()
  return out
}

function spanOf(b: BNode): LineRange {
  let end = b.endLine
  const last = b.children[b.children.length - 1]
  if (last) end = Math.max(end, spanOf(last).endLine)
  return { startLine: b.startLine, endLine: Math.max(b.startLine, end) }
}

function convertAll(nodes: BNode[], ctx: Ctx, top: boolean): Block[] {
  const out: Block[] = []
  for (const n of nodes) {
    const b = convert(n, ctx, top)
    if (b) out.push(b)
  }
  return groupDetails(out, ctx)
}

function convert(n: BNode, ctx: Ctx, top: boolean): Block | null {
  const span = spanOf(n)
  switch (n.type) {
    case 'paragraph':
      return { type: 'paragraph', ...span, inlines: inl(ctx, n.lines.join('\n').replace(/\s+$/, '')) }
    case 'heading': {
      const inlines = inl(ctx, n.lines[0] ?? '')
      return {
        type: 'heading',
        ...span,
        level: n.level as 1,
        setext: n.setext,
        inlines,
        slug: uniqueSlug(ctx, slugify(plainText(inlines))),
      }
    }
    case 'thematicBreak':
      return { type: 'thematicBreak', ...span }
    case 'quote': {
      let alert: AlertKind | undefined
      const first = n.children[0]
      if (top && first && first.type === 'paragraph') {
        const m = ALERT.exec(first.lines[0]!.trim())
        if (m) {
          alert = m[1]!.toLowerCase() as AlertKind
          first.lines.shift()
          first.startLine++
          if (!first.lines.length) n.children.shift()
        }
      }
      const q: Block = { type: 'quote', ...span, children: convertAll(n.children, ctx, false) }
      if (alert) q.alert = alert
      return q
    }
    case 'list': {
      const d = n.list!
      const items: ListItem[] = n.children.map((it) => {
        const ispan = spanOf(it)
        let task: 'checked' | 'unchecked' | undefined
        const first = it.children[0]
        if (first && first.type === 'paragraph') {
          const m = TASK.exec(first.lines[0]!)
          if (m) {
            task = m[1] === ' ' ? 'unchecked' : 'checked'
            first.lines[0] = first.lines[0]!.slice(m[0].length)
            if (first.lines.length === 1 && !first.lines[0]) it.children.shift()
          }
        }
        const item: ListItem = { ...ispan, children: convertAll(it.children, ctx, false) }
        if (task) item.task = task
        return item
      })
      return { type: 'list', ...span, ordered: d.ordered, start: d.start, marker: d.marker, tight: d.tight, items }
    }
    case 'code': {
      const info = n.info
      return {
        type: 'code',
        ...span,
        fenced: n.fenced,
        lang: info.split(/\s+/)[0] ?? '',
        text: n.lines.join('\n'),
        closed: n.fenced ? n.closed : true,
      }
    }
    case 'table': {
      const w = n.align.length
      const cells = (line: string): Inline[][] => {
        const raw = splitRow(line)
        const out: Inline[][] = []
        for (let i = 0; i < w; i++) out.push(inl(ctx, raw[i] ?? ''))
        return out
      }
      return {
        type: 'table',
        ...span,
        align: n.align,
        header: cells(n.lines[0] ?? ''),
        rows: n.lines.slice(1).map(cells),
      }
    }
    case 'html': {
      const raw = n.lines.join('\n')
      const t = raw.trim()
      if (/^<hr\s*\/?>$/i.test(t)) return { type: 'thematicBreak', ...span }
      if (n.htmlType === 1 && /^<pre[\s>]/i.test(t)) {
        const inner = t.replace(/^<pre[^>]*>\n?/i, '').replace(/<\/pre>[\s\S]*$/i, '')
        return {
          type: 'code',
          ...span,
          fenced: false,
          lang: '',
          text: inner.replace(/<[^>]*>/g, '').replace(/\n$/, ''),
          closed: true,
        }
      }
      const hidden = n.htmlType === 2 || (n.htmlType === 1 && /^<(?:script|style)/i.test(t))
      return { type: 'html', ...span, comment: hidden, raw, inlines: hidden ? [] : htmlFlow(inl(ctx, raw)) }
    }
    default:
      return null // footnoteDef (collected separately), document
  }
}

function uniqueSlug(ctx: Ctx, base: string): string {
  const seen = ctx.slugs.get(base)
  if (seen === undefined) {
    ctx.slugs.set(base, 0)
    return base
  }
  let k = seen + 1
  while (ctx.slugs.has(`${base}-${k}`)) k++
  ctx.slugs.set(base, k)
  ctx.slugs.set(`${base}-${k}`, 0)
  return `${base}-${k}`
}

// ---- <details> grouping (B19) ----

const DETAILS_OPEN = /<details(?:\s[^>]*)?>/gi
const DETAILS_CLOSE = /<\/details\s*>/gi
const SUMMARY = /<summary(?:\s[^>]*)?>([\s\S]*?)<\/summary\s*>/i

function count(re: RegExp, s: string): number {
  re.lastIndex = 0
  let n = 0
  while (re.exec(s)) n++
  return n
}

function groupDetails(blocks: Block[], ctx: Ctx): Block[] {
  if (!blocks.some((b) => b.type === 'html' && /^\s*<details[\s>]/i.test(b.raw))) return blocks
  const out: Block[] = []
  let i = 0
  while (i < blocks.length) {
    const b = blocks[i]!
    if (b.type !== 'html' || !/^\s*<details[\s>]/i.test(b.raw)) {
      out.push(b)
      i++
      continue
    }
    const raw = b.raw
    const sm = SUMMARY.exec(raw)
    const summary = sm ? inl(ctx, sm[1]!.trim()) : [{ type: 'text', text: 'Details' } as Inline]
    let body = raw.replace(SUMMARY, '').replace(/^\s*<details(?:\s[^>]*)?>/i, '')
    const selfClosed = count(DETAILS_CLOSE, raw) >= count(DETAILS_OPEN, raw)
    if (selfClosed) body = body.replace(/<\/details\s*>[\s\S]*$/i, '')
    const children: Block[] = []
    if (body.trim())
      children.push({ type: 'paragraph', startLine: b.startLine, endLine: b.endLine, inlines: inl(ctx, body.trim()) })
    let endLine = b.endLine
    i++
    if (!selfClosed) {
      let depth = count(DETAILS_OPEN, raw) - count(DETAILS_CLOSE, raw)
      const inner: Block[] = []
      while (i < blocks.length) {
        const c = blocks[i]!
        if (c.type === 'html') {
          depth += count(DETAILS_OPEN, c.raw) - count(DETAILS_CLOSE, c.raw)
          if (depth <= 0) {
            endLine = c.endLine
            const before = c.raw.replace(/<\/details\s*>[\s\S]*$/i, '').trim()
            if (before) inner.push({ ...c, raw: before, inlines: inl(ctx, before) })
            i++
            break
          }
        }
        inner.push(c)
        endLine = c.endLine
        i++
      }
      children.push(...groupDetails(inner, ctx))
    }
    out.push({ type: 'details', startLine: b.startLine, endLine, summary, children })
  }
  return out
}

// ---- entry ----

export type BlocksResult = {
  blocks: Block[]
  refs: Map<string, LinkRef>
  footnotes: FootnoteDef[]
  lineCount: number
}

/**
 * Parses normalized-or-raw markdown into the final block AST (inlines parsed).
 * Front matter (B17) is recognized at line 1.
 */
export function parseBlocks(text: string): BlocksResult {
  const src = normalize(text)
  const lines = src.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  if (lines.length === 1 && lines[0] === '') lines.pop()

  const blocks: Block[] = []
  let first = 0
  const fm = lines[0]
  if ((fm === '---' || fm === '+++') && /\S/.test(lines[1] ?? '')) {
    for (let j = 1; j < lines.length; j++) {
      const l = lines[j]!
      if (l === fm || (fm === '---' && l === '...')) {
        blocks.push({
          type: 'frontMatter',
          startLine: 1,
          endLine: j + 1,
          format: fm === '---' ? 'yaml' : 'toml',
          text: lines.slice(1, j).join('\n'),
        })
        first = j + 1
        break
      }
    }
  }

  const parser = new BlockParser(first + 1)
  const doc = parser.run(first ? lines.slice(first) : lines)

  const numbers = new Map<string, number>()
  const order: string[] = []
  const ctx: Ctx = {
    refs: parser.refs,
    slugs: new Map(),
    footnote: (label) => {
      if (!parser.footnoteDefs.has(label)) return undefined
      let n = numbers.get(label)
      if (n === undefined) {
        n = order.length + 1
        numbers.set(label, n)
        order.push(label)
      }
      return n
    },
  }
  blocks.push(...convertAll(doc.children, ctx, true))

  const footnotes: FootnoteDef[] = []
  for (let k = 0; k < order.length; k++) {
    const label = order[k]!
    const def = parser.footnoteDefs.get(label)!
    footnotes.push({
      type: 'footnoteDef',
      ...spanOf(def),
      label: def.label,
      n: k + 1,
      children: convertAll(def.children, ctx, false),
    })
  }
  return { blocks, refs: parser.refs, footnotes, lineCount: lines.length }
}
