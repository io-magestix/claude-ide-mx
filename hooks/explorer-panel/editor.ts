import type { ClientKeyEvent } from 'claude-code'

// Pure text buffer for the Edit section: multi-cursor ops, undo, keymap.
// Every op is `(buffer, ...) => Buffer` and returns a new buffer; `lines` is
// never mutated in place, and ops copy only the array of line references.

export type Pos = { line: number; col: number }
// `goal` is the sticky column of vertical moves; any other op drops it.
export type Cursor = { anchor: Pos; head: Pos; goal?: number }
// Replace `old.length` lines at `at` with `neu` (the inverse swaps the two).
export type LineEdit = { at: number; old: string[]; neu: string[] }
export type Step = {
  edits: LineEdit[]
  before: Cursor[]
  after: Cursor[]
  group?: 'type'
}
export type Buffer = {
  lines: string[]
  // Sorted, non-overlapping; the last one is the primary cursor.
  cursors: Cursor[]
  undo: Step[]
  redo: Step[]
  clip?: string
  eol: '\n' | '\r\n'
}

export const UNDO_CAP = 200

// ---------------------------------------------------------------- positions

const cmp = (a: Pos, b: Pos): number =>
  a.line !== b.line ? a.line - b.line : a.col - b.col
const same = (a: Pos, b: Pos): boolean => a.line === b.line && a.col === b.col
const isEmpty = (c: Cursor): boolean => same(c.anchor, c.head)
export const startOf = (c: Cursor): Pos => (cmp(c.anchor, c.head) <= 0 ? c.anchor : c.head)
export const endOf = (c: Cursor): Pos => (cmp(c.anchor, c.head) <= 0 ? c.head : c.anchor)
const caret = (p: Pos): Cursor => ({ anchor: p, head: p })

const clampPos = (lines: string[], p: Pos): Pos => {
  const line = Math.min(Math.max(0, p.line), lines.length - 1)

  return { line, col: Math.min(Math.max(0, p.col), lines[line]!.length) }
}

const sameCursors = (a: Cursor[], b: Cursor[]): boolean =>
  a.length === b.length &&
  a.every((c, i) => same(c.anchor, b[i]!.anchor) && same(c.head, b[i]!.head))

// Clamp, sort and merge overlapping cursors (touching ones merge only when
// one of them is empty).
const normCursors = (cursors: Cursor[], lines: string[]): Cursor[] => {
  const sorted = cursors
    .map((c) => ({
      ...c,
      anchor: clampPos(lines, c.anchor),
      head: clampPos(lines, c.head),
    }))
    .sort((a, b) => cmp(startOf(a), startOf(b)) || cmp(endOf(a), endOf(b)))
  const out: Cursor[] = []
  for (const c of sorted) {
    const prev = out[out.length - 1]
    if (prev) {
      const d = cmp(startOf(c), endOf(prev))
      if (d < 0 || (d === 0 && (isEmpty(c) || isEmpty(prev)))) {
        const lo = cmp(startOf(prev), startOf(c)) <= 0 ? startOf(prev) : startOf(c)
        const hi = cmp(endOf(prev), endOf(c)) >= 0 ? endOf(prev) : endOf(c)
        out[out.length - 1]! =
          cmp(c.anchor, c.head) <= 0
            ? { anchor: lo, head: hi }
            : { anchor: hi, head: lo }
        continue
      }
    }
    out.push(c)
  }

  return out
}

export const normalize = (buffer: Buffer): Buffer => ({
  ...buffer,
  cursors: normCursors(buffer.cursors, buffer.lines),
})

// ------------------------------------------------------------- text <-> buffer

export const fromText = (text: string): Buffer => {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'

  return {
    lines: text.split(/\r?\n/),
    cursors: [caret({ line: 0, col: 0 })],
    undo: [],
    redo: [],
    eol,
  }
}

// A trailing newline is a final empty line, so joining restores it.
export const toText = (buffer: Buffer): string => buffer.lines.join(buffer.eol)

// Compares without building the text; either line ending counts as equal.
export const isDirty = (buffer: Buffer, original: string): boolean => {
  const { lines } = buffer
  let pos = 0
  for (let i = 0; i < lines.length; i++) {
    if (!original.startsWith(lines[i]!, pos)) return true
    pos += lines[i]!.length
    if (i < lines.length - 1) {
      if (original[pos]! === '\r' && original[pos + 1]! === '\n') pos += 2
      else if (original[pos]! === '\n') pos += 1
      else return true
    }
  }

  return pos !== original.length
}

export const textOf = (buffer: Buffer, from: Pos, to: Pos): string => {
  const { lines } = buffer
  if (from.line === to.line) return lines[from.line]!.slice(from.col, to.col)
  const mid = lines.slice(from.line + 1, to.line)

  return [
    lines[from.line]!.slice(from.col),
    ...mid,
    lines[to.line]!.slice(0, to.col),
  ].join('\n')
}

// ----------------------------------------------------------- low-level edits

// Splice in place without spreading a huge array into the call.
const spliceLines = (
  lines: string[],
  at: number,
  del: number,
  ins: string[],
): void => {
  if (ins.length <= 5000) {
    lines.splice(at, del, ...ins)

    return
  }
  lines.splice(at, del)
  for (let i = 0; i < ins.length; i += 5000)
    lines.splice(at + i, 0, ...ins.slice(i, i + 5000))
}

const pushStep = (undo: Step[], step: Step): Step[] => {
  const top = undo[undo.length - 1]
  if (
    step.group &&
    top &&
    top.group === step.group &&
    sameCursors(top.after, step.before) &&
    top.edits.length === step.edits.length &&
    top.edits.every(
      (e, i) =>
        e.at === step.edits[i]!.at &&
        e.old.length === 1 &&
        e.neu.length === 1 &&
        step.edits[i]!.old.length === 1,
    )
  ) {
    const merged: Step = {
      group: step.group,
      before: top.before,
      after: step.after,
      edits: top.edits.map((e, i) => ({
        at: e.at,
        old: e.old,
        neu: step.edits[i]!.neu,
      })),
    }

    return [...undo.slice(0, -1), merged]
  }
  const next = [...undo, step]
  if (next.length > UNDO_CAP) next.splice(0, next.length - UNDO_CAP)

  return next
}

