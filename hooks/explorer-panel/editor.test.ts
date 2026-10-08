import { expect, test } from 'claude-code/testing'

import {
  ACTIONS,
  KEYMAPS,
  UNDO_CAP,
  addCursor,
  addCursorVertical,
  addNextOccurrence,
  applyAction,
  assemble,
  backspace,
  chordText,
  chunks,
  commentOf,
  copy,
  cursorAt,
  cut,
  del,
  deleteLines,
  deleteWordBack,
  docEnd,
  docStart,
  duplicateLines,
  end,
  extendSelection,
  extendTo,
  fromText,
  home,
  indent,
  insert,
  isDirty,
  keyOp,
  mergeKeymap,
  move,
  moveLines,
  newline,
  normalize,
  outdent,
  page,
  parseChord,
  paste,
  redo,
  selectAll,
  setCursor,
  toText,
  toggleComment,
  undo,
} from './editor'
import type { Buffer, Cursor, Pos } from './editor'

// Test notation: `|` a caret, `{` the anchor and `}` the head of a selection.
const mk = (marked: string): Buffer => {
  const cursors: Cursor[] = []
  let text = ''
  let line = 0
  let col = 0
  let open: { kind: string; pos: Pos } | undefined
  for (const ch of marked) {
    const pos = { line, col }
    if (ch === '|') cursors.push({ anchor: pos, head: pos })
    else if (ch === '{' || ch === '}') {
      if (open && open.kind !== ch) {
        cursors.push(
          ch === '{'
            ? { anchor: pos, head: open.pos }
            : { anchor: open.pos, head: pos },
        )
        open = undefined
      } else open = { kind: ch, pos }
    } else {
      text += ch
      if (ch === '\n') {
        line++
        col = 0
      } else col += ch.length
    }
  }
  const b = fromText(text)

  return normalize({ ...b, cursors })
}

const show = (b: Buffer): string => {
  const marks: { pos: Pos; ch: string }[] = []
  for (const c of b.cursors) {
    if (c.anchor.line === c.head.line && c.anchor.col === c.head.col)
      marks.push({ pos: c.head, ch: '|' })
    else {
      marks.push({ pos: c.anchor, ch: '{' })
      marks.push({ pos: c.head, ch: '}' })
    }
  }
  const lines = b.lines.slice()
  marks
    .sort((x, y) => y.pos.line - x.pos.line || y.pos.col - x.pos.col)
    .forEach(({ pos, ch }) => {
      lines[pos.line] =
        lines[pos.line]!.slice(0, pos.col) + ch + lines[pos.line]!.slice(pos.col)
    })

  return lines.join('\n')
}

const run = (before: string, op: (b: Buffer) => Buffer): string =>
  show(op(mk(before)))

test('fromText/toText: trailing newline and CRLF round trip', () => {
  for (const text of ['', 'a', 'a\n', 'a\nb', 'a\nb\n', '\n\n', 'a\r\nb\r\n', 'a\r\nb'])
    expect(toText(fromText(text))).toBe(text)
  expect(fromText('a\n').lines).toEqual(['a', ''])
  expect(fromText('a\r\nb').eol).toBe('\r\n')
  expect(fromText('a\nb').eol).toBe('\n')
  const b = insert(fromText('a\r\nb'), 'x')
  expect(toText(b)).toBe('xa\r\nb')
})

test('isDirty: compares to the original, either line ending', () => {
  const b = fromText('a\nb\n')
  expect(isDirty(b, 'a\nb\n')).toBe(false)
  expect(isDirty(b, 'a\r\nb\n')).toBe(false)
  expect(isDirty(b, 'a\nb')).toBe(true)
  expect(isDirty(b, 'a\nb\n\n')).toBe(true)
  const edited = insert(b, 'x')
  expect(isDirty(edited, 'a\nb\n')).toBe(true)
  expect(isDirty(undo(edited), 'a\nb\n')).toBe(false)
})

test('normalize: sorts, clamps and merges cursors', () => {
  const b = fromText('abc\nde')
  const n = normalize({
    ...b,
    cursors: [
      { anchor: { line: 1, col: 9 }, head: { line: 1, col: 9 } },
      { anchor: { line: 0, col: 1 }, head: { line: 0, col: 3 } },
      { anchor: { line: 0, col: 2 }, head: { line: 0, col: 3 } },
      { anchor: { line: 0, col: 1 }, head: { line: 0, col: 1 } },
    ],
  })
  expect(show(n)).toBe('a{bc}\nde|')
  expect(show(mk('{ab}c{d}e'))).toBe('{ab}c{d}e')
  expect(show(mk('{a|b}'))).toBe('{ab}')
  expect(show(mk('a|b|c'))).toBe('a|b|c')
})

