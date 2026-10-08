import { expect, test } from 'claude-code/testing'

import {
  afterDelete,
  changeMarks,
  clip,
  deleteTarget,
  dirsAbove,
  filters,
  flatten,
  isBinary,
  languageOf,
  markOf,
  newFilePath,
  relativePath,
  rowHit,
  window,
} from './tree'
import type { Entry, Row } from './tree'

const file = (name: string): Entry => ({ name, kind: 'file', size: 1 })
const dir = (name: string): Entry => ({ name, kind: 'dir', size: 0 })

const listings = new Map<string, Entry[]>([
  ['/p', [file('b.txt'), dir('src'), file('A.md'), dir('.git'), dir('Docs')]],
  ['/p/src', [file('z.ts'), dir('inner'), file('a.ts')]],
  ['/p/src/inner', [file('deep.ts')]],
])

const rowsOf = (n: number): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    path: `/r/${i}`,
    name: String(i),
    depth: 0,
    kind: 'file' as const,
    isExpanded: false,
  }))

test('flatten sorts dirs first, then names case-insensitively', () => {
  const rows = flatten(listings, new Set(), '/p')
  expect(rows.map(row => row.name)).toEqual(['Docs', 'src', 'A.md', 'b.txt'])
})

test('flatten hides .git in both modes', () => {
  for (const mode of ['files', 'unity'] as const) {
    const rows = flatten(listings, new Set(), '/p', { mode })
    expect(rows.some(row => row.name === '.git')).toBe(false)
  }
})

test('flatten nests expanded dirs with depth', () => {
  const expanded = new Set(['/p/src', '/p/src/inner'])
  const rows = flatten(listings, expanded, '/p')
  expect(rows.map(row => [row.name, row.depth])).toEqual([
    ['Docs', 0],
    ['src', 0],
    ['inner', 1],
    ['deep.ts', 2],
    ['a.ts', 1],
    ['z.ts', 1],
    ['A.md', 0],
    ['b.txt', 0],
  ])
  expect(rows[1]?.isExpanded).toBe(true)
  expect(rows[0]?.isExpanded).toBe(false)
})

test('flatten shows nothing under an expanded dir without a listing', () => {
  const rows = flatten(listings, new Set(['/p/Docs']), '/p')
  expect(rows.map(row => row.name)).toEqual(['Docs', 'src', 'A.md', 'b.txt'])
  expect(rows[0]?.isExpanded).toBe(true)
})

test('filters: one per mode', () => {
  expect(filters.files(dir('.git'), '/p', '/p')).toBe(false)
  expect(filters.unity(file('x'), '/p/Assets', '/p')).toBe(true)
  expect(filters.unity(file('x'), '/p', '/p')).toBe(false)
})

// Shaped like ../unity-playground.
const unity = new Map<string, Entry[]>([
  [
    '/u',
    [
      dir('Assets'),
      dir('Library'),
      dir('Logs'),
      dir('Packages'),
      dir('ProjectSettings'),
      dir('Temp'),
      dir('UserSettings'),
      dir('.git'),
      file('Assembly-CSharp.csproj'),
      file('unity-playground.slnx'),
    ],
  ],
  [
    '/u/Assets',
    [
      dir('Scenes'),
      file('Scenes.meta'),
      dir('Build'),
      dir('BuildOutput'),
      dir('obj'),
      dir('Temp'),
      dir('Library'),
      dir('Logs'),
      dir('UserSettings'),
      dir('Builder2'),
    ],
  ],
  ['/u/Assets/Scenes', [file('SampleScene.unity'), file('SampleScene.unity.meta')]],
])
const unityExpanded = new Set(['/u/Assets', '/u/Assets/Scenes'])

test('unity mode shows only Assets, Packages and ProjectSettings at the top', () => {
  const rows = flatten(unity, new Set(), '/u', { mode: 'unity' })
  expect(rows.map(row => row.name)).toEqual(['Assets', 'Packages', 'ProjectSettings'])
})

test('unity mode hides .meta and noise dirs at any depth', () => {
  const rows = flatten(unity, unityExpanded, '/u', { mode: 'unity' })
  expect(rows.map(row => row.path)).toEqual([
    '/u/Assets',
    '/u/Assets/Scenes',
    '/u/Assets/Scenes/SampleScene.unity',
    '/u/Packages',
    '/u/ProjectSettings',
  ])
  expect(rows.some(row => row.name.endsWith('.meta'))).toBe(false)
})

