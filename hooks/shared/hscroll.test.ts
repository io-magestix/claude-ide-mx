import { expect, test } from 'claude-code/testing'

import { expandTabs, sliceCols, sliceDiffCols, sliceRuns, widest, widthOf } from './hscroll'

test('sliceCols: ASCII drops the first left columns', () => {
  expect(sliceCols('abcdef', 2)).toBe('cdef')
  expect(sliceCols('abcdef', 5)).toBe('f')
})

test('sliceCols: left 0 or less leaves the line as it is', () => {
  expect(sliceCols('abc', 0)).toBe('abc')
  expect(sliceCols('abc', -3)).toBe('abc')
  expect(sliceCols('abc', Number.NaN)).toBe('abc')
})

test('sliceCols: at or past the end is empty', () => {
  expect(sliceCols('abc', 3)).toBe('')
  expect(sliceCols('abc', 50)).toBe('')
  expect(sliceCols('', 1)).toBe('')
})

test('expandTabs: leading tabs are 2 spaces, others reach the next multiple of 8', () => {
  expect(expandTabs('\t\tx')).toBe('    x')
  expect(expandTabs('ab\tc')).toBe('ab      c')
  expect(expandTabs('abcdefghi\tc')).toBe('abcdefghi       c')
  expect(expandTabs(' \tx')).toBe('        x')
  expect(expandTabs('\tx\ty')).toBe('  x     y')
  expect(expandTabs('中\tx')).toBe('中      x')
  expect(expandTabs('no tab')).toBe('no tab')
})

test('sliceCols: tabs are expanded before slicing, and always', () => {
  expect(sliceCols('ab\tc', 0)).toBe('ab      c')
  expect(sliceCols('ab\tc', 4)).toBe('    c')
  expect(sliceCols('\tx', 1)).toBe(' x')
  expect(sliceCols('ab\tc', 9)).toBe('')
})

test('sliceCols: a surrogate pair is never split', () => {
  expect(sliceCols('😀ab', 2)).toBe('ab')
  expect(sliceCols('a😀b', 1)).toBe('😀b')
  expect(sliceCols('a𝒳b', 1)).toBe('𝒳b')
  expect(sliceCols('a𝒳b', 2)).toBe('b')
})

test('sliceCols: wide chars take 2 columns, a halved one leaves a space', () => {
  expect(widthOf('中'.codePointAt(0)!)).toBe(2)
  expect(widthOf('😀'.codePointAt(0)!)).toBe(2)
  expect(widthOf('é'.codePointAt(0)!)).toBe(1)
  expect(sliceCols('中文ab', 2)).toBe('文ab')
  expect(sliceCols('中文ab', 1)).toBe(' 文ab')
  expect(sliceCols('😀ab', 1)).toBe(' ab')
})

test('sliceCols: a combining mark stays with its char', () => {
  expect(sliceCols('xéz', 1)).toBe('éz')
  expect(sliceCols('xéz', 2)).toBe('z')
})

test('widest: the widest line in columns, tabs and wide chars counted', () => {
  expect(widest([])).toBe(0)
  expect(widest(['abc', '', 'abcdef'])).toBe(6)
  expect(widest(['ab\tc', 'abcdefg'])).toBe(9)
  expect(widest(['中文中文', 'abcdefg'])).toBe(8)
  expect(widest(['😀😀', 'abc'])).toBe(4)
})

const PATCH = [
  'diff --git a/x.ts b/x.ts',
  'index 1111111..2222222 100644',
  '--- a/x.ts',
  '+++ b/x.ts',
  '@@ -1,3 +1,3 @@ section',
  ' context line',
  '-removed line',
  '+added line',
  ' tail line',
  '@@ -10,2 +10,2 @@',
  '---foo removed',
  '+++bar added',
  '\\ No newline at end of file',
  ' \tlast',
].join('\n')

test('sliceDiffCols: hunks, headers and markers stay, the content is sliced', () => {
  const out = sliceDiffCols(PATCH, 2).split('\n')
  expect(out).toEqual([
    'diff --git a/x.ts b/x.ts',
    'index 1111111..2222222 100644',
    '--- a/x.ts',
    '+++ b/x.ts',
    '@@ -1,3 +1,3 @@ section',
    ' ntext line',
    '-moved line',
    '+ded line',
    ' il line',
    '@@ -10,2 +10,2 @@',
    '-foo removed',
    '+bar added',
    '\\ No newline at end of file',
    ' last',
  ])
  expect(out.filter(line => line.startsWith('@@'))).toHaveLength(2)
})

test('sliceDiffCols: a removed line starting with -- inside a hunk is a body line', () => {
  const patch = '--- a/f\n+++ b/f\n@@ -1,2 +1,1 @@\n---foo\n--- bar\n+x'
  expect(sliceDiffCols(patch, 1)).toBe('--- a/f\n+++ b/f\n@@ -1,2 +1,1 @@\n--foo\n-- bar\n+')
})

test('sliceDiffCols: left 0 keeps the diff, tabs expanded after the marker', () => {
  expect(sliceDiffCols(PATCH.replace(' \tlast', ' last'), 0)).toBe(
    PATCH.replace(' \tlast', ' last'),
  )
  expect(sliceDiffCols('@@ -1 +1 @@\n-a\tb\n+\t\tc', 0)).toBe('@@ -1 +1 @@\n-a       b\n+    c')
})

test('sliceDiffCols: past every line leaves only the markers', () => {
  expect(sliceDiffCols('@@ -1 +1 @@\n-abc\n+de', 99)).toBe('@@ -1 +1 @@\n-\n+')
})

test('sliceRuns: a row scrolled sideways, cut to the room', () => {
  const runs = [{ text: '│ ', c: 'rail' }, { text: '▸ ', c: 'arrow' }, { text: 'name.txt', c: 'label' }]
  expect(sliceRuns(runs, 0, 99)).toEqual(runs)
  expect(sliceRuns(runs, 0, 6)).toEqual([{ text: '│ ', c: 'rail' }, { text: '▸ ', c: 'arrow' }, { text: 'na', c: 'label' }])
  expect(sliceRuns(runs, 3, 4)).toEqual([{ text: ' ', c: 'arrow' }, { text: 'nam', c: 'label' }])
  expect(sliceRuns(runs, 4, 99)).toEqual([{ text: 'name.txt', c: 'label' }])
  expect(sliceRuns(runs, 99, 10)).toEqual([])
  // a wide char cut at either edge leaves a space
  expect(sliceRuns([{ text: 'a漢b' }], 2, 99)).toEqual([{ text: ' b' }])
  expect(sliceRuns([{ text: 'a漢b' }], 0, 2)).toEqual([{ text: 'a ' }])
})