test('move: one cursor', () => {
  expect(run('a|bc', (b) => move(b, 'left'))).toBe('|abc')
  expect(run('|abc', (b) => move(b, 'left'))).toBe('|abc')
  expect(run('abc|\nd', (b) => move(b, 'right'))).toBe('abc\n|d')
  expect(run('a\n|b', (b) => move(b, 'left'))).toBe('a|\nb')
  expect(run('abc|', (b) => move(b, 'right'))).toBe('abc|')
  expect(run('a{bc}d', (b) => move(b, 'left'))).toBe('a|bcd')
  expect(run('a{bc}d', (b) => move(b, 'right'))).toBe('abc|d')
  expect(run('a|bc', (b) => move(b, 'right', { select: true }))).toBe('a{b}c')
  expect(run('ab|c', (b) => move(b, 'left', { select: true }))).toBe('a}b{c')
  expect(run('foo bar|', (b) => move(b, 'left', { word: true }))).toBe('foo |bar')
  expect(run('foo| bar', (b) => move(b, 'right', { word: true }))).toBe('foo |bar')
  expect(run('f|oo bar', (b) => move(b, 'right', { word: true }))).toBe('foo |bar')
  expect(run('foo |bar', (b) => move(b, 'right', { word: true }))).toBe('foo bar|')
  expect(run('a.b|', (b) => move(b, 'left', { word: true }))).toBe('a.|b')
  expect(run('a|\n', (b) => move(b, 'right', { word: true }))).toBe('a\n|')
})

test('move: vertical keeps the sticky column and clamps at the ends', () => {
  expect(run('abcd|\nx\nabcd', (b) => move(b, 'down'))).toBe('abcd\nx|\nabcd')
  expect(run('abcd|\nx\nabcd', (b) => move(move(b, 'down'), 'down'))).toBe('abcd\nx\nabcd|')
  expect(run('ab|c', (b) => move(b, 'up'))).toBe('|abc')
  expect(run('a|bc', (b) => move(b, 'down'))).toBe('abc|')
  expect(run('ab|\ncd', (b) => move(b, 'up', { select: true }))).toBe('}ab{\ncd')
})

test('move: 2-3 cursors, same line, line ends, merge', () => {
  expect(run('a|b\nc|d', (b) => move(b, 'right'))).toBe('ab|\ncd|')
  expect(run('|a|b|c', (b) => move(b, 'left'))).toBe('|a|bc')
  expect(run('a|b|c', (b) => move(b, 'right'))).toBe('ab|c|')
  expect(run('ab|\n|cd\nx|', (b) => move(b, 'down'))).toBe('ab\ncd|\n|x|')
  expect(run('a|\nb|\nc|', (b) => move(b, 'up'))).toBe('|a|\nb|\nc')
  expect(move(mk('a|b|c'), 'left', { select: true }).cursors.length).toBe(2)
})

test('home/end/page/docStart/docEnd', () => {
  expect(run('  ab|c', home)).toBe('  |abc')
  expect(run('  |abc', home)).toBe('|  abc')
  expect(run('|  abc', home)).toBe('  |abc')
  expect(run('ab|c', home)).toBe('|abc')
  expect(run('a|bc', end)).toBe('abc|')
  expect(run('a|b\n  c|d', home)).toBe('|ab\n  |cd')
  expect(run('a|b|c\nd', end)).toBe('abc|\nd')
  expect(run('a|b', (b) => end(b, { select: true }))).toBe('a{b}')
  expect(run('a|\nb\nc\nd', (b) => page(b, 2))).toBe('a\nb\nc|\nd')
  expect(run('a\nb\nc\nd|', (b) => page(b, -9))).toBe('a|\nb\nc\nd')
  expect(run('a\nb|\nc', docStart)).toBe('|a\nb\nc')
  expect(run('a\nb|\nc', docEnd)).toBe('a\nb\nc|')
  expect(run('a|\nb|', (b) => docEnd(b, { select: true }))).toBe('a{\nb}')
})

test('selectAll, setCursor, extendTo, addCursor', () => {
  expect(run('a|b\nc', selectAll)).toBe('{ab\nc}')
  expect(run('a|b|\nc', (b) => setCursor(b, { line: 1, col: 1 }))).toBe('ab\nc|')
  expect(run('a|bc', (b) => extendTo(b, { line: 0, col: 3 }))).toBe('a{bc}')
  expect(run('ab|c', (b) => extendTo(b, { line: 0, col: 0 }))).toBe('}ab{c')
  expect(run('a|bc', (b) => addCursor(b, { line: 0, col: 3 }))).toBe('a|bc|')
  expect(run('a|bc|', (b) => addCursor(b, { line: 0, col: 3 }))).toBe('a|bc')
  expect(run('a|bc', (b) => addCursor(b, { line: 0, col: 1 }))).toBe('a|bc')
  const b = addCursor(mk('a|bc\nde'), { line: 1, col: 2 })
  expect(cursorAt(b, { line: 1, col: 2 })).toBe(1)
  expect(show(extendTo(b, { line: 1, col: 0 }, 1))).toBe('a|bc\n}de{')
})