// Apply line-range edits (ascending, disjoint, original coordinates) from the
// last to the first, so earlier coordinates stay valid, and record a step.
const commitLines = (
  buffer: Buffer,
  ops: { at: number; del: number; ins: string[] }[],
  cursors: Cursor[],
  group?: 'type',
): Buffer => {
  const lines = buffer.lines.slice()
  const edits: LineEdit[] = []
  for (let i = ops.length - 1; i >= 0; i--) {
    const { at, del, ins } = ops[i]!
    edits.push({ at, old: lines.slice(at, at + del), neu: ins })
    spliceLines(lines, at, del, ins)
  }
  const after = normCursors(cursors, lines)

  return {
    ...buffer,
    lines,
    cursors: after,
    redo: [],
    undo: pushStep(buffer.undo, { edits, before: buffer.cursors, after, group }),
  }
}

type Rep = { from: Pos; to: Pos; text: string; col?: number }

// Replace per-cursor ranges (ascending). Each cursor ends as a caret after its
// inserted text (or at `col` on that line when given).
const replaceRanges = (
  buffer: Buffer,
  input: Rep[],
  group?: 'type',
): Buffer => {
  // Clip overlaps (e.g. two word-deletes reaching over each other).
  const reps: Rep[] = []
  let prevTo: Pos = { line: 0, col: 0 }
  for (const r of input) {
    const from = cmp(r.from, prevTo) < 0 ? prevTo : r.from
    const to = cmp(r.to, from) < 0 ? from : r.to
    reps.push({ ...r, from, to })
    prevTo = to
  }
  if (reps.every((r) => same(r.from, r.to) && r.text === '')) return buffer

  const lines = buffer.lines.slice()
  const edits: LineEdit[] = []
  const parts = reps.map((r) => r.text.split('\n'))
  for (let i = reps.length - 1; i >= 0; i--) {
    const { from, to, text } = reps[i]!
    if (same(from, to) && text === '') continue
    const neu = parts[i]!.slice()
    const head = lines[from.line]!.slice(0, from.col)
    const tail = lines[to.line]!.slice(to.col)
    neu[0] = head + neu[0]!
    neu[neu.length - 1] += tail
    const del = to.line - from.line + 1
    edits.push({ at: from.line, old: lines.slice(from.line, from.line + del), neu })
    spliceLines(lines, from.line, del, neu)
  }

  // Forward pass: map each original position into the final document.
  let prevOrig: Pos = { line: 0, col: 0 }
  let prevNew: Pos = { line: 0, col: 0 }
  const map = (p: Pos): Pos =>
    p.line === prevOrig.line
      ? { line: prevNew.line, col: prevNew.col + p.col - prevOrig.col }
      : { line: p.line + prevNew.line - prevOrig.line, col: p.col }
  const cursors: Cursor[] = reps.map((r, i) => {
    const nf = map(r.from)
    const p = parts[i]!
    const end: Pos =
      p.length === 1
        ? { line: nf.line, col: nf.col + p[0]!.length }
        : { line: nf.line + p.length - 1, col: p[p.length - 1]!.length }
    prevOrig = r.to
    prevNew = end

    return caret(r.col === undefined ? end : { line: end.line, col: r.col })
  })
  const after = normCursors(cursors, lines)

  return {
    ...buffer,
    lines,
    cursors: after,
    redo: [],
    undo: pushStep(buffer.undo, { edits, before: buffer.cursors, after, group }),
  }
}

// ------------------------------------------------------------------ history

export const undo = (buffer: Buffer): Buffer => {
  const step = buffer.undo[buffer.undo.length - 1]
  if (!step) return buffer
  const lines = buffer.lines.slice()
  for (let i = step.edits.length - 1; i >= 0; i--) {
    const e = step.edits[i]!
    spliceLines(lines, e.at, e.neu.length, e.old)
  }

  return {
    ...buffer,
    lines,
    cursors: normCursors(step.before, lines),
    undo: buffer.undo.slice(0, -1),
    redo: [...buffer.redo, step],
  }
}

export const redo = (buffer: Buffer): Buffer => {
  const step = buffer.redo[buffer.redo.length - 1]
  if (!step) return buffer
  const lines = buffer.lines.slice()
  for (const e of step.edits) spliceLines(lines, e.at, e.old.length, e.neu)
  const undoStack = [...buffer.undo, step]
  if (undoStack.length > UNDO_CAP) undoStack.shift()

  return {
    ...buffer,
    lines,
    cursors: normCursors(step.after, lines),
    undo: undoStack,
    redo: buffer.redo.slice(0, -1),
  }
}

// ------------------------------------------------------------------- words

const isWordChar = (ch: string): boolean => /[\p{L}\p{N}_]/u.test(ch)
const klass = (ch: string): 'w' | 's' | 'p' =>
  isWordChar(ch) ? 'w' : /\s/.test(ch) ? 's' : 'p'

const charLeft = (lines: string[], p: Pos): Pos => {
  if (p.col === 0)
    return p.line > 0 ? { line: p.line - 1, col: lines[p.line - 1]!.length } : p
  const line = lines[p.line]!
  const pair =
    p.col > 1 &&
    /[\uDC00-\uDFFF]/.test(line[p.col - 1]!) &&
    /[\uD800-\uDBFF]/.test(line[p.col - 2]!)

  return { line: p.line, col: p.col - (pair ? 2 : 1) }
}

