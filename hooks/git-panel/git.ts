// The git view's pane id: it draws the panel alone (the tests mount it); the
// split pane `ide-split` is what `/ide-panels` opens.
export const GIT_PANE = 'ide-git'

export type Branch = {
  name: string
  sha: string
  upstream?: string
  track?: string
  isHead: boolean
  isRemote: boolean
}

export type Commit = {
  sha: string
  short: string
  parents: string[]
  refs: string[]
  author: string
  date: string
  subject: string
}

const SEP = '\x1f'
const LOCAL = 'refs/heads/'
const REMOTE = 'refs/remotes/'

const BRANCH_FORMAT =
  '%(HEAD)%1f%(refname)%1f%(objectname:short)%1f%(upstream:short)%1f%(upstream:track)'

const LOG_FORMAT = '%H%x1f%h%x1f%P%x1f%D%x1f%an%x1f%ad%x1f%s'

const SHOW_FORMAT = '%H%n%an <%ae>%n%ad%n%n%B'

const lines = (stdout: string): string[] =>
  stdout.split('\n').filter(line => line !== '')

// `refname` is the full ref name, so a local `fix/x` is told from a remote
// `origin/x`. Local branches come first; `origin/HEAD` is skipped.
export const parseBranches = (stdout: string): Branch[] => {
  const local: Branch[] = []
  const remote: Branch[] = []
  for (const line of lines(stdout)) {
    const [head = '', ref = '', sha = '', upstream = '', track = ''] =
      line.split(SEP)
    if (ref.startsWith(LOCAL)) {
      local.push({
        name: ref.slice(LOCAL.length),
        sha,
        upstream: upstream === '' ? undefined : upstream,
        track: track === '' ? undefined : track,
        isHead: head === '*',
        isRemote: false,
      })
    } else if (ref.startsWith(REMOTE)) {
      const name = ref.slice(REMOTE.length)
      if (name.endsWith('/HEAD') || !name.includes('/')) continue
      remote.push({ name, sha, isHead: false, isRemote: true })
    }
  }

  return [...local, ...remote]
}

// `%D` decorations: `HEAD -> develop, origin/develop, tag: v1`.
export const parseRefs = (decoration: string): string[] =>
  decoration === ''
    ? []
    : decoration
        .split(', ')
        .map(ref => ref.trim())
        .filter(ref => ref !== '' && !ref.endsWith('/HEAD'))

// One commit per line: `LOG_FORMAT` fields split by the separator. A line
// with fewer fields (an error message) is skipped.
export const parseLog = (stdout: string): Commit[] => {
  const commits: Commit[] = []
  for (const raw of stdout.split('\n')) {
    const parts = raw.split(SEP)
    if (parts.length < 7) continue
    const [sha = '', short = '', parents = '', refs = '', author = '', date = ''] =
      parts
    commits.push({
      sha,
      short,
      parents: parents.split(' ').filter(parent => parent !== ''),
      refs: parseRefs(refs),
      author,
      date,
      // a subject cannot hold the separator, but keep any stray tail
      subject: parts.slice(6).join(SEP),
    })
  }

  return commits
}

// Where a commit sits in the graph: `cells` are the glyphs of every lane
// (2 characters per lane), each with the color index of its lane-run; `color`
// is the commit's own lane color, kept even when its lane collapses into `…`.
type GraphCell = { glyph: string; color: number }
export type GraphRow = { commit: Commit; lane: number; color: number; cells: GraphCell[] }

export const PALETTE_SIZE = 8