test('files mode on a Unity tree shows everything but .git', () => {
  const rows = flatten(unity, unityExpanded, '/u', { mode: 'files' })
  const top = rows.filter(row => row.depth === 0).map(row => row.name)
  expect(top).toEqual([
    'Assets',
    'Library',
    'Logs',
    'Packages',
    'ProjectSettings',
    'Temp',
    'UserSettings',
    'Assembly-CSharp.csproj',
    'unity-playground.slnx',
  ])
  expect(rows.map(row => row.name)).toContain('SampleScene.unity.meta')
  expect(rows.map(row => row.name)).toContain('Scenes.meta')
  expect(rows.map(row => row.name)).toContain('Build')
})

test('window shows everything when it fits', () => {
  const win = window(rowsOf(3), 2, 10)
  expect(win.offset).toBe(0)
  expect(win.rows).toHaveLength(3)
})

test('window keeps the selection visible at both edges', () => {
  const rows = rowsOf(20)
  expect(window(rows, 0, 5).offset).toBe(0)
  expect(window(rows, 19, 5).offset).toBe(15)
  expect(window(rows, 19, 5).rows.map(row => row.name)).toEqual([
    '15', '16', '17', '18', '19',
  ])
})

test('window scrolls one row at a time and keeps a margin', () => {
  const rows = rowsOf(20)
  // selection reaches the last visible row: one more row comes into view
  const down = window(rows, 4, 5, 0)
  expect(down.offset).toBe(1)
  expect(down.rows.at(-1)?.name).toBe('5')
  // and back up
  const up = window(rows, 1, 5, 1)
  expect(up.offset).toBe(0)
})

test('window with no selection clamps the offset', () => {
  expect(window(rowsOf(20), -1, 5, 99).offset).toBe(15)
  expect(window([], -1, 5).rows).toEqual([])
})

test('languageOf maps extensions', () => {
  expect(languageOf('a.ts')).toBe('typescript')
  expect(languageOf('A.CS')).toBe('csharp')
  expect(languageOf('Makefile')).toBeUndefined()
})

test('isBinary sniffs for NUL', () => {
  expect(isBinary('plain text')).toBe(false)
  expect(isBinary('ab\0cd')).toBe(true)
})

test('clip caps lines', () => {
  expect(clip('a\nb\nc', 2)).toBe('a\nb')
})

test('newFilePath nests under the base dir', () => {
  expect(newFilePath('/p/src', 'a/b.ts', '/p')).toEqual({ path: '/p/src/a/b.ts' })
  expect(newFilePath('/p', '  ./x.ts ', '/p')).toEqual({ path: '/p/x.ts' })
  expect(newFilePath('/', 'x.ts', '/')).toEqual({ path: '/x.ts' })
})

test('newFilePath refuses empty, absolute, `..`, a dir and outside the root', () => {
  const refused = (base: string, name: string) => 'error' in newFilePath(base, name, '/p')
  expect(refused('/p', '   ')).toBe(true)
  expect(refused('/p', './')).toBe(true)
  expect(refused('/p', '/etc/x')).toBe(true)
  expect(refused('/p', '~/x')).toBe(true)
  expect(refused('/p', '../x')).toBe(true)
  expect(refused('/p', 'a/../../x')).toBe(true)
  expect(refused('/p', 'a/')).toBe(true)
  expect(refused('/q', 'x.ts')).toBe(true)
  expect(refused('/pp', 'x.ts')).toBe(true)
})

test('deleteTarget refuses the root, outside it and odd segments', () => {
  expect(deleteTarget('/p/src', '/p')).toEqual({ path: '/p/src' })
  expect(deleteTarget('/p/src/a.ts', '/p/')).toEqual({ path: '/p/src/a.ts' })
  expect(deleteTarget('/x.ts', '/')).toEqual({ path: '/x.ts' })
  const refused = (path: string, root = '/p') => 'error' in deleteTarget(path, root)
  expect(refused('/p')).toBe(true)
  expect(refused('/p/')).toBe(true)
  expect(refused('/', '/')).toBe(true)
  expect(refused('')).toBe(true)
  expect(refused('/p/x', '')).toBe(true)
  expect(refused('/pq/x')).toBe(true)
  expect(refused('/etc/passwd')).toBe(true)
  expect(refused('/p/../etc')).toBe(true)
  expect(refused('/p/src/./a')).toBe(true)
  expect(refused('/p//a')).toBe(true)
})