const charRight = (lines: string[], p: Pos): Pos => {
  const line = lines[p.line]!
  if (p.col >= line.length)
    return p.line < lines.length - 1 ? { line: p.line + 1, col: 0 } : p
  const pair =
    /[\uD800-\uDBFF]/.test(line[p.col]!) &&
    p.col + 1 < line.length &&
    /[\uDC00-\uDFFF]/.test(line[p.col + 1]!)

  return { line: p.line, col: p.col + (pair ? 2 : 1) }
}

// Start of the next word.
const wordRight = (lines: string[], p: Pos): Pos => {
  const line = lines[p.line]!
  if (p.col >= line.length)
    return p.line < lines.length - 1 ? { line: p.line + 1, col: 0 } : p
  let c = p.col
  const k = klass(line[c]!)
  if (k !== 's') while (c < line.length && klass(line[c]!) === k) c++
  while (c < line.length && klass(line[c]!) === 's') c++

  return { line: p.line, col: c }
}

const wordLeft = (lines: string[], p: Pos): Pos => {
  if (p.col === 0)
    return p.line > 0 ? { line: p.line - 1, col: lines[p.line - 1]!.length } : p
  const line = lines[p.line]!
  let c = p.col
  while (c > 0 && klass(line[c - 1]!) === 's') c--
  if (c > 0) {
    const k = klass(line[c - 1]!)
    while (c > 0 && klass(line[c - 1]!) === k) c--
  }

  return { line: p.line, col: c }
}

const wordAt = (line: string, col: number): [number, number] | undefined => {
  let s = col
  let e = col
  while (s > 0 && isWordChar(line[s - 1]!)) s--
  while (e < line.length && isWordChar(line[e]!)) e++

  return s === e ? undefined : [s, e]
}

// ----------------------------------------------------------------- movement

export type Dir = 'left' | 'right' | 'up' | 'down'
export type MoveOpts = { select?: boolean; word?: boolean }

const withCursors = (buffer: Buffer, cursors: Cursor[]): Buffer => ({
  ...buffer,
  cursors: normCursors(cursors, buffer.lines),
})

const headTo = (c: Cursor, head: Pos, select?: boolean, goal?: number): Cursor => {
  const out: Cursor = { anchor: select ? c.anchor : head, head }
  if (goal !== undefined) out.goal = goal

  return out
}

export const move = (
  buffer: Buffer,
  dir: Dir,
  { select, word }: MoveOpts = {},
): Buffer => {
  const { lines } = buffer

  return withCursors(
    buffer,
    buffer.cursors.map((c) => {
      if ((dir === 'left' || dir === 'right') && !select && !word && !isEmpty(c))
        return caret(dir === 'left' ? startOf(c) : endOf(c))
      if (dir === 'left')
        return headTo(c, word ? wordLeft(lines, c.head) : charLeft(lines, c.head), select)
      if (dir === 'right')
        return headTo(c, word ? wordRight(lines, c.head) : charRight(lines, c.head), select)
      const goal = c.goal ?? c.head.col
      if (dir === 'up') {
        const to: Pos =
          c.head.line > 0
            ? { line: c.head.line - 1, col: Math.min(goal, lines[c.head.line - 1]!.length) }
            : { line: 0, col: 0 }

        return headTo(c, to, select, goal)
      }
      const last = lines.length - 1
      const to: Pos =
        c.head.line < last
          ? { line: c.head.line + 1, col: Math.min(goal, lines[c.head.line + 1]!.length) }
          : { line: last, col: lines[last]!.length }

      return headTo(c, to, select, goal)
    }),
  )
}

const indentEnd = (line: string): number => line.length - line.trimStart().length

// Smart home: first non-blank column, then column 0.
export const home = (buffer: Buffer, { select }: { select?: boolean } = {}): Buffer =>
  withCursors(
    buffer,
    buffer.cursors.map((c) => {
      const ie = indentEnd(buffer.lines[c.head.line]!)

      return headTo(c, { line: c.head.line, col: c.head.col !== ie ? ie : 0 }, select)
    }),
  )

export const end = (buffer: Buffer, { select }: { select?: boolean } = {}): Buffer =>
  withCursors(
    buffer,
    buffer.cursors.map((c) =>
      headTo(c, { line: c.head.line, col: buffer.lines[c.head.line]!.length }, select),
    ),
  )

// Signed `rows`; keeps the sticky column.
export const page = (
  buffer: Buffer,
  rows: number,
  { select }: { select?: boolean } = {},
): Buffer => {
  const { lines } = buffer

  return withCursors(
    buffer,
    buffer.cursors.map((c) => {
      const goal = c.goal ?? c.head.col
      const line = Math.min(Math.max(0, c.head.line + rows), lines.length - 1)

      return headTo(c, { line, col: Math.min(goal, lines[line]!.length) }, select, goal)
    }),
  )
}

export const docStart = (buffer: Buffer, { select }: { select?: boolean } = {}): Buffer =>
  withCursors(
    buffer,
    buffer.cursors.map((c) => headTo(c, { line: 0, col: 0 }, select)),
  )

export const docEnd = (buffer: Buffer, { select }: { select?: boolean } = {}): Buffer => {
  const last = buffer.lines.length - 1

  return withCursors(
    buffer,
    buffer.cursors.map((c) =>
      headTo(c, { line: last, col: buffer.lines[last]!.length }, select),
    ),
  )
}

// -------------------------------------------------------- selection / cursors

export const selectAll = (buffer: Buffer): Buffer => {
  const last = buffer.lines.length - 1

  return {
    ...buffer,
    cursors: [
      {
        anchor: { line: 0, col: 0 },
        head: { line: last, col: buffer.lines[last]!.length },
      },
    ],
  }
}

// Plain click: one collapsed cursor.
export const setCursor = (buffer: Buffer, pos: Pos): Buffer => ({
  ...buffer,
  cursors: [caret(clampPos(buffer.lines, pos))],
})