test('addCursorVertical: column select up and down', () => {
  expect(run('ab|c\nxyz\nq', (b) => addCursorVertical(b, 1))).toBe('ab|c\nxy|z\nq')
  expect(run('ab|c\nxyz\nq', (b) => addCursorVertical(addCursorVertical(b, 1), 1))).toBe('ab|c\nxy|z\nq|')
  expect(run('q\nxyz\nab|c', (b) => addCursorVertical(b, -1))).toBe('q\nxy|z\nab|c')
  expect(run('a|b', (b) => addCursorVertical(b, -1))).toBe('a|b')
  expect(run('a|b\nc|d', (b) => addCursorVertical(b, 1))).toBe('a|b\nc|d')
})

test('addNextOccurrence: word first, then next hit, wrapping', () => {
  expect(run('f|oo x foo', addNextOccurrence)).toBe('{foo} x foo')
  expect(run('f|oo x foo', (b) => addNextOccurrence(addNextOccurrence(b)))).toBe('{foo} x {foo}')
  expect(run('foo x f|oo', (b) => addNextOccurrence(addNextOccurrence(b)))).toBe('{foo} x {foo}')
  expect(run('f|oo\nbar\nfoo', (b) => addNextOccurrence(addNextOccurrence(b)))).toBe('{foo}\nbar\n{foo}')
  expect(run('f|oo f|oo', addNextOccurrence)).toBe('{foo} {foo}')
  expect(run('{foo} {foo}', addNextOccurrence)).toBe('{foo} {foo}')
  expect(run(' | ', addNextOccurrence)).toBe(' | ')
  const three = addNextOccurrence(addNextOccurrence(addNextOccurrence(mk('f|oo foo foo'))))
  expect(show(three)).toBe('{foo} {foo} {foo}')
})

test('extendSelection: word, line, all', () => {
  expect(run('ab c|d', extendSelection)).toBe('ab {cd}')
  expect(run('ab {cd}', extendSelection)).toBe('{ab cd}')
  expect(run('ab cd\nxy|', (b) => extendSelection(b))).toBe('ab cd\n{xy}')
  expect(run('{ab cd}\nxy', extendSelection)).toBe('{ab cd\nxy}')
  expect(run(' | ', extendSelection)).toBe('{  }')
  expect(run('a|b\nc|d', extendSelection)).toBe('{ab}\n{cd}')
})

test('insert: one cursor, multi-line text, selection', () => {
  expect(run('a|b', (b) => insert(b, 'X'))).toBe('aX|b')
  expect(run('a|b', (b) => insert(b, '1\n2'))).toBe('a1\n2|b')
  expect(run('a|b', (b) => insert(b, '1\r\n2'))).toBe('a1\n2|b')
  expect(run('a{bc}d', (b) => insert(b, 'X'))).toBe('aX|d')
  expect(run('a{b\nc}d', (b) => insert(b, 'X'))).toBe('aX|d')
})

test('insert: 2-3 cursors', () => {
  expect(run('a|b|c', (b) => insert(b, 'X'))).toBe('aX|bX|c')
  expect(run('|a\nb|\n|c', (b) => insert(b, 'X'))).toBe('X|a\nbX|\nX|c')
  expect(run('a|b\nc|d', (b) => insert(b, '1\n2'))).toBe('a1\n2|b\nc1\n2|d')
  expect(run('{a}b{c}', (b) => insert(b, 'XY'))).toBe('XY|bXY|')
  expect(run('|a|b|c', (b) => insert(b, '\n'))).toBe('\n|a\n|b\n|c')
})

test('newline: keeps the indent, per cursor', () => {
  expect(run('  a|b', newline)).toBe('  a\n  |b')
  expect(run('a|b', newline)).toBe('a\n|b')
  expect(run('  |ab', newline)).toBe('  \n  |ab')
  expect(run(' {ab}c', newline)).toBe(' \n |c')
  expect(run('a|\n b|', newline)).toBe('a\n|\n b\n |')
  expect(run('  a|b|c', newline)).toBe('  a\n  |b\n  |c')
})

test('backspace', () => {
  expect(run('ab|c', backspace)).toBe('a|c')
  expect(run('|ab', backspace)).toBe('|ab')
  expect(run('a\n|b', backspace)).toBe('a|b')
  expect(run('x{ab}c', backspace)).toBe('x|c')
  expect(run('a|b|c', backspace)).toBe('|c')
  expect(run('ab|\ncd|', backspace)).toBe('a|\nc|')
  expect(run('|a\n|b', backspace)).toBe('|a|b')
  expect(run('|a|b|c', backspace)).toBe('|c')
  expect(run('x😀|', backspace)).toBe('x|')
})