// Lanes from parent hashes, one row per commit (`commits` newest first, parents
// after their children, as `--topo-order`). A lane expects the sha of the next
// commit it will meet. A commit takes the first lane expecting it (else a free
// one); other lanes expecting it close into it (`╯`). Its lane then expects the
// first parent; every other parent joins a lane already expecting it (`┤`/`├`)
// or opens a free one to the right (`╮`). A lane keeps its color from open to
// close. Lanes at or past `maxLanes` collapse into one `…` cell.
export const layoutGraph = (
  commits: readonly Commit[],
  maxLanes = Infinity,
): GraphRow[] => {
  const lanes: (string | null)[] = []
  const colors: number[] = []
  let runs = 0
  const rows: GraphRow[] = []
  for (const commit of commits) {
    const closing: number[] = []
    lanes.forEach((sha, i) => {
      if (sha === commit.sha) closing.push(i)
    })
    let lane = closing[0] ?? lanes.indexOf(null)
    if (lane < 0) lane = lanes.length
    if (closing.length === 0) colors[lane] = runs++
    const above = [...lanes]
    const spans: { to: number; glyph: string; color: number }[] = []
    for (const i of closing.slice(1)) {
      spans.push({ to: i, glyph: '╯', color: colors[i] ?? 0 })
      lanes[i] = null
    }
    const [first, ...others] = commit.parents
    lanes[lane] = first ?? null
    for (const parent of others) {
      const at = lanes.findIndex((sha, i) => sha === parent && i !== lane)
      if (at >= 0) {
        spans.push({ to: at, glyph: at > lane ? '┤' : '├', color: colors[at] ?? 0 })
        continue
      }
      // a free lane to the right, not one closing on this row
      let free = lanes.findIndex((sha, i) => sha === null && i > lane && !closing.includes(i))
      if (free < 0) free = lanes.length
      lanes[free] = parent
      colors[free] = runs++
      spans.push({ to: free, glyph: '╮', color: colors[free] ?? 0 })
    }
    const width = Math.max(above.length, lanes.length, lane + 1)
    const cells: GraphCell[] = Array.from({ length: width * 2 }, () => ({ glyph: ' ', color: 0 }))
    // lanes passing through, as they were above this row
    for (let i = 0; i < above.length; i++) {
      if (above[i] != null && i !== lane && !closing.includes(i)) {
        cells[i * 2] = { glyph: '│', color: colors[i] ?? 0 }
      }
    }
    const at = (i: number, glyph: string, color: number): void => {
      cells[i] = { glyph, color }
    }
    // horizontals first, so ends and the commit are drawn over them
    for (const span of spans) {
      const [lo, hi] = span.to > lane ? [lane, span.to] : [span.to, lane]
      for (let c = lo * 2 + 1; c < hi * 2; c++) {
        const cell = cells[c]
        if (cell === undefined) continue
        at(c, c % 2 === 0 && cell.glyph === '│' ? '┼' : '─', span.color)
      }
    }
    for (const span of spans) at(span.to * 2, span.glyph, span.color)
    const color = colors[lane] ?? 0
    at(lane * 2, commit.parents.length > 1 ? '○' : '●', color)
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
      lanes.pop()
      colors.pop()
    }
    rows.push({ commit, lane, color, cells: collapse(cells, lane, maxLanes) })
  }

  return rows
}

// Lanes past `maxLanes` become one `…` cell (the commit glyph if it is there).
const collapse = (cells: GraphCell[], lane: number, maxLanes: number): GraphCell[] => {
  const keep = Math.max(1, Math.floor(maxLanes)) * 2
  if (cells.length <= keep) return cells
  const rest = cells.slice(keep)
  const commit = lane * 2 >= keep ? cells[lane * 2] : undefined
  const isUsed = rest.some(cell => cell.glyph !== ' ')

  return [
    ...cells.slice(0, keep),
    ...(isUsed ? [commit ?? { glyph: '…', color: 0 }, { glyph: ' ', color: 0 }] : []),
  ]
}

// The cells as colored text runs, padded with blanks to `width` characters.
export const cellRuns = (
  cells: readonly GraphCell[],
  width: number,
): { text: string; color: number }[] => {
  const runs: { text: string; color: number }[] = []
  for (const cell of cells) {
    const last = runs[runs.length - 1]
    if (last !== undefined && last.color === cell.color) last.text += cell.glyph
    else runs.push({ text: cell.glyph, color: cell.color })
  }
  const pad = width - cells.length
  if (pad > 0) runs.push({ text: ' '.repeat(pad), color: 0 })

  return runs
}