// Index of the cursor whose head is at `pos` (after addCursor, for a drag).
export const cursorAt = (buffer: Buffer, pos: Pos): number =>
  buffer.cursors.findIndex((c) => same(c.head, pos))

// Drag / shift+click: move one cursor's head, default the primary (last).
export const extendTo = (buffer: Buffer, pos: Pos, index?: number): Buffer => {
  const i = index ?? buffer.cursors.length - 1
  const to = clampPos(buffer.lines, pos)

  return withCursors(
    buffer,
    buffer.cursors.map((c, k) => (k === i ? { anchor: c.anchor, head: to } : c)),
  )
}

// Ctrl/Alt+click: add a cursor, or drop one already there (never the last).
export const addCursor = (buffer: Buffer, pos: Pos): Buffer => {
  const p = clampPos(buffer.lines, pos)
  const at = buffer.cursors.findIndex((c) => same(c.head, p) && isEmpty(c))
  if (at >= 0)
    return buffer.cursors.length > 1
      ? { ...buffer, cursors: buffer.cursors.filter((_, i) => i !== at) }
      : buffer

  return withCursors(buffer, [...buffer.cursors, caret(p)])
}

// Column select: a cursor above the first / below the last one.
export const addCursorVertical = (buffer: Buffer, dir: 1 | -1): Buffer => {
  const ref = dir < 0 ? buffer.cursors[0]! : buffer.cursors[buffer.cursors.length - 1]!
  const line = ref.head.line + dir
  if (line < 0 || line >= buffer.lines.length) return buffer
  const goal = ref.goal ?? ref.head.col
  const p = { line, col: Math.min(goal, buffer.lines[line]!.length) }

  return withCursors(buffer, [...buffer.cursors, { ...caret(p), goal }])
}

// Empty selections take the word under the cursor; otherwise the next
// occurrence of the primary selection (single-line, wraps) gets a cursor.
export const addNextOccurrence = (buffer: Buffer): Buffer => {
  const { lines, cursors } = buffer
  const primary = cursors[cursors.length - 1]!
  if (isEmpty(primary)) {
    return withCursors(
      buffer,
      cursors.map((c) => {
        if (!isEmpty(c)) return c
        const w = wordAt(lines[c.head.line]!, c.head.col)

        return w
          ? { anchor: { line: c.head.line, col: w[0]! }, head: { line: c.head.line, col: w[1]! } }
          : c
      }),
    )
  }
  const s = startOf(primary)
  const e = endOf(primary)
  if (s.line !== e.line) return buffer
  const needle = lines[s.line]!.slice(s.col, e.col)
  const taken = new Set(cursors.map((c) => `${startOf(c).line}:${startOf(c).col}`))
  const n = lines.length
  for (let step = 0; step <= n; step++) {
    const line = (e.line + step) % n
    let from = step === 0 ? e.col : 0
    for (;;) {
      const at = lines[line]!.indexOf(needle, from)
      if (at < 0) break
      if (!taken.has(`${line}:${at}`))
        return withCursors(buffer, [
          ...cursors,
          { anchor: { line, col: at }, head: { line, col: at + needle.length } },
        ])
      from = at + 1
    }
  }

  return buffer
}

// word -> line -> whole document.
export const extendSelection = (buffer: Buffer): Buffer => {
  const { lines } = buffer
  const out: Cursor[] = []
  let all = false
  for (const c of buffer.cursors) {
    const s = startOf(c)
    const e = endOf(c)
    const len = lines[s.line]!.length
    const wholeLine = s.line === e.line && s.col === 0 && e.col === len
    if (isEmpty(c)) {
      const w = wordAt(lines[s.line]!, s.col)
      out.push(
        w
          ? { anchor: { line: s.line, col: w[0]! }, head: { line: s.line, col: w[1]! } }
          : { anchor: { line: s.line, col: 0 }, head: { line: s.line, col: len } },
      )
    } else if (s.line === e.line && !wholeLine) {
      out.push({ anchor: { line: s.line, col: 0 }, head: { line: s.line, col: len } })
    } else all = true
  }

  return all ? selectAll(buffer) : withCursors(buffer, out)
}

// ------------------------------------------------------------------ editing

const norm = (text: string): string => text.replace(/\r\n?/g, '\n')

export const insert = (buffer: Buffer, text: string): Buffer => {
  const t = norm(text)
  const group =
    [...t].length === 1 && t !== '\n' && buffer.cursors.every(isEmpty)
      ? ('type' as const)
      : undefined

  return replaceRanges(
    buffer,
    buffer.cursors.map((c) => ({ from: startOf(c), to: endOf(c), text: t })),
    group,
  )
}

// Keeps the indent of the line (the part left of the cursor).
export const newline = (buffer: Buffer): Buffer =>
  replaceRanges(
    buffer,
    buffer.cursors.map((c) => {
      const s = startOf(c)
      const line = buffer.lines[s.line]!
      const ws = line.slice(0, Math.min(s.col, indentEnd(line)))

      return { from: s, to: endOf(c), text: `\n${ws}` }
    }),
  )

export const backspace = (buffer: Buffer): Buffer =>
  replaceRanges(
    buffer,
    buffer.cursors.map((c) => ({
      from: isEmpty(c) ? charLeft(buffer.lines, c.head) : startOf(c),
      to: endOf(c),
      text: '',
    })),
  )

export const del = (buffer: Buffer): Buffer =>
  replaceRanges(
    buffer,
    buffer.cursors.map((c) => ({
      from: startOf(c),
      to: isEmpty(c) ? charRight(buffer.lines, c.head) : endOf(c),
      text: '',
    })),
  )

export const deleteWordBack = (buffer: Buffer): Buffer =>
  replaceRanges(
    buffer,
    buffer.cursors.map((c) => ({
      from: isEmpty(c) ? wordLeft(buffer.lines, c.head) : startOf(c),
      to: endOf(c),
      text: '',
    })),
  )