test('afterDelete selects the next sibling, else the previous, else the parent', () => {
  const rows = flatten(listings, new Set(['/p/src', '/p/src/inner']), '/p')
  // Docs, src (inner (deep.ts), a.ts, z.ts), A.md, b.txt
  expect(afterDelete(rows, '/p/src')).toBe('/p/A.md')
  expect(afterDelete(rows, '/p/src/inner')).toBe('/p/src/a.ts')
  expect(afterDelete(rows, '/p/src/z.ts')).toBe('/p/src/a.ts')
  expect(afterDelete(rows, '/p/src/inner/deep.ts')).toBe('/p/src/inner')
  expect(afterDelete(rows, '/p/b.txt')).toBe('/p/A.md')
  expect(afterDelete(rows, '/p/gone')).toBeUndefined()
  const only = flatten(new Map([['/q', [file('one')]]]), new Set(), '/q')
  expect(afterDelete(only, '/q/one')).toBeUndefined()
})

test('relativePath names a path from the repo toplevel', () => {
  expect(relativePath('/r/hooks/explorer-panel', '/r')).toBe('hooks/explorer-panel')
  expect(relativePath('/r/a.ts', '/r/')).toBe('a.ts')
  expect(relativePath('/r', '/r')).toBe('.')
  expect(relativePath('/r', '/r/')).toBe('.')
  expect(relativePath('/rx/a.ts', '/r')).toBe('/rx/a.ts')
  expect(relativePath('/elsewhere/a.ts', '/r')).toBe('/elsewhere/a.ts')
  expect(relativePath('/a.ts', '/')).toBe('a.ts')
})

test('rowHit splits a row into mark, rails, arrow and name', () => {
  // depth 0 dir: `▌▸ name`
  expect(rowHit(0, 'dir', 0)).toBe('mark')
  expect(rowHit(0, 'dir', 1)).toBe('arrow')
  expect(rowHit(0, 'dir', 2)).toBe('arrow')
  expect(rowHit(0, 'dir', 3)).toBe('name')
  // depth 2 dir: `▌│ │ ▸ name`: rails 1..4, arrow 5..6
  expect(rowHit(2, 'dir', 1)).toBe('name')
  expect(rowHit(2, 'dir', 4)).toBe('name')
  expect(rowHit(2, 'dir', 5)).toBe('arrow')
  expect(rowHit(2, 'dir', 6)).toBe('arrow')
  expect(rowHit(2, 'dir', 7)).toBe('name')
  // a file has no arrow
  expect(rowHit(0, 'file', 0)).toBe('mark')
  expect(rowHit(0, 'file', 1)).toBe('name')
  expect(rowHit(1, 'file', 3)).toBe('name')
})

test('changeMarks: + for added, * for edited and every dir above a change', () => {
  const marks = changeMarks(
    [
      { path: 'src/new.ts', kind: 'added' },
      { path: 'src/ui/old.ts', kind: 'modified' },
      { path: 'gone.ts', kind: 'deleted' },
      { path: 'docs/drafts/', kind: 'added' },
    ],
    '/repo',
  )
  expect(markOf('/repo/src/new.ts', marks)).toBe('+')
  expect(markOf('/repo/src/ui/old.ts', marks)).toBe('*')
  expect(markOf('/repo/src/ui', marks)).toBe('*')
  expect(markOf('/repo/src', marks)).toBe('*')
  // a deleted file has no row; its dir still changed
  expect(markOf('/repo/gone.ts', marks)).toBeUndefined()
  // a dir untracked as a whole is new, with everything under it
  expect(markOf('/repo/docs/drafts', marks)).toBe('+')
  expect(markOf('/repo/docs/drafts/a/b.md', marks)).toBe('+')
  expect(markOf('/repo/docs', marks)).toBe('*')
  expect(markOf('/repo/README.md', marks)).toBeUndefined()
  // the toplevel is no row: never marked
  expect(markOf('/repo', marks)).toBeUndefined()
})

test('changeMarks: a toplevel of / ends its walk', () => {
  const marks = changeMarks([{ path: 'etc/hosts', kind: 'modified' }], '/')
  expect(markOf('/etc/hosts', marks)).toBe('*')
  expect(markOf('/etc', marks)).toBe('*')
})

test('dirsAbove: the dirs between the root and a path, outermost first', () => {
  expect(dirsAbove('/p/a/b/c.ts', '/p')).toEqual(['/p/a', '/p/a/b'])
  expect(dirsAbove('/p/c.ts', '/p')).toEqual([])
})