test('del', () => {
  expect(run('a|bc', del)).toBe('a|c')
  expect(run('a|\nb', del)).toBe('a|b')
  expect(run('a|', del)).toBe('a|')
  expect(run('a|b|c', del)).toBe('a|')
  expect(run('a|b\nc|d', del)).toBe('a|\nc|')
  expect(run('x{ab}c', del)).toBe('x|c')
  expect(run('a|\nb|', del)).toBe('a|b|')
})

test('deleteWordBack', () => {
  expect(run('foo bar|', deleteWordBack)).toBe('foo |')
  expect(run('foo |', deleteWordBack)).toBe('|')
  expect(run('a\n|b', deleteWordBack)).toBe('a|b')
  expect(run('x{ab}c', deleteWordBack)).toBe('x|c')
  expect(run('foo bar| baz|', deleteWordBack)).toBe('foo | |')
  expect(run('ab|c|', deleteWordBack)).toBe('|')
  expect(run('|', deleteWordBack)).toBe('|')
})

test('moveLines: one cursor and the ends', () => {
  expect(run('a\nb|\nc\nd', (b) => moveLines(b, -1))).toBe('b|\na\nc\nd')
  expect(run('a\nb|\nc\nd', (b) => moveLines(b, 1))).toBe('a\nc\nb|\nd')
  expect(run('|a\nb', (b) => moveLines(b, -1))).toBe('|a\nb')
  expect(run('a\nb|', (b) => moveLines(b, 1))).toBe('a\nb|')
  expect(run('a\n{b\nc}\nd', (b) => moveLines(b, 1))).toBe('a\nd\n{b\nc}')
  expect(run('a\n{b\n}c\nd', (b) => moveLines(b, -1))).toBe('{b\n}a\nc\nd')
})

test('moveLines: 2-3 cursors', () => {
  expect(run('a|\nb\nc|\nd', (b) => moveLines(b, -1))).toBe('a|\nc|\nb\nd')
  expect(run('a|\nb\nc|\nd', (b) => moveLines(b, 1))).toBe('b\na|\nd\nc|')
  expect(run('a|\nb|\nc\nd', (b) => moveLines(b, 1))).toBe('c\na|\nb|\nd')
  expect(run('a\nb|\nc|\nd|', (b) => moveLines(b, 1))).toBe('a\nb|\nc|\nd|')
  expect(run('a|b|c\nd', (b) => moveLines(b, 1))).toBe('d\na|b|c')
  expect(run('a\nb|\nc|\nd|', (b) => moveLines(b, -1))).toBe('b|\nc|\nd|\na')
})

test('duplicateLines', () => {
  expect(run('a|\nb', (b) => duplicateLines(b, 1))).toBe('a\na|\nb')
  expect(run('a|\nb', (b) => duplicateLines(b, -1))).toBe('a|\na\nb')
  expect(run('a\nb|', (b) => duplicateLines(b))).toBe('a\nb\nb|')
  expect(run('a|\nb\nc|', (b) => duplicateLines(b, 1))).toBe('a\na|\nb\nc\nc|')
  expect(run('a|\nb\nc|', (b) => duplicateLines(b, -1))).toBe('a|\na\nb\nc|\nc')
  expect(run('a|b|c', (b) => duplicateLines(b))).toBe('abc\na|b|c')
  expect(run('{a\nb}\nc', (b) => duplicateLines(b))).toBe('a\nb\n{a\nb}\nc')
  expect(run('a|\nb|\nc', (b) => duplicateLines(b))).toBe('a\na|\nb\nb|\nc')
})

test('deleteLines', () => {
  expect(run('a\nb|\nc', deleteLines)).toBe('a\nc|')
  expect(run('a\nb|', deleteLines)).toBe('a|')
  expect(run('a|\nb', deleteLines)).toBe('b|')
  expect(run('{a\nb}', deleteLines)).toBe('|')
  expect(run('a|', deleteLines)).toBe('|')
  expect(run('a|\nb\nc|\nd', deleteLines)).toBe('b|\nd|')
  expect(run('a|b|c\nd', deleteLines)).toBe('d|')
  expect(run('a\n{b\nc\n}d', deleteLines)).toBe('a\n|d')
})