// -------------------------------------------------------------------- lines

// The lines each cursor works on: a selection ending at column 0 of a later
// line does not take that line. Blocks merge when they overlap (or touch).
const lineSpanOf = (c: Cursor): [number, number] => {
  const s = startOf(c)
  const e = endOf(c)

  return [s.line, e.col === 0 && e.line > s.line ? e.line - 1 : e.line]
}

const blocksOf = (buffer: Buffer, touching: boolean): [number, number][] => {
  const out: [number, number][] = []
  for (const c of buffer.cursors) {
    const [a, b] = lineSpanOf(c)
    const prev = out[out.length - 1]
    if (prev && a <= prev[1]! + (touching ? 1 : 0)) prev[1] = Math.max(prev[1]!, b)
    else out.push([a, b])
  }

  return out
}

const blockIndex = (blocks: [number, number][], c: Cursor): number => {
  const a = startOf(c).line

  return blocks.findIndex(([x, y]) => a >= x && a <= y)
}

const shiftCursors = (
  buffer: Buffer,
  blocks: [number, number][],
  shift: (block: number) => number,
): Cursor[] =>
  buffer.cursors.map((c) => {
    const d = shift(blockIndex(blocks, c))
    const mv = (p: Pos): Pos => ({ line: p.line + d, col: p.col })

    return { anchor: mv(c.anchor), head: mv(c.head), goal: c.goal }
  })

export const moveLines = (buffer: Buffer, dir: 1 | -1): Buffer => {
  const blocks = blocksOf(buffer, true)
  const n = buffer.lines.length
  const ops: { at: number; del: number; ins: string[] }[] = []
  const moves = blocks.map(([a, b]) => {
    if (dir < 0 && a > 0) {
      ops.push({
        at: a - 1,
        del: b - a + 2,
        ins: [...buffer.lines.slice(a, b + 1), buffer.lines[a - 1]!],
      })

      return -1
    }
    if (dir > 0 && b < n - 1) {
      ops.push({
        at: a,
        del: b - a + 2,
        ins: [buffer.lines[b + 1]!, ...buffer.lines.slice(a, b + 1)],
      })

      return 1
    }

    return 0
  })
  if (!ops.length) return buffer

  return commitLines(buffer, ops, shiftCursors(buffer, blocks, (i) => moves[i]!))
}

// The copy takes the cursors: `dir` 1 puts it below, -1 above.
export const duplicateLines = (buffer: Buffer, dir: 1 | -1 = 1): Buffer => {
  const blocks = blocksOf(buffer, false)
  const before: number[] = []
  let total = 0
  const ops = blocks.map(([a, b]) => {
    before.push(total)
    total += b - a + 1

    return { at: dir > 0 ? b + 1 : a, del: 0, ins: buffer.lines.slice(a, b + 1) }
  })

  return commitLines(
    buffer,
    ops,
    shiftCursors(buffer, blocks, (i) => {
      const [a, b] = blocks[i]!

      return before[i]! + (dir > 0 ? b - a + 1 : 0)
    }),
  )
}

export const deleteLines = (buffer: Buffer): Buffer => {
  const blocks = blocksOf(buffer, true)
  const n = buffer.lines.length
  if (blocks.length === 1 && blocks[0]![0] === 0 && blocks[0]![1] === n - 1)
    return commitLines(buffer, [{ at: 0, del: n, ins: [''] }], [caret({ line: 0, col: 0 })])
  const removed: number[] = []
  let total = 0
  for (const [a, b] of blocks) {
    removed.push(total)
    total += b - a + 1
  }
  const ops = blocks.map(([a, b]) => ({ at: a, del: b - a + 1, ins: [] as string[] }))
  const left = n - total
  // A cursor lands on the line that takes the block's place, same column.
  const cursors = buffer.cursors.map((c) => {
    const i = blockIndex(blocks, c)
    const line = Math.min(blocks[i]![0] - removed[i]!, left - 1)

    return caret({ line, col: c.head.col })
  })

  return commitLines(buffer, ops, cursors)
}

type ColChange = { col: number; d: number }

// Rewrite whole lines, then move cursor columns by `changes` (insert at col
// when d > 0, remove -d chars at col when d < 0).
const rewriteLines = (
  buffer: Buffer,
  blocks: [number, number][],
  edit: (line: string, index: number) => { text: string; change?: ColChange },
): Buffer => {
  const changes = new Map<number, ColChange>()
  const ops = blocks.map(([a, b]) => ({
    at: a,
    del: b - a + 1,
    ins: buffer.lines.slice(a, b + 1).map((line, k) => {
      const r = edit(line, a + k)
      if (r.change) changes.set(a + k, r.change)

      return r.text
    }),
  }))
  if (!changes.size) return buffer
  const adj = (p: Pos): Pos => {
    const ch = changes.get(p.line)
    if (!ch) return p
    if (ch.d > 0) return p.col >= ch.col ? { line: p.line, col: p.col + ch.d } : p

    return p.col > ch.col ? { line: p.line, col: Math.max(ch.col, p.col + ch.d) } : p
  }

  return commitLines(
    buffer,
    ops,
    buffer.cursors.map((c) => ({ anchor: adj(c.anchor), head: adj(c.head) })),
  )
}

// With every cursor empty this types one indent at each cursor (Tab); with a
// selection it indents the selected lines.
export const indent = (buffer: Buffer, unit = '  '): Buffer => {
  if (buffer.cursors.every(isEmpty)) return insert(buffer, unit)

  return rewriteLines(buffer, blocksOf(buffer, false), (line) =>
    line === ''
      ? { text: line }
      : { text: unit + line, change: { col: 0, d: unit.length } },
  )
}