// The commit's info head: the `git show` head lines with parents and refs
// after the author and date lines, then the branches containing it (when
// known): `local` and `remote` lines, each left out when empty, the HEAD
// branch `head` marked `*`.
export const infoHead = (
  shown: readonly string[],
  commit: Commit,
  branches?: Contains,
  head?: string,
): string[] => [
  ...shown.slice(0, 3),
  'parents ' + (commit.parents.length === 0 ? '(none)' : commit.parents.map(p => p.slice(0, 7)).join(' ')),
  ...(commit.refs.length === 0 ? [] : ['refs ' + commit.refs.join(', ')]),
  ...(branches === undefined || branches.local.length === 0
    ? []
    : ['local  ' + branches.local.map(name => (name === head ? '*' + name : name)).join(', ')]),
  ...(branches === undefined || branches.remote.length === 0
    ? []
    : ['remote ' + branches.remote.join(', ')]),
  ...shown.slice(3).filter((line, i) => i > 0 || line !== ''),
]

// `git show --stat --format=SHOW_FORMAT`: the whole output as text lines.
export const splitShow = (stdout: string): string[] =>
  stdout.replace(/\n+$/, '').split('\n')

// `git log --topo-order` (children before parents) and `git show` argv builders.
export const logArgv = (ref: string, limit: number): string[] => [
  'git',
  'log',
  '--topo-order',
  '--color=never',
  '--date=short',
  '-n',
  String(limit),
  '--format=' + LOG_FORMAT,
  ref === 'all' ? '--all' : ref,
]

export const branchesArgv = (): string[] => [
  'git',
  'for-each-ref',
  '--format=' + BRANCH_FORMAT,
  'refs/heads',
  'refs/remotes',
]

export const statArgv = (sha: string): string[] => [
  'git',
  'show',
  '--stat',
  '--color=never',
  '--format=' + SHOW_FORMAT,
  sha,
]

export const patchArgv = (sha: string): string[] => [
  'git',
  '-c',
  'core.quotePath=false',
  'show',
  '--color=never',
  '--diff-merges=first-parent',
  '--format=',
  '--patch',
  sha,
]