test('indent / outdent', () => {
  expect(run('a|b', (b) => indent(b))).toBe('a  |b')
  expect(run('a|b|', (b) => indent(b, '\t'))).toBe('a\t|b\t|')
  expect(run('{a\nb}', (b) => indent(b))).toBe('  {a\n  b}')
  expect(run('{a\n\nb}', (b) => indent(b))).toBe('  {a\n\n  b}')
  expect(run('{a\n}b', (b) => indent(b))).toBe('  {a\n}b')
  expect(run('a|\nb|', (b) => indent(b))).toBe('a  |\nb  |')
  expect(run('    a|', (b) => outdent(b))).toBe('  a|')
  expect(run('a|', (b) => outdent(b))).toBe('a|')
  expect(run('\ta|', (b) => outdent(b))).toBe('a|')
  expect(run(' |a', (b) => outdent(b))).toBe('|a')
  expect(run('    a|\n  b|\nc|', (b) => outdent(b))).toBe('  a|\nb|\nc|')
  expect(run('{    a\n    b}', (b) => outdent(b))).toBe('{  a\n  b}')
})

test('toggleComment', () => {
  expect(run('a|\nb', (b) => toggleComment(b, '//'))).toBe('// a|\nb')
  expect(run('// a|', (b) => toggleComment(b, '//'))).toBe('a|')
  expect(run('//a|', (b) => toggleComment(b, '//'))).toBe('a|')
  expect(run('  a|', (b) => toggleComment(b, '#'))).toBe('  # a|')
  expect(run('{a\n  b}', (b) => toggleComment(b, '//'))).toBe('// {a\n//   b}')
  expect(run('a|\n\nb|', (b) => toggleComment(b, '--'))).toBe('-- a|\n\n-- b|')
  expect(run('// a|\nb|', (b) => toggleComment(b, '//'))).toBe('// // a|\n// b|')
  expect(run('// a|\n// b|', (b) => toggleComment(b, '//'))).toBe('a|\nb|')
  expect(run('a|b|c', (b) => toggleComment(b, '//'))).toBe('// a|b|c')
  expect(run('a|', (b) => toggleComment(b, undefined))).toBe('a|')
  expect(run('|\n|', (b) => toggleComment(b, '//'))).toBe('|\n|')
})

test('copy / cut', () => {
  expect(copy(mk('a|\nb')).text).toBe('a\n')
  expect(copy(mk('a|\nb\nc|')).text).toBe('a\nc\n')
  expect(copy(mk('a|b|c')).text).toBe('abc\n')
  expect(copy(mk('{ab}c{d}')).text).toBe('ab\nd')
  expect(copy(mk('{a\nb}')).text).toBe('a\nb')
  expect(copy(mk('{ab}c|')).text).toBe('ab')
  expect(copy(mk('x{ab}y')).buffer.clip).toBe('ab')
  const line = cut(mk('a|\nb'))
  expect(line.text).toBe('a\n')
  expect(show(line.buffer)).toBe('b|')
  const sel = cut(mk('x{ab}y'))
  expect(sel.text).toBe('ab')
  expect(show(sel.buffer)).toBe('x|y')
  expect(sel.buffer.clip).toBe('ab')
  const multi = cut(mk('{a}b{c}'))
  expect(multi.text).toBe('a\nc')
  expect(show(multi.buffer)).toBe('|b|')
  expect(show(cut(mk('a|\nb\nc|')).buffer)).toBe('b|')
})

test('paste', () => {
  expect(run('a|b', (b) => paste(b, 'XY'))).toBe('aXY|b')
  expect(run('a{b}c', (b) => paste(b, 'XY'))).toBe('aXY|c')
  expect(run('a|\nb|', (b) => paste(b, 'X\nY'))).toBe('aX|\nbY|')
  expect(run('a|\nb|', (b) => paste(b, 'X'))).toBe('aX|\nbX|')
  expect(run('a|\nb|\nc|', (b) => paste(b, 'X\nY'))).toBe('aX\nY|\nbX\nY|\ncX\nY|')
  expect(run('a|', (b) => paste(b, ''))).toBe('a|')
  expect(run('a|', (b) => paste(b, 'x\r\ny'))).toBe('ax\ny|')
  const copied = copy(mk('a|\nb'))
  const moved = move(copied.buffer, 'down')
  expect(show(paste(moved, copied.text))).toBe('a\na\nb|')
  const first = copy(mk('a|\nb')).buffer
  expect(show(paste(first, 'a\n'))).toBe('a\na|\nb')
})

test('history: undo/redo restore text and cursors', () => {
  const b0 = mk('x|y')
  const b1 = insert(b0, 'Z')
  expect(show(b1)).toBe('xZ|y')
  const b2 = undo(b1)
  expect(show(b2)).toBe('x|y')
  expect(show(redo(b2))).toBe('xZ|y')
  expect(undo(b0)).toBe(b0)
  expect(redo(b0)).toBe(b0)
  const n = undo(newline(mk('  a|b')))
  expect(show(n)).toBe('  a|b')
  const m = undo(moveLines(mk('a\nb|\nc'), -1))
  expect(show(m)).toBe('a\nb|\nc')
  const d = undo(deleteLines(mk('a|\nb|\nc')))
  expect(show(d)).toBe('a|\nb|\nc')
  expect(show(undo(paste(mk('a|\nb|'), 'X\nY')))).toBe('a|\nb|')
  expect(show(undo(indent(mk('{a\nb}'))))).toBe('{a\nb}')
})