export const outdent = (buffer: Buffer, unit = '  '): Buffer =>
  rewriteLines(buffer, blocksOf(buffer, false), (line) => {
    let n = 0
    if (line.startsWith('\t')) n = 1
    else while (n < unit.length && line[n]! === ' ') n++
    if (!n) return { text: line }

    return { text: line.slice(n), change: { col: 0, d: -n } }
  })

// `prefix` from `commentOf(language)`; none means nothing to toggle.
export const toggleComment = (buffer: Buffer, prefix: string | undefined): Buffer => {
  if (!prefix) return buffer
  const blocks = blocksOf(buffer, false)
  const filled: string[] = []
  for (const [a, b] of blocks)
    for (let i = a; i <= b; i++) if (buffer.lines[i]!.trim() !== '') filled.push(buffer.lines[i]!)
  if (!filled.length) return buffer
  const uncomment = filled.every((l) => l.trimStart().startsWith(prefix))
  if (uncomment)
    return rewriteLines(buffer, blocks, (line) => {
      if (line.trim() === '') return { text: line }
      const ie = indentEnd(line)
      const len = prefix.length + (line[ie + prefix.length]! === ' ' ? 1 : 0)

      return {
        text: line.slice(0, ie) + line.slice(ie + len),
        change: { col: ie, d: -len },
      }
    })
  // Comment at the smallest indent of each block.
  const minIndent = new Map<number, number>()
  blocks.forEach(([a, b], i) => {
    let m = Infinity
    for (let k = a; k <= b; k++)
      if (buffer.lines[k]!.trim() !== '') m = Math.min(m, indentEnd(buffer.lines[k]!))
    minIndent.set(i, m)
  })

  return rewriteLines(buffer, blocks, (line, index) => {
    if (line.trim() === '') return { text: line }
    const m = minIndent.get(blocks.findIndex(([a, b]) => index >= a && index <= b)) ?? 0

    return {
      text: `${line.slice(0, m)}${prefix} ${line.slice(m)}`,
      change: { col: m, d: prefix.length + 1 },
    }
  })
}

// ---------------------------------------------------------------- clipboard

export const copy = (buffer: Buffer): { buffer: Buffer; text: string } => {
  const picked = buffer.cursors.filter((c) => !isEmpty(c))
  const text = picked.length
    ? picked.map((c) => textOf(buffer, startOf(c), endOf(c))).join('\n')
    : blocksOf(buffer, false)
        .map(([a, b]) => `${buffer.lines.slice(a, b + 1).join('\n')}\n`)
        .join('')

  return { buffer: { ...buffer, clip: text }, text }
}

// Selections are cut; with none, whole lines.
export const cut = (buffer: Buffer): { buffer: Buffer; text: string } => {
  const copied = copy(buffer)
  const b = copied.buffer
  const next = b.cursors.every(isEmpty)
    ? deleteLines(b)
    : replaceRanges(
        b,
        b.cursors.map((c) => ({
          from: startOf(c),
          to: endOf(c),
          text: '',
        })),
      )

  return { buffer: { ...next, clip: copied.text }, text: copied.text }
}

// Whole-line text (from copy/cut of lines) goes above the cursor's line; text
// with as many lines as cursors goes one line per cursor.
export const paste = (buffer: Buffer, text: string): Buffer => {
  const t = norm(text)
  if (t === '') return buffer
  if (t === buffer.clip && t.endsWith('\n') && buffer.cursors.every(isEmpty)) {
    const seen = new Set<number>()
    const reps: Rep[] = []
    for (const c of buffer.cursors) {
      if (seen.has(c.head.line)) continue
      seen.add(c.head.line)
      const at = { line: c.head.line, col: 0 }
      reps.push({ from: at, to: at, text: t, col: c.head.col })
    }

    return replaceRanges(buffer, reps)
  }
  const pieces = t.split('\n')
  const split = buffer.cursors.length > 1 && pieces.length === buffer.cursors.length

  return replaceRanges(
    buffer,
    buffer.cursors.map((c, i) => ({
      from: startOf(c),
      to: endOf(c),
      text: split ? pieces[i]! : t,
    })),
  )
}

// ----------------------------------------------------------------- chunking

// Pieces of at most `size` chars, never splitting a surrogate pair.
export const chunks = (text: string, size: number): string[] => {
  const out: string[] = []
  let i = 0
  while (i < text.length) {
    let j = Math.min(text.length, i + size)
    if (j < text.length && /[\uDC00-\uDFFF]/.test(text[j]!)) j--
    out.push(text.slice(i, j))
    i = j
  }

  return out.length ? out : ['']
}

// undefined while any piece is missing.
export const assemble = (parts: (string | undefined)[]): string | undefined =>
  parts.every((p) => p !== undefined) ? (parts as string[]).join('') : undefined

// ------------------------------------------------------------------ comment

const COMMENTS: Record<string, string> = {}
for (const l of [
  'typescript', 'tsx', 'javascript', 'jsx', 'csharp', 'c', 'cpp', 'java',
  'go', 'rust', 'swift', 'kotlin', 'scala', 'dart', 'php', 'glsl', 'hlsl',
  'shaderlab', 'jsonc', 'json5',
])
  COMMENTS[l] = '//'
for (const l of [
  'python', 'bash', 'shell', 'sh', 'zsh', 'yaml', 'toml', 'ruby', 'perl',
  'r', 'makefile', 'dockerfile', 'powershell', 'ini', 'properties',
])
  COMMENTS[l] = '#'
for (const l of ['sql', 'lua', 'haskell', 'ada']) COMMENTS[l] = '--'

// Line-comment prefix of a highlighter language (see `languageOf` in tree.ts).
export const commentOf = (language: string | undefined): string | undefined =>
  language ? COMMENTS[language.toLowerCase()] : undefined

// ------------------------------------------------------------------- keymap

