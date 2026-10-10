import { colsOf, widthOf } from '../shared/hscroll'
import { CODE_MAX_CHARS } from './preview'

export type Mode = 'files' | 'unity'

export type Entry = {
  name: string
  kind: 'file' | 'dir' | 'other'
  size: number
}

export type Row = {
  path: string
  name: string
  depth: number
  kind: Entry['kind']
  isExpanded: boolean
}

// Decides whether an entry of `parentPath` is shown. `root` is the tree's
// root, so a filter can tell the top level apart.
type EntryFilter = (entry: Entry, parentPath: string, root: string) => boolean

// Files mode: everything but `.git`.
const hideGit: EntryFilter = entry => entry.name !== '.git'

const UNITY_TOP = new Set(['Assets', 'Packages', 'ProjectSettings'])
const UNITY_NOISE = new Set(['Library', 'Temp', 'Logs', 'obj', 'UserSettings'])

// Unity: no `.git` or `.meta`; the top level shows only Assets, Packages and
// ProjectSettings; build and cache dirs are hidden at any depth.
const unityFilter: EntryFilter = (entry, parentPath, root) => {
  if (entry.name === '.git' || entry.name.endsWith('.meta')) return false
  if (parentPath === root) {
    return entry.kind === 'dir' && UNITY_TOP.has(entry.name)
  }
  if (entry.kind !== 'dir') return true

  return !UNITY_NOISE.has(entry.name) && !/^Build/.test(entry.name)
}

export const filters: Record<Mode, EntryFilter> = {
  files: hideGit,
  unity: unityFilter,
}

export const join = (dir: string, name: string): string =>
  dir.endsWith('/') ? dir + name : dir + '/' + name

export const parentOf = (path: string): string => {
  const cut = path.lastIndexOf('/')

  return cut <= 0 ? '/' : path.slice(0, cut)
}

// The dirs between `root` and `path`, outermost first (neither included).
export const dirsAbove = (path: string, root: string): string[] => {
  const dirs: string[] = []
  for (let dir = parentOf(path); dir.length > root.length; dir = parentOf(dir)) dirs.unshift(dir)

  return dirs
}

const byName = (a: Entry, b: Entry): number => {
  const left = a.name.toLowerCase()
  const right = b.name.toLowerCase()

  return left < right ? -1 : left > right ? 1 : a.name < b.name ? -1 : 1
}

// Dirs first, then case-insensitive name order.
const sortEntries = (entries: readonly Entry[]): Entry[] => [
  ...entries.filter(entry => entry.kind === 'dir').sort(byName),
  ...entries.filter(entry => entry.kind !== 'dir').sort(byName),
]

type FlattenOptions = {
  mode?: Mode
}

// The visible rows, depth first. A dir whose listing is not cached shows no
// children even when expanded.
export const flatten = (
  listings: ReadonlyMap<string, readonly Entry[]>,
  expanded: ReadonlySet<string>,
  root: string,
  options: FlattenOptions = {},
): Row[] => {
  const mode = options.mode ?? 'files'
  const filter = filters[mode]
  const rows: Row[] = []
  const walk = (dir: string, depth: number): void => {
    const entries = listings.get(dir) ?? []
    const shown = entries.filter(entry => filter(entry, dir, root))
    for (const entry of sortEntries(shown)) {
      const path = join(dir, entry.name)
      const isExpanded = entry.kind === 'dir' && expanded.has(path)
      rows.push({ path, name: entry.name, depth, kind: entry.kind, isExpanded })
      if (isExpanded) walk(path, depth + 1)
    }
  }
  walk(root, 0)

  return rows
}

type Window<T = Row> = { offset: number; rows: T[] }

// The slice of `height` rows that keeps `selectedIndex` visible with `margin`
// rows of context beyond it. Starts from `offset` so scrolling is minimal.
export const window = <T = Row>(
  rows: readonly T[],
  selectedIndex: number,
  height: number,
  offset = 0,
  margin = 1,
): Window<T> => {
  const room = Math.max(1, Math.floor(height))
  const last = Math.max(0, rows.length - room)
  let start = Math.min(Math.max(0, offset), last)
  if (selectedIndex >= 0) {
    const m = Math.min(margin, Math.floor((room - 1) / 2))
    if (selectedIndex - m < start) start = selectedIndex - m
    if (selectedIndex + m > start + room - 1) start = selectedIndex + m - room + 1
    start = Math.min(Math.max(0, start), last)
  }

  return { offset: start, rows: rows.slice(start, start + room) }
}

const LANGUAGES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  md: 'markdown',
  py: 'python',
  cs: 'csharp',
  sh: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  html: 'html',
  css: 'css',
  xml: 'xml',
  rs: 'rust',
  go: 'go',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  sql: 'sql',
}

// Highlighter language for a file name; undefined lets `Code` infer from path.
export const languageOf = (name: string): string | undefined => {
  const dot = name.lastIndexOf('.')

  return dot < 0 ? undefined : LANGUAGES[name.slice(dot + 1).toLowerCase()]
}

export const MAX_PREVIEW_BYTES = 4 * 1024 * 1024
const SNIFF_CHARS = 8192