test('history: new edit clears redo, typing groups into one step', () => {
  let b = mk('|')
  for (const ch of 'abc') b = insert(b, ch)
  expect(b.undo.length).toBe(1)
  expect(toText(undo(b))).toBe('')
  expect(toText(redo(undo(b)))).toBe('abc')
  const u = undo(b)
  expect(u.redo.length).toBe(1)
  expect(insert(u, 'q').redo.length).toBe(0)
  // a cursor move between keys splits the group
  let c = insert(mk('|'), 'a')
  c = move(c, 'left')
  c = insert(c, 'b')
  expect(c.undo.length).toBe(2)
  // multi-char insert, newline and deletes are their own steps
  expect(insert(insert(mk('|'), 'ab'), 'c').undo.length).toBe(2)
  expect(insert(insert(mk('|'), 'a'), '\n').undo.length).toBe(2)
  // 2 cursors typing
  let m = mk('a|b|')
  m = insert(insert(m, 'x'), 'y')
  expect(show(m)).toBe('axy|bxy|')
  expect(m.undo.length).toBe(1)
  expect(show(undo(m))).toBe('a|b|')
  expect(show(redo(undo(m)))).toBe('axy|bxy|')
})

test('history: capped at 200 steps', () => {
  let b = mk('|')
  for (let i = 0; i < UNDO_CAP + 50; i++) b = newline(b)
  expect(b.undo.length).toBe(UNDO_CAP)
  let u = b
  for (let i = 0; i < UNDO_CAP + 10; i++) u = undo(u)
  expect(u.lines.length).toBe(51)
  expect(u.redo.length).toBe(UNDO_CAP)
})

test('large buffer: an edit and its undo touch only the edited lines', () => {
  const n = 100_000
  const text = Array.from({ length: n }, (_, i) => `l${i}`).join('\n')
  const b = setCursor(fromText(text), { line: 50_000, col: 2 })
  const e = insert(b, 'X')
  expect(e.lines[50_000]).toBe('l5X0000')
  expect(e.undo.length).toBe(1)
  expect(e.undo[0]!.edits).toEqual([
    { at: 50_000, old: ['l50000'], neu: ['l5X0000'] },
  ])
  for (const i of [0, 1, 49_999, 50_001, n - 1]) expect(e.lines[i]).toBe(b.lines[i])
  const u = undo(e)
  expect(u.lines.length).toBe(n)
  expect(u.lines[50_000]).toBe('l50000')
  expect(toText(u)).toBe(text)
  const moved = moveLines(b, 1)
  expect(moved.undo[0]!.edits.length).toBe(1)
  expect(moved.undo[0]!.edits[0]!.old.length).toBe(2)
  expect(toText(undo(moved))).toBe(text)
  const dup = duplicateLines(b)
  expect(dup.undo[0]!.edits).toEqual([{ at: 50_001, old: [], neu: ['l50000'] }])
  expect(toText(undo(dup))).toBe(text)
  expect(isDirty(e, text)).toBe(true)
  expect(isDirty(u, text)).toBe(false)
})

test('large paste is applied and undone', () => {
  const big = Array.from({ length: 30_000 }, (_, i) => `r${i}`).join('\n')
  const b = paste(fromText('a\nb'), big)
  expect(b.lines.length).toBe(30_001 + 0)
  expect(toText(undo(b))).toBe('a\nb')
  expect(toText(redo(undo(b)))).toBe(`${big}a\nb`)
})

test('chunks / assemble', () => {
  const text = 'x'.repeat(200_000)
  const parts = chunks(text, 90_000)
  expect(parts.map((p) => p.length)).toEqual([90_000, 90_000, 20_000])
  expect(assemble(parts)).toBe(text)
  expect(chunks('', 90_000)).toEqual([''])
  expect(chunks('abc', 2)).toEqual(['ab', 'c'])
  expect(chunks('a😀b', 2)).toEqual(['a', '😀', 'b'])
  expect(assemble(['a', undefined, 'c'])).toBeUndefined()
  expect(assemble([])).toBe('')
  expect(assemble(chunks('héllo wörld', 3))).toBe('héllo wörld')
})

test('commentOf', () => {
  expect(commentOf('typescript')).toBe('//')
  expect(commentOf('csharp')).toBe('//')
  expect(commentOf('python')).toBe('#')
  expect(commentOf('bash')).toBe('#')
  expect(commentOf('sql')).toBe('--')
  expect(commentOf('lua')).toBe('--')
  expect(commentOf('json')).toBeUndefined()
  expect(commentOf('markdown')).toBeUndefined()
  expect(commentOf(undefined)).toBeUndefined()
})