// "[ahead 1, behind 2]" -> "+1 -2"
export const trackLabel = (track: string | undefined): string => {
  if (track === undefined) return ''
  const ahead = /ahead (\d+)/.exec(track)?.[1]
  const behind = /behind (\d+)/.exec(track)?.[1]
  if (/gone/.test(track)) return 'gone'

  return [ahead ? '+' + ahead : '', behind ? '-' + behind : '']
    .filter(Boolean)
    .join(' ')
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/

type Parsed = {
  kind: 'file' | 'hunk' | 'body'
  // file lines: index of the `diff` line opening the block
  block: number
  // body lines: the hunk header's index and the old/new numbers of the line
  head: number
  old: number
  next: number
}

// Every line of a diff told apart: hunk headers, file header lines (`diff`,
// `index`, `---`, `+++`, ...) and hunk body lines. Bodies are followed by the
// header's counts, so a removed `-- x` is not taken for a `---` line.
const parseDiff = (all: readonly string[]): Parsed[] => {
  const parsed: Parsed[] = []
  let block = 0
  let head = -1
  let left = { old: 0, next: 0 }
  let old = 0
  let next = 0
  all.forEach((line, i) => {
    const isBody = left.old > 0 || left.next > 0
    if (isBody && !HUNK.test(line)) {
      parsed.push({ kind: 'body', block, head, old, next })
      if (line.startsWith('-')) {
        left.old--
        old++
      } else if (line.startsWith('+')) {
        left.next--
        next++
      } else if (line.startsWith(' ')) {
        left.old--
        left.next--
        old++
        next++
      }

      return
    }
    const match = HUNK.exec(line)
    if (match !== null) {
      head = i
      old = Number(match[1])
      next = Number(match[3])
      left = {
        old: match[2] === undefined ? 1 : Number(match[2]),
        next: match[4] === undefined ? 1 : Number(match[4]),
      }
      parsed.push({ kind: 'hunk', block, head, old, next })

      return
    }
    if (line.startsWith('diff ')) block = i
    parsed.push({ kind: 'file', block, head, old, next })
  })

  return parsed
}

type OpenHunk = {
  at: number
  head: number
  old: number
  next: number
  section: string
  context: number
  removed: number
  added: number
  isKept: boolean
}

export const diffLines = (diff: string): string[] =>
  diff === '' ? [] : diff.replace(/\n+$/, '').split('\n')

// The diff's hunk body lines, marker included: the lines `sliceDiffCols`
// (`shared/hscroll.ts`) cuts, so the ones Diff Preview's horizontal bar measures.
export const diffBody = (diff: string): string[] => {
  const all = diffLines(diff)
  const parsed = parseDiff(all)

  return all.filter((_, i) => parsed[i]?.kind === 'body')
}

// Columns `Code format="diff"` draws before a body line's marker (probed live
// on 2.1.289): a blank, the line number right-aligned to the widest one, a
// blank; the `@@` lines take no row. Measured over the whole diff, so a window
// of it may draw a column less. 0 with no body line.
export const diffGutter = (diff: string): number => {
  const all = diffLines(diff)
  let most = -1
  for (const p of parseDiff(all)) {
    if (p.kind === 'body') most = Math.max(most, p.old, p.next)
  }

  return most < 0 ? 0 : String(most).length + 2
}

// `rows` lines of a unified diff from line `offset`, still a valid diff: a hunk
// cut at either end gets its header start/counts rewritten (a hunk entered
// mid-way gets a header of its own), and file header lines are kept only with a
// hunk after them (`Code format="diff"` rejects both). '' when no hunk shows.
export const sliceDiff = (diff: string, offset: number, rows: number): string => {
  const all = diffLines(diff)
  const parsed = parseDiff(all)
  const from = Math.min(Math.max(0, Math.floor(offset)), all.length)
  const to = Math.min(all.length, from + Math.max(1, Math.floor(rows)))
  const out: string[] = []
  let pending: string[] = []
  let open = undefined as OpenHunk | undefined
  const close = (): void => {
    if (open === undefined) return
    const { at, old, next, context, removed, added, isKept } = open
    const oldCount = context + removed
    const newCount = context + added
    if (!isKept) {
      const oldStart = oldCount === 0 ? Math.max(0, old - 1) : old
      const newStart = newCount === 0 ? Math.max(0, next - 1) : next
      out[at] = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${open.section}`
    }
    open = undefined
  }
  const header = (index: number) => HUNK.exec(all[index] ?? '')
  for (let i = from; i < to; i++) {
    const line = all[i] ?? ''
    const p = parsed[i]
    if (p === undefined) continue
    if (p.kind === 'file') {
      close()
      if (line.startsWith('diff ') && p.block === i) pending = []
      if (p.block >= from) pending.push(line)
    } else if (p.kind === 'hunk') {
      close()
      out.push(...pending)
      pending = []
      const match = header(i)
      open = {
        at: out.length,
        head: i,
        old: p.old,
        next: p.next,
        section: match?.[5] ?? '',
        context: 0,
        removed: 0,
        added: 0,
        isKept: true,
      }
      out.push(line)
    } else {
      if (open === undefined || open.head !== p.head) {
        if (line.startsWith('\\')) continue
        close()
        const match = header(p.head)
        open = {
          at: out.length,
          head: p.head,
          old: p.old,
          next: p.next,
          section: match?.[5] ?? '',
          context: 0,
          removed: 0,
          added: 0,
          isKept: false,
        }
        out.push('')
      }
      if (line.startsWith('-')) open.removed++
      else if (line.startsWith('+')) open.added++
      else if (line.startsWith(' ')) open.context++
      out.push(line)
    }
  }
  // a hunk shown from its own header but cut short at the bottom
  if (open !== undefined && open.isKept) {
    const match = header(open.head)
    const oldFull = match?.[2] === undefined ? 1 : Number(match[2])
    const newFull = match?.[4] === undefined ? 1 : Number(match[4])
    if (open.context + open.removed !== oldFull || open.context + open.added !== newFull) {
      open.isKept = false
    }
  }
  close()

  return out.some(line => HUNK.test(line)) ? out.join('\n') : ''
}

// A path list grouped by `/`: a folder or a leaf, with its depth under the
// root. Leaves come before the folders of a level; folders are sorted.
type TreeRow<T> =
  | { kind: 'folder'; key: string; name: string; depth: number; isOpen: boolean }
  | { kind: 'leaf'; item: T; name: string; depth: number }

type Node<T> = { folders: Map<string, Node<T>>; leaves: { name: string; item: T }[] }

const nodeOf = <T>(): Node<T> => ({ folders: new Map(), leaves: [] })

// `collapsed` holds folder keys (`<root>fix`, `<root>fix/sub`) the person closed;
// `root` prefixes every key (`l:`, `r:`, `c:`) so trees do not share keys.
export const pathTree = <T>(
  items: readonly { path: string; item: T }[],
  collapsed: ReadonlySet<string>,
  root: string,
): TreeRow<T>[] => {
  const top = nodeOf<T>()
  for (const { path, item } of items) {
    const parts = path.split('/')
    let node = top
    for (const part of parts.slice(0, -1)) {
      const next = node.folders.get(part) ?? nodeOf<T>()
      node.folders.set(part, next)
      node = next
    }
    node.leaves.push({ name: parts[parts.length - 1] ?? path, item })
  }
  const rows: TreeRow<T>[] = []
  const walk = (node: Node<T>, prefix: string, depth: number): void => {
    for (const leaf of node.leaves) {
      rows.push({ kind: 'leaf', item: leaf.item, name: leaf.name, depth })
    }
    for (const name of [...node.folders.keys()].sort()) {
      const key = prefix + (prefix.endsWith(':') ? '' : '/') + name
      const isOpen = !collapsed.has(key)
      rows.push({ kind: 'folder', key, name, depth, isOpen })
      if (isOpen) walk(node.folders.get(name) as Node<T>, key, depth + 1)
    }
  }
  walk(top, root, 0)

  return rows
}

// One row of the branch list grouped by `/`: a folder or a branch, with its
// depth under the root. Local branches come first, then each remote.
// A category row (`isGroup`: `Local` / `Remote`, keys `l:` / `r:`) heads each
// non-empty group; `count` is its branch count.
export type BranchRow =
  | { kind: 'folder'; key: string; name: string; depth: number; isOpen: boolean; isGroup?: boolean; count?: number }
  | { kind: 'branch'; branch: Branch; name: string; depth: number }

// `collapsed` holds folder keys (`l:fix` / `r:origin/feature`) the person
// closed, and the category keys `l:` / `r:` (the `pathTree` roots, so they
// never clash with a folder key).
export const branchTree = (
  branches: readonly Branch[],
  collapsed: ReadonlySet<string>,
): BranchRow[] => {
  const of = (isRemote: boolean, root: string, name: string): BranchRow[] => {
    const group = branches.filter(branch => branch.isRemote === isRemote)
    if (group.length === 0) return []
    const isOpen = !collapsed.has(root)
    const head: BranchRow = { kind: 'folder', key: root, name, depth: 0, isOpen, isGroup: true, count: group.length }
    if (!isOpen) return [head]
    const rows = pathTree(
      group.map(branch => ({ path: branch.name, item: branch })),
      collapsed,
      root,
    ).map(
      (row): BranchRow =>
        row.kind === 'folder'
          ? { ...row, depth: row.depth + 1 }
          : { kind: 'branch', branch: row.item, name: row.name, depth: row.depth + 1 },
    )

    return [head, ...rows]
  }

  return [...of(false, 'l:', 'Local'), ...of(true, 'r:', 'Remote')]
}

// What column `x` of a Branches row is: cell 0 the selection bar (the name's),
// then a rail (`│ `) per depth level and, on a folder (category rows
// included), the arrow's 2 cells; the rest is the name.
export const branchHit = (depth: number, isFolder: boolean, x: number): 'arrow' | 'name' => {
  const arrow = 1 + 2 * Math.max(0, depth)

  return isFolder && x >= arrow && x < arrow + 2 ? 'arrow' : 'name'
}

// The text a Branches row copies: a branch its full name (`origin/main`),
// a folder its path with a trailing `/` (`r:origin` → `origin/`); a category
// row nothing.
export const copyTextOf = (row: BranchRow): string | undefined => {
  if (row.kind === 'branch') return row.branch.name
  if (row.isGroup === true) return undefined

  return row.key.replace(/^[lr]:/, '') + '/'
}

// The three calls that touch the repo or its remotes: fetch every remote, a
// pull that only fast-forwards (it fails rather than merging), and a push of
// the current branch to its upstream.
export type RemoteAction = 'fetch' | 'pull' | 'push'

export const remoteArgv = (action: RemoteAction): string[] =>
  action === 'fetch' ? ['git', 'fetch', '--all'] : action === 'pull' ? ['git', 'pull', '--ff-only'] : ['git', 'push']

// A short line for a toast from a finished fetch, pull or push.
export const remoteSummary = (
  action: RemoteAction,
  exitCode: number,
  stdout: string,
  stderr: string,
): string => {
  const lines = (exitCode === 0 ? stdout + '\n' + stderr : stderr + '\n' + stdout)
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('Fetching '))
  const detail = exitCode === 0 ? (lines.at(-1) ?? 'done') : (lines[0] ?? 'exit ' + exitCode)

  return `git ${action}: ${exitCode === 0 ? '' : 'failed: '}${detail}`
}

// The branch HEAD names, also before the first commit (where `rev-parse
// --abbrev-ref HEAD` fails); fails when detached and outside a repo.
export const headNameArgv = (): string[] => ['git', 'symbolic-ref', '--short', '-q', 'HEAD']

// `normal`: a dir untracked as a whole is one `?? dir/` entry (the
// Explorer's marks); `all`: every file in it (Change Log, the counts).
export const statusArgv = (untracked: 'all' | 'normal' = 'all'): string[] => [
  'git',
  'status',
  '--porcelain=v1',
  '-z',
  '--untracked-files=' + untracked,
]

export type Change = {
  path: string
  from?: string
  x: string
  y: string
  kind: 'added' | 'modified' | 'deleted'
}

// `-z` output: `XY path` entries split by NUL; a rename or copy is followed by
// its source path as a field of its own.
export const parseStatus = (stdout: string): Change[] => {
  const fields = stdout.split('\0')
  const changes: Change[] = []
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] ?? ''
    if (field.length < 4) continue
    const x = field[0] ?? ' '
    const y = field[1] ?? ' '
    const change: Change = {
      path: field.slice(3),
      x,
      y,
      kind:
        (x === '?' && y === '?') || x === 'A' || y === 'A'
          ? 'added'
          : x === 'D' || y === 'D'
            ? 'deleted'
            : 'modified',
    }
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      change.from = fields[++i]
    }
    changes.push(change)
  }

  return changes
}

export const changeCounts = (
  changes: Change[],
): { added: number; modified: number; deleted: number } => {
  const counts = { added: 0, modified: 0, deleted: 0 }
  for (const change of changes) counts[change.kind]++

  return counts
}

// `~`-prefixed when the directory is under the home directory.
export const shortDir = (root: string, home: string | undefined): string => {
  if (home === undefined || home === '') return root
  const base = home.replace(/\/+$/, '')
  if (root === base) return '~'

  return root.startsWith(base + '/') ? '~' + root.slice(base.length) : root
}

export const isUntracked = (change: Change): boolean =>
  change.x === '?' && change.y === '?'

// One letter for a change (vs HEAD, staged and unstaged together).
export const changeGlyph = (change: Change): string =>
  isUntracked(change)
    ? '?'
    : change.from !== undefined
      ? change.x === 'C' || change.y === 'C'
        ? 'C'
        : 'R'
      : change.kind === 'added'
        ? 'A'
        : change.kind === 'deleted'
          ? 'D'
          : 'M'

export const changeWords = (change: Change): string =>
  isUntracked(change)
    ? 'untracked'
    : change.from !== undefined
      ? change.x === 'C' || change.y === 'C'
        ? 'copied'
        : 'renamed'
      : change.kind

// The list as shown: a tree grouped by `/`.
export type ChangeRow = TreeRow<Change>

export const changeRows = (changes: readonly Change[], collapsed: ReadonlySet<string>): ChangeRow[] => {
  const sorted = [...changes].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  return pathTree(
    sorted.map(change => ({ path: change.path, item: change })),
    collapsed,
    'c:',
  )
}

// The diff of one change against HEAD. An untracked file is not known to git,
// so it is diffed against /dev/null (exit 1 on a difference); with no HEAD yet
// the index is the base. A rename is shown from its source.
export const changeDiffArgv = (change: Change, hasHead = true): string[] => {
  if (isUntracked(change)) {
    return ['git', 'diff', '--no-index', '--color=never', '--', '/dev/null', change.path]
  }
  const paths = change.from === undefined ? [change.path] : [change.from, change.path]

  return hasHead
    ? ['git', 'diff', 'HEAD', '--color=never', '-M', '--', ...paths]
    : ['git', 'diff', '--cached', '--color=never', '-M', '--', ...paths]
}

// A path cut from the start to fit `width` columns.
export const fitStart = (text: string, width: number): string =>
  text.length > width ? '…' + text.slice(text.length - Math.max(1, width - 1)) : text

// Columns of a commit row: the lanes, the marked short sha and a space take
// `laneCols + 1 + 9`, the diff button zone `DIFF_COLS`; a wide row adds an
// author (dropped under 80 columns) and a date, each followed by a space, and
// the subject takes the rest (at least 4). `width` is the text width of the row.
export const DIFF_COLS = 2

export const graphColumns = (
  width: number,
  laneCols: number,
  wide = true,
): { subject: number; author: number; date: number } => {
  const date = wide ? 10 : 0
  const author = wide && width >= 80 ? 16 : 0
  const taken = laneCols + 10 + DIFF_COLS + (date > 0 ? date + 1 : 0) + (author > 0 ? author + 1 : 0)

  return { subject: Math.max(4, width - taken), author, date }
}

// The most lanes a row of `width` columns can draw and still give the subject
// its 4 columns. A row's lane cells are `2 * maxLanes`, plus 2 for the `…` cell
// that `layoutGraph` adds when lanes collapse.
export const maxLanesFor = (width: number, wide = true): number => {
  const taken = 10 + DIFF_COLS + (wide ? 11 : 0) + (wide && width >= 80 ? 17 : 0)

  return Math.max(1, Math.floor((width - taken - 4 - 2) / 2))
}

// The files one commit changed; a merge is listed against its first parent.
export const filesArgv = (sha: string): string[] => [
  'git',
  '-c',
  'core.quotePath=false',
  'show',
  '--name-status',
  '-M',
  '--diff-merges=first-parent',
  '--format=',
  sha,
]

// The local and remote branches that contain a commit, as full refnames.
export const containsArgv = (sha: string): string[] => [
  'git',
  'branch',
  '-a',
  '--contains',
  sha,
  '--format=%(refname)',
]

// The branches containing a commit, by kind, as short names.
export type Contains = { local: string[]; remote: string[] }

// `containsArgv` output as short names (`main`, `origin/main`), local and
// remote apart, each in input order; remote `HEAD`s and anything else are dropped.
export const parseContains = (stdout: string): Contains => {
  const local: string[] = []
  const remote: string[] = []
  for (const line of lines(stdout)) {
    const ref = line.trim()
    if (ref.startsWith(LOCAL)) {
      local.push(ref.slice(LOCAL.length))
    } else if (ref.startsWith(REMOTE)) {
      const name = ref.slice(REMOTE.length)
      if (!name.endsWith('/HEAD')) remote.push(name)
    }
  }

  return { local, remote }
}

// `--name-status` lines (`M\tpath`, `R100\told\tnew`) as `Change`s, so
// `changeRows` and `changeGlyph` draw them: the status letter is `x`, a rename
// or copy keeps its source in `from`.
export const parseNameStatus = (stdout: string): Change[] => {
  const changes: Change[] = []
  for (const line of lines(stdout)) {
    const [status = '', first = '', second] = line.split('\t')
    const x = status[0] ?? ''
    if (x === '' || first === '') continue
    const change: Change = {
      path: x === 'R' || x === 'C' ? (second ?? first) : first,
      x,
      y: ' ',
      kind: x === 'A' || x === 'C' ? 'added' : x === 'D' ? 'deleted' : 'modified',
    }
    if ((x === 'R' || x === 'C') && second !== undefined) change.from = first
    changes.push(change)
  }

  return changes
}

// The `diff --git` block of `path` in a multi-file patch: the one whose header
// ends in `b/<path>` (the new path of a rename) or starts at `a/<path>`.
export const fileDiff = (patch: string, path: string): string => {
  const blocks = patch.split(/^(?=diff --git )/m)
  for (const block of blocks) {
    const header = block.slice(0, block.indexOf('\n') === -1 ? undefined : block.indexOf('\n'))
    if (!header.startsWith('diff --git ')) continue
    if (header.endsWith(' b/' + path) || header.startsWith('diff --git a/' + path + ' b/')) {
      return block
    }
  }

  return ''
}

// `keys` with `key` added, or removed when already there (a folder opened or
// closed).
export const toggled = (keys: readonly string[], key: string): string[] =>
  keys.includes(key) ? keys.filter(k => k !== key) : [...keys, key]