export const ACTIONS = [
  'moveLeft', 'moveRight', 'moveUp', 'moveDown',
  'selectLeft', 'selectRight', 'selectUp', 'selectDown',
  'wordLeft', 'wordRight', 'selectWordLeft', 'selectWordRight',
  'home', 'end', 'selectHome', 'selectEnd',
  'pageUp', 'pageDown', 'selectPageUp', 'selectPageDown',
  'docStart', 'docEnd', 'selectDocStart', 'selectDocEnd',
  'selectAll', 'extendSelection',
  'addNextOccurrence', 'addCursorUp', 'addCursorDown',
  'moveLinesUp', 'moveLinesDown', 'duplicateLines', 'duplicateLinesUp',
  'deleteLines', 'indent', 'outdent', 'toggleComment',
  'newline', 'backspace', 'del', 'deleteWordBack',
  'undo', 'redo', 'copy', 'cut', 'paste', 'save',
] as const
export type Action = (typeof ACTIONS)[number]
export type Keymap = Record<Action, string[]>

const JETBRAINS: Keymap = {
  moveLeft: ['left'],
  moveRight: ['right'],
  moveUp: ['up'],
  moveDown: ['down'],
  selectLeft: ['shift+left'],
  selectRight: ['shift+right'],
  selectUp: ['shift+up'],
  selectDown: ['shift+down'],
  wordLeft: ['ctrl+left'],
  wordRight: ['ctrl+right'],
  selectWordLeft: ['ctrl+shift+left'],
  selectWordRight: ['ctrl+shift+right'],
  home: ['home'],
  end: ['end'],
  selectHome: ['shift+home'],
  selectEnd: ['shift+end'],
  pageUp: ['pageup'],
  pageDown: ['pagedown'],
  selectPageUp: ['shift+pageup'],
  selectPageDown: ['shift+pagedown'],
  docStart: ['ctrl+home'],
  docEnd: ['ctrl+end'],
  selectDocStart: ['ctrl+shift+home'],
  selectDocEnd: ['ctrl+shift+end'],
  selectAll: ['ctrl+a'],
  extendSelection: ['ctrl+w'],
  addNextOccurrence: ['meta+j'],
  addCursorUp: ['meta+shift+up'],
  addCursorDown: ['meta+shift+down'],
  moveLinesUp: ['ctrl+shift+up'],
  moveLinesDown: ['ctrl+shift+down'],
  duplicateLines: ['ctrl+d'],
  duplicateLinesUp: [],
  deleteLines: ['ctrl+y'],
  indent: ['tab'],
  outdent: ['shift+tab'],
  toggleComment: ['ctrl+/'],
  newline: ['return'],
  backspace: ['backspace'],
  del: ['delete'],
  deleteWordBack: ['ctrl+backspace'],
  undo: ['ctrl+z'],
  redo: ['ctrl+shift+z'],
  copy: ['ctrl+c'],
  cut: ['ctrl+x'],
  paste: ['ctrl+v'],
  save: ['ctrl+s'],
}

export const KEYMAPS: Record<'jetbrains' | 'vscode', Keymap> = {
  jetbrains: JETBRAINS,
  vscode: {
    ...JETBRAINS,
    moveLinesUp: ['meta+up'],
    moveLinesDown: ['meta+down'],
    duplicateLinesUp: ['meta+shift+up'],
    duplicateLines: ['meta+shift+down'],
    addNextOccurrence: ['ctrl+d'],
    deleteLines: ['ctrl+shift+k'],
    addCursorUp: ['ctrl+shift+up'],
    addCursorDown: ['ctrl+shift+down'],
    redo: ['ctrl+y', 'ctrl+shift+z'],
    extendSelection: ['meta+shift+right'],
  },
}

export type Chord = {
  key: string
  ctrl: boolean
  meta: boolean
  shift: boolean
}

const KEY_NAMES = new Set([
  'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown',
  'return', 'tab', 'backspace', 'delete', 'insert',
])
const KEY_ALIASES: Record<string, string> = {
  enter: 'return',
  space: ' ',
  pgup: 'pageup',
  pgdn: 'pagedown',
  del: 'delete',
}
const MODS: Record<string, 'ctrl' | 'meta' | 'shift'> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  shift: 'shift',
  meta: 'meta',
  alt: 'meta',
  option: 'meta',
  cmd: 'meta',
}

// `ctrl+shift+up`, `meta+j`, `ctrl+/`, `ctrl++`; `alt` is `meta`.
export const parseChord = (text: string): Chord | undefined => {
  const s = text.trim().toLowerCase()
  let mods: string[]
  let key: string
  if (s === '+') {
    mods = []
    key = '+'
  } else if (s.endsWith('++')) {
    mods = s.slice(0, -2).split('+')
    key = '+'
  } else {
    mods = s.split('+')
    key = mods.pop() ?? ''
  }
  key = KEY_ALIASES[key] ?? key
  if (!(KEY_NAMES.has(key) || [...key].length === 1)) return undefined
  const chord: Chord = { key, ctrl: false, meta: false, shift: false }
  for (const m of mods) {
    const name = MODS[m]
    if (!name) return undefined
    chord[name] = true
  }

  return chord
}

// Canonical spelling: modifiers in the order ctrl, meta, shift.
export const chordText = (c: Chord): string =>
  [c.ctrl && 'ctrl', c.meta && 'meta', c.shift && 'shift', c.key]
    .filter(Boolean)
    .join('+')

const eventChord = (e: ClientKeyEvent): Chord => {
  let key = e.key
  let shift = e.shift === true
  const lower = key.toLowerCase()
  if ([...key].length === 1 && key !== lower && [...lower].length === 1) {
    key = lower
    shift = true
  }
  key = KEY_ALIASES[key] ?? key

  return { key, ctrl: e.ctrl === true, meta: e.meta === true, shift }
}