const eventOf = (chord: string) => {
  const c = parseChord(chord)
  if (!c) throw new Error(`bad chord ${chord}`)

  return {
    key: c.key,
    ...(c.ctrl ? { ctrl: true as const } : {}),
    ...(c.shift ? { shift: true as const } : {}),
    ...(c.meta ? { meta: true as const } : {}),
  }
}

test('parseChord: syntax, aliases, rejects', () => {
  expect(parseChord('ctrl+shift+up')).toEqual({ key: 'up', ctrl: true, meta: false, shift: true })
  expect(parseChord('Alt+J')).toEqual({ key: 'j', ctrl: false, meta: true, shift: false })
  expect(parseChord('meta+j')).toEqual(parseChord('alt+j'))
  expect(parseChord('ctrl+/')).toEqual({ key: '/', ctrl: true, meta: false, shift: false })
  expect(parseChord('ctrl++')).toEqual({ key: '+', ctrl: true, meta: false, shift: false })
  expect(parseChord('ctrl+enter')?.key).toBe('return')
  expect(parseChord('space')?.key).toBe(' ')
  expect(chordText(parseChord('shift+ctrl+meta+left')!)).toBe('ctrl+meta+shift+left')
  for (const bad of ['', 'ctrl+', 'foo+x', 'ctrl+shift', 'hyper+a', 'ctrl+ab'])
    expect(parseChord(bad)).toBeUndefined()
})

test('keymaps: every preset entry resolves to its action, no chord twice', () => {
  for (const name of ['jetbrains', 'vscode'] as const) {
    const map = KEYMAPS[name]
    const seen = new Set<string>()
    for (const action of ACTIONS) {
      expect(Array.isArray(map[action])).toBe(true)
      for (const chord of map[action]) {
        const parsed = parseChord(chord)
        expect(parsed).toBeDefined()
        expect(chordText(parsed!)).toBe(chord)
        expect(seen.has(chord)).toBe(false)
        seen.add(chord)
        expect(keyOp(eventOf(chord), map)).toBe(action)
      }
    }
    expect(Object.keys(map).length).toBe(ACTIONS.length)
  }
})

test('keymaps: the JetBrains and VS Code presets', () => {
  const jb = KEYMAPS.jetbrains
  expect(jb.addNextOccurrence).toEqual(['meta+j'])
  expect(jb.duplicateLines).toEqual(['ctrl+d'])
  expect(jb.deleteLines).toEqual(['ctrl+y'])
  expect(jb.moveLinesUp).toEqual(['ctrl+shift+up'])
  expect(jb.toggleComment).toEqual(['ctrl+/'])
  expect(jb.undo).toEqual(['ctrl+z'])
  expect(jb.redo).toEqual(['ctrl+shift+z'])
  expect(jb.save).toEqual(['ctrl+s'])
  const vs = KEYMAPS.vscode
  expect(vs.moveLinesUp).toEqual(['meta+up'])
  expect(vs.duplicateLines).toEqual(['meta+shift+down'])
  expect(vs.duplicateLinesUp).toEqual(['meta+shift+up'])
  expect(vs.addNextOccurrence).toEqual(['ctrl+d'])
  expect(vs.deleteLines).toEqual(['ctrl+shift+k'])
  expect(vs.addCursorDown).toEqual(['ctrl+shift+down'])
  expect(vs.redo).toContain('ctrl+y')
})

test('keyOp: modifiers, shifted letters, aliases, plain typing', () => {
  const jb = KEYMAPS.jetbrains
  expect(keyOp({ key: 'd', ctrl: true }, jb)).toBe('duplicateLines')
  expect(keyOp({ key: 'D', ctrl: true }, jb)).toBeUndefined()
  expect(keyOp({ key: 'Z', ctrl: true }, jb)).toBe('redo')
  expect(keyOp({ key: 'z', ctrl: true, shift: true }, jb)).toBe('redo')
  expect(keyOp({ key: 'return' }, jb)).toBe('newline')
  expect(keyOp({ key: 'enter' }, jb)).toBe('newline')
  expect(keyOp({ key: 'tab', shift: true }, jb)).toBe('outdent')
  expect(keyOp({ key: 'up', meta: true, shift: true }, jb)).toBe('addCursorUp')
  expect(keyOp({ key: 'a' }, jb)).toBeUndefined()
  expect(keyOp({ key: 'A' }, jb)).toBeUndefined()
  expect(keyOp({ key: '/', ctrl: true }, jb)).toBe('toggleComment')
})

