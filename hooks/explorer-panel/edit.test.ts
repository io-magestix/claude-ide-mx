import { expect, test } from 'claude-code/testing'

import { DRAFT_DIR, accept, draftFile, editorColors, hashPath, mixHex, parseChunk, parseHView } from './edit'
import { themeFromClaudeCode } from '../shared/term-theme'
import type { ChunkMsg } from './edit'

// The panels' theme in the tests: Claude Code's dark theme, no terminal scheme.
const DARK = themeFromClaudeCode('dark', undefined)

const msg = (over: Partial<ChunkMsg> = {}): ChunkMsg => ({
  kind: 'save',
  version: 1,
  seq: 1,
  index: 0,
  total: 1,
  chunk: 'abc',
  ...over,
})

test('hashPath: 16 hex digits, stable, distinct per path', () => {
  expect(hashPath('/a/b.ts')).toMatch(/^[0-9a-f]{16}$/)
  expect(hashPath('/a/b.ts')).toBe(hashPath('/a/b.ts'))
  expect(hashPath('/a/b.ts')).not.toBe(hashPath('/a/c.ts'))
})

test('draftFile: under HOME, a trailing slash dropped', () => {
  const name = hashPath('/p/x.ts') + '.txt'
  expect(draftFile('/home/u', '/p/x.ts')).toBe(`/home/u/${DRAFT_DIR}/${name}`)
  expect(draftFile('/home/u/', '/p/x.ts')).toBe(`/home/u/${DRAFT_DIR}/${name}`)
})

test('parseChunk: takes a well-formed chunk, force only when true', () => {
  expect(parseChunk({ ...msg(), id: 'n:1' })).toEqual(msg())
  expect(parseChunk({ ...msg(), force: true })).toEqual({ ...msg(), force: true })
  expect(parseChunk({ ...msg(), force: 'yes' })).toEqual(msg())
})

test('parseChunk: refuses anything else', () => {
  expect(parseChunk(null)).toBeUndefined()
  expect(parseChunk('save')).toBeUndefined()
  expect(parseChunk({ ...msg(), kind: 'copy' })).toBeUndefined()
  expect(parseChunk({ ...msg(), version: '1' })).toBeUndefined()
  expect(parseChunk({ ...msg(), chunk: 3 })).toBeUndefined()
  expect(parseChunk({ ...msg(), index: 1.5 })).toBeUndefined()
  expect(parseChunk({ ...msg(), index: 1, total: 1 })).toBeUndefined()
  expect(parseChunk({ ...msg(), index: -1 })).toBeUndefined()
  expect(parseChunk({ ...msg(), total: 0 })).toBeUndefined()
  expect(parseChunk({ ...msg(), total: 65 })).toBeUndefined()
})

test('accept: assembles parts in any order, hands the text out once', () => {
  let got = accept(undefined, msg({ index: 1, total: 3, chunk: 'b' }))
  expect(got.text).toBeUndefined()
  got = accept(got.incoming, msg({ index: 0, total: 3, chunk: 'a' }))
  expect(got.text).toBeUndefined()
  got = accept(got.incoming, msg({ index: 2, total: 3, chunk: 'c' }))
  expect(got.text).toBe('abc')
  // a resent last chunk does not write again
  got = accept(got.incoming, msg({ index: 2, total: 3, chunk: 'c' }))
  expect(got.text).toBeUndefined()
})

test('accept: a new seq, version or kind starts over', () => {
  let got = accept(undefined, msg({ index: 0, total: 2, chunk: 'a' }))
  got = accept(got.incoming, msg({ seq: 2, index: 1, total: 2, chunk: 'B' }))
  expect(got.text).toBeUndefined()
  got = accept(got.incoming, msg({ seq: 2, index: 0, total: 2, chunk: 'A' }))
  expect(got.text).toBe('AB')

  got = accept(got.incoming, msg({ version: 2, chunk: 'v2' }))
  expect(got.text).toBe('v2')
  got = accept(got.incoming, msg({ version: 2, kind: 'draft', chunk: 'd' }))
  expect(got.text).toBe('d')
})

test('parseHView takes three non-negative integers, nothing else', () => {
  expect(parseHView({ left: 3, widest: 300, width: 58 })).toEqual({ left: 3, widest: 300, width: 58 })
  expect(parseHView({ left: 0, widest: 0, width: 1, extra: 'x' })).toEqual({ left: 0, widest: 0, width: 1 })
  expect(parseHView(null)).toBeUndefined()
  expect(parseHView('x')).toBeUndefined()
  expect(parseHView({ left: -1, widest: 300, width: 58 })).toBeUndefined()
  expect(parseHView({ left: 1.5, widest: 300, width: 58 })).toBeUndefined()
  expect(parseHView({ left: 1, widest: '300', width: 58 })).toBeUndefined()
  expect(parseHView({ left: 1, widest: 300 })).toBeUndefined()
})

test('mixHex: the ends, halfway, and a non-hex color left alone', () => {
  expect(mixHex('#000000', '#ffffff', 0)).toBe('#000000')
  expect(mixHex('#000000', '#ffffff', 1)).toBe('#ffffff')
  expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080')
  expect(mixHex('red', '#ffffff', 0.5)).toBe('red')
})

test('editorColors: theme text and muted gutter, inverted caret, a sunk accent selection', () => {
  const t = DARK
  const c = editorColors(t)
  expect(c.text).toBe(t.text)
  expect(c.gutter).toBe(t.muted)
  expect(c.caret).toBe(t.text)
  expect(c.caretText).toBe(t.bg)
  expect(c.selection).toBe(mixHex(t.accent, t.bg, 0.65))
  expect(c.selection).not.toBe(t.accent)
})