// Overrides: `{"duplicateLines":"ctrl+shift+d","deleteLines":["ctrl+y"]}`.
// An override replaces that action's chords and frees them from every other
// action; a bad entry is skipped with a message and the rest still apply.
export const mergeKeymap = (
  preset: Keymap,
  overridesJson?: string,
): { keymap: Keymap; errors: string[] } => {
  const keymap = {} as Keymap
  for (const a of ACTIONS) keymap[a] = [...preset[a]!]
  const errors: string[] = []
  if (!overridesJson || overridesJson.trim() === '') return { keymap, errors }
  let parsed: unknown
  try {
    parsed = JSON.parse(overridesJson)
  } catch (err) {
    errors.push(`editorKeys: invalid JSON (${err instanceof Error ? err.message : String(err)})`)

    return { keymap, errors }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    errors.push('editorKeys: expected a JSON object of action to chords')

    return { keymap, errors }
  }
  for (const [name, value] of Object.entries(parsed)) {
    if (!(ACTIONS as readonly string[]).includes(name)) {
      errors.push(`editorKeys: unknown action "${name}"`)
      continue
    }
    const list =
      typeof value === 'string'
        ? [value]
        : Array.isArray(value) && value.every((v) => typeof v === 'string')
          ? (value as string[])
          : undefined
    if (!list) {
      errors.push(`editorKeys: ${name} needs a chord or a list of chords`)
      continue
    }
    const chords: string[] = []
    let bad = false
    for (const text of list) {
      const parsedChord = parseChord(text)
      if (!parsedChord) {
        errors.push(`editorKeys: ${name} has a bad chord "${text}"`)
        bad = true
        break
      }
      chords.push(chordText(parsedChord))
    }
    if (bad) continue
    const taken = new Set(chords)
    for (const a of ACTIONS) keymap[a] = keymap[a]!.filter((c) => !taken.has(c))
    keymap[name as Action] = [...taken]
  }

  return { keymap, errors }
}

export const keyOp = (event: ClientKeyEvent, keymap: Keymap): Action | undefined => {
  const text = chordText(eventChord(event))
  for (const a of ACTIONS) if (keymap[a]?.includes(text)) return a

  return undefined
}

// ----------------------------------------------------------------- dispatch

export type ActionCtx = {
  // From `commentOf(language)`.
  comment?: string
  // Rows a page move covers (the viewport height); default 20.
  rows?: number
}
export type ActionResult = {
  buffer: Buffer
  // Text for `$.ui.copy` (copy, cut).
  copy?: string
  // The action was `save`: the buffer is unchanged, the client posts it.
  save?: true
}

export const applyAction = (
  buffer: Buffer,
  action: Action,
  ctx: ActionCtx = {},
): ActionResult => {
  const rows = ctx.rows ?? 20
  const b = (next: Buffer): ActionResult => ({ buffer: next })
  switch (action) {
    case 'moveLeft': return b(move(buffer, 'left'))
    case 'moveRight': return b(move(buffer, 'right'))
    case 'moveUp': return b(move(buffer, 'up'))
    case 'moveDown': return b(move(buffer, 'down'))
    case 'selectLeft': return b(move(buffer, 'left', { select: true }))
    case 'selectRight': return b(move(buffer, 'right', { select: true }))
    case 'selectUp': return b(move(buffer, 'up', { select: true }))
    case 'selectDown': return b(move(buffer, 'down', { select: true }))
    case 'wordLeft': return b(move(buffer, 'left', { word: true }))
    case 'wordRight': return b(move(buffer, 'right', { word: true }))
    case 'selectWordLeft': return b(move(buffer, 'left', { word: true, select: true }))
    case 'selectWordRight': return b(move(buffer, 'right', { word: true, select: true }))
    case 'home': return b(home(buffer))
    case 'end': return b(end(buffer))
    case 'selectHome': return b(home(buffer, { select: true }))
    case 'selectEnd': return b(end(buffer, { select: true }))
    case 'pageUp': return b(page(buffer, -rows))
    case 'pageDown': return b(page(buffer, rows))
    case 'selectPageUp': return b(page(buffer, -rows, { select: true }))
    case 'selectPageDown': return b(page(buffer, rows, { select: true }))
    case 'docStart': return b(docStart(buffer))
    case 'docEnd': return b(docEnd(buffer))
    case 'selectDocStart': return b(docStart(buffer, { select: true }))
    case 'selectDocEnd': return b(docEnd(buffer, { select: true }))
    case 'selectAll': return b(selectAll(buffer))
    case 'extendSelection': return b(extendSelection(buffer))
    case 'addNextOccurrence': return b(addNextOccurrence(buffer))
    case 'addCursorUp': return b(addCursorVertical(buffer, -1))
    case 'addCursorDown': return b(addCursorVertical(buffer, 1))
    case 'moveLinesUp': return b(moveLines(buffer, -1))
    case 'moveLinesDown': return b(moveLines(buffer, 1))
    case 'duplicateLines': return b(duplicateLines(buffer, 1))
    case 'duplicateLinesUp': return b(duplicateLines(buffer, -1))
    case 'deleteLines': return b(deleteLines(buffer))
    case 'indent': return b(indent(buffer))
    case 'outdent': return b(outdent(buffer))
    case 'toggleComment': return b(toggleComment(buffer, ctx.comment))
    case 'newline': return b(newline(buffer))
    case 'backspace': return b(backspace(buffer))
    case 'del': return b(del(buffer))
    case 'deleteWordBack': return b(deleteWordBack(buffer))
    case 'undo': return b(undo(buffer))
    case 'redo': return b(redo(buffer))
    case 'copy': {
      const r = copy(buffer)

      return { buffer: r.buffer, copy: r.text }
    }
    case 'cut': {
      const r = cut(buffer)

      return { buffer: r.buffer, copy: r.text }
    }
    case 'paste': return b(paste(buffer, buffer.clip ?? ''))
    case 'save': return { buffer, save: true }
  }
}