test('mergeKeymap: an override rebinds duplicateLines', () => {
  const before = JSON.stringify(KEYMAPS.jetbrains)
  const { keymap, errors } = mergeKeymap(
    KEYMAPS.jetbrains,
    '{"duplicateLines":"Ctrl+Shift+D","deleteLines":["ctrl+y","alt+x"]}',
  )
  expect(errors).toEqual([])
  expect(keymap.duplicateLines).toEqual(['ctrl+shift+d'])
  expect(keymap.deleteLines).toEqual(['ctrl+y', 'meta+x'])
  expect(keyOp({ key: 'd', ctrl: true, shift: true }, keymap)).toBe('duplicateLines')
  expect(keyOp({ key: 'd', ctrl: true }, keymap)).toBeUndefined()
  expect(keyOp({ key: 'x', meta: true }, keymap)).toBe('deleteLines')
  expect(JSON.stringify(KEYMAPS.jetbrains)).toBe(before)
})

test('mergeKeymap: a taken chord is freed from its old action; [] unbinds', () => {
  const a = mergeKeymap(KEYMAPS.jetbrains, '{"duplicateLines":"ctrl+y"}')
  expect(a.keymap.duplicateLines).toEqual(['ctrl+y'])
  expect(a.keymap.deleteLines).toEqual([])
  expect(keyOp({ key: 'y', ctrl: true }, a.keymap)).toBe('duplicateLines')
  const b = mergeKeymap(KEYMAPS.jetbrains, '{"save":[]}')
  expect(b.keymap.save).toEqual([])
  expect(keyOp({ key: 's', ctrl: true }, b.keymap)).toBeUndefined()
})

test('mergeKeymap: bad JSON and unknown actions report and leave the preset', () => {
  const preset = JSON.stringify(KEYMAPS.vscode)
  for (const json of ['{nope', '[1]', '"x"', 'null', '5']) {
    const r = mergeKeymap(KEYMAPS.vscode, json)
    expect(r.errors.length).toBe(1)
    expect(JSON.stringify(r.keymap)).toBe(preset)
  }
  const unknown = mergeKeymap(KEYMAPS.vscode, '{"explode":"ctrl+q","toString":"ctrl+q"}')
  expect(unknown.errors.length).toBe(2)
  expect(unknown.errors[0]).toContain('explode')
  expect(JSON.stringify(unknown.keymap)).toBe(preset)
  expect(JSON.stringify(mergeKeymap(KEYMAPS.vscode).keymap)).toBe(preset)
  expect(JSON.stringify(mergeKeymap(KEYMAPS.vscode, '  ').keymap)).toBe(preset)
})

test('mergeKeymap: a bad chord skips only that entry', () => {
  const r = mergeKeymap(
    KEYMAPS.jetbrains,
    '{"duplicateLines":"ctrl+","undo":"ctrl+u","redo":7}',
  )
  expect(r.errors.length).toBe(2)
  expect(r.errors[0]).toContain('duplicateLines')
  expect(r.keymap.duplicateLines).toEqual(['ctrl+d'])
  expect(r.keymap.undo).toEqual(['ctrl+u'])
  expect(r.keymap.redo).toEqual(['ctrl+shift+z'])
})

test('applyAction: dispatch, copy, paste, save', () => {
  const b = mk('a|\nb')
  expect(show(applyAction(b, 'duplicateLines').buffer)).toBe('a\na|\nb')
  expect(show(applyAction(b, 'moveLinesDown').buffer)).toBe('b\na|')
  expect(show(applyAction(b, 'toggleComment', { comment: '#' }).buffer)).toBe('# a|\nb')
  expect(show(applyAction(b, 'toggleComment').buffer)).toBe('a|\nb')
  expect(show(applyAction(b, 'indent').buffer)).toBe('a  |\nb')
  expect(show(applyAction(b, 'pageDown', { rows: 5 }).buffer)).toBe('a\nb|')
  const c = applyAction(b, 'copy')
  expect(c.copy).toBe('a\n')
  expect(show(applyAction(c.buffer, 'paste').buffer)).toBe('a\na|\nb')
  const x = applyAction(b, 'cut')
  expect(x.copy).toBe('a\n')
  expect(show(x.buffer)).toBe('b|')
  const s = applyAction(b, 'save')
  expect(s.save).toBe(true)
  expect(s.buffer).toBe(b)
})

test('applyAction: every action runs on multiple cursors without breaking them', () => {
  for (const action of ACTIONS) {
    const r = applyAction(mk('ab|c\n  de|f\ng|'), action, { comment: '//' })
    const cs = r.buffer.cursors
    expect(cs.length).toBeGreaterThan(0)
    for (let i = 0; i < cs.length; i++) {
      for (const p of [cs[i]!.anchor, cs[i]!.head]) {
        expect(p.line).toBeGreaterThanOrEqual(0)
        expect(p.line).toBeLessThan(r.buffer.lines.length)
        expect(p.col).toBeLessThanOrEqual(r.buffer.lines[p.line]!.length)
      }
    }
  }
})