// Text with a NUL in its first 8 KiB is treated as binary.
export const isBinary = (text: string): boolean =>
  text.slice(0, SNIFF_CHARS).includes('\0')

export const formatSize = (bytes: number): string =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KiB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MiB`

// Code's `source` is capped at CODE_MAX_CHARS; keep the first `lines` lines.
export const clip = (text: string, lines: number, chars = CODE_MAX_CHARS): string => {
  const kept = text.split('\n').slice(0, Math.max(1, lines)).join('\n')

  return kept.length > chars ? kept.slice(0, chars) : kept
}

// A tree row's label cut to `width` columns, its last kept column a `…` when
// cut (wide chars count 2, so it never paints wider), so a narrow Files keeps
// each row on one line. A `width` under 1 leaves just the `…`.
export const fitLabel = (label: string, width: number): string => {
  const room = Math.max(1, Math.floor(width))
  if (colsOf(label) <= room) return label
  let out = ''
  let used = 0
  for (const ch of label) {
    const w = widthOf(ch.codePointAt(0)!)
    if (used + w > room - 1) break
    out += ch
    used += w
  }

  return out + '…'
}

// `path` as named from `base` (the repo's toplevel): `base` itself is `.`, a
// path outside it stays as given.
export const relativePath = (path: string, base: string): string => {
  const trimmed = base.length > 1 && base.endsWith('/') ? base.slice(0, -1) : base
  if (path === trimmed) return '.'
  const inside = trimmed.endsWith('/') ? trimmed : trimmed + '/'

  return path.startsWith(inside) ? path.slice(inside.length) : path
}

export type RowHit = 'arrow' | 'name'

// What column `x` of a tree row is: the arrow's 2 cells (a dir's; past cell 0,
// the selection bar, and a rail (`│ `) per depth level) or else the name.
export const rowHit = (depth: number, kind: Entry['kind'], x: number): RowHit => {
  const arrow = 1 + 2 * Math.max(0, depth)

  return kind === 'dir' && x >= arrow && x < arrow + 2 ? 'arrow' : 'name'
}

// A tree row's change mark: `+` added, `*` edited.
export type ChangeMark = '+' | '*'

// The tree's change marks from `git status --porcelain --untracked-files=normal`
// (paths from the repo toplevel `top`): `paths` holds `+` for an added file
// (untracked or staged new) and `*` for an edited one (modified, renamed,
// copied) and for every dir above a change, deleted ones included; `newDirs`
// are the dirs git reports untracked whole (`?? dir/`), `+` with everything
// under them.
export type ChangeMarks = { paths: Map<string, ChangeMark>; newDirs: string[] }

export const changeMarks = (
  changes: readonly { path: string; kind: 'added' | 'modified' | 'deleted' }[],
  top: string,
): ChangeMarks => {
  const base = top.endsWith('/') ? top.slice(0, -1) : top
  const paths = new Map<string, ChangeMark>()
  const newDirs: string[] = []
  for (const change of changes) {
    const isDir = change.path.endsWith('/')
    const path = base + '/' + (isDir ? change.path.slice(0, -1) : change.path)
    if (isDir && change.kind === 'added') newDirs.push(path)
    if (change.kind !== 'deleted') paths.set(path, change.kind === 'added' ? '+' : '*')
    for (let dir = parentOf(path); dir.length > base.length + 1 && dir.startsWith(base + '/'); dir = parentOf(dir)) {
      if (!paths.has(dir)) paths.set(dir, '*')
    }
  }

  return { paths, newDirs }
}

// The mark of `path`, if any: its own, else `+` inside a dir new as a whole.
export const markOf = (path: string, marks: ChangeMarks): ChangeMark | undefined =>
  marks.paths.get(path) ?? (marks.newDirs.some(dir => path.startsWith(dir + '/')) ? '+' : undefined)

// The names whose entry was added, removed or changed (kind or size) between
// two listings of one dir; empty when nothing a drawing shows moved.
export const changedEntries = (before: readonly Entry[], after: readonly Entry[]): string[] => {
  const was = new Map(before.map(entry => [entry.name, entry]))
  const now = new Map(after.map(entry => [entry.name, entry]))
  const names = new Set<string>()
  for (const [name, entry] of was) {
    const other = now.get(name)
    if (other === undefined || other.kind !== entry.kind || other.size !== entry.size) names.add(name)
  }
  for (const name of now.keys()) if (!was.has(name)) names.add(name)

  return [...names]
}

// The paths whose change mark differs between two looks at the working tree
// (a dir untracked as a whole by its own path).
export const changedMarks = (before: ChangeMarks, after: ChangeMarks): string[] => {
  const paths = new Set<string>()
  for (const [path, mark] of before.paths) if (after.paths.get(path) !== mark) paths.add(path)
  for (const [path, mark] of after.paths) if (before.paths.get(path) !== mark) paths.add(path)
  for (const dir of before.newDirs) if (!after.newDirs.includes(dir)) paths.add(dir)
  for (const dir of after.newDirs) if (!before.newDirs.includes(dir)) paths.add(dir)

  return [...paths]
}
