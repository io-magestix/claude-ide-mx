import { expect, test } from 'claude-code/testing'

import { BRANCHES, LOG, MERGE_NAME_STATUS, MERGE_PATCH, MULTI_PATCH, NAME_STATUS, PATCH } from './fixtures'
import {
  branchHit,
  branchTree,
  copyTextOf,
  changeDiffArgv,
  changeGlyph,
  containsArgv,
  changeRows,
  fileDiff,
  filesArgv,
  fitStart,
  parseNameStatus,
  patchArgv,
  DIFF_COLS,
  graphColumns,
  maxLanesFor,
  pathTree,
  remoteArgv,
  remoteSummary,
  diffBody,
  diffGutter,
  diffLines,
  cellRuns,
  infoHead,
  layoutGraph,
  changeCounts,
  parseBranches,
  parseContains,
  parseStatus,
  shortDir,
  parseLog,
  parseRefs,
  sliceDiff,
  splitShow,
  trackLabel,
} from './git'

test('parseBranches: local first, current marked, origin/HEAD skipped', () => {
  const branches = parseBranches(BRANCHES)
  expect(branches.map(b => b.name).slice(0, 3)).toEqual([
    'develop',
    'fix/delivery-readiness',
    'origin/develop',
  ])
  expect(branches[0]).toMatchObject({
    name: 'develop',
    isHead: true,
    isRemote: false,
    upstream: 'origin/develop',
  })
  expect(branches.some(b => b.name.endsWith('/HEAD'))).toBe(false)
  expect(branches.filter(b => b.isRemote).every(b => !b.isHead)).toBe(true)
  expect(branches.find(b => b.name === 'origin/main')?.isRemote).toBe(true)
})

test('parseLog: commits with parents and refs', () => {
  const commits = parseLog(LOG)
  expect(commits.length).toBe(9)
  const head = commits.find(c => c.short === '908022a')
  expect(head?.refs).toEqual(['HEAD -> develop', 'origin/develop'])
  expect(head?.subject).toBe('oh-my-project v0.7.1')
  expect(head?.date).toBe('2026-07-09')
  expect(head?.parents).toEqual(['06615e2e9ee9921f3ec843539189373c6f8963d2'])
  const merge = commits.find(c => c.short === '352e0cc')
  expect(merge?.parents.length).toBe(2)
  expect(merge?.refs).toEqual(['origin/main'])
})

test('empty and not-a-repo output', () => {
  expect(parseBranches('')).toEqual([])
  expect(parseLog('')).toEqual([])
  expect(parseLog('fatal: not a git repository\n')).toEqual([])
})

const commit = (sha: string, ...parents: string[]) => ({
  sha,
  short: sha,
  parents,
  refs: [],
  author: 'a',
  date: 'd',
  subject: sha,
})

// The rows as plain glyph lines.
const draw = (commits: ReturnType<typeof commit>[], maxLanes?: number): string[] =>
  layoutGraph(commits, maxLanes).map(row =>
    row.cells.map(cell => cell.glyph).join('').trimEnd(),
  )

test('layoutGraph: linear history is one lane', () => {
  expect(draw([commit('c', 'b'), commit('b', 'a'), commit('a')])).toEqual(['●', '●', '●'])
})

test('layoutGraph: branch and merge', () => {
  expect(
    draw([
      commit('m', 'a', 'b'),
      commit('a', 'r'),
      commit('b', 'r'),
      commit('r'),
    ]),
  ).toEqual(['○─╮', '● │', '│ ●', '●─╯'])
})

test('layoutGraph: two merges in a row', () => {
  expect(
    draw([
      commit('m2', 'm1', 'y'),
      commit('m1', 'a', 'x'),
      commit('a', 'r'),
      commit('x', 'r'),
      commit('y', 'r'),
      commit('r'),
    ]),
  ).toEqual(['○─╮', '○─┼─╮', '● │ │', '│ │ ●', '│ ● │', '●─╯─╯'])
})

test('layoutGraph: octopus merge opens a lane per extra parent', () => {
  expect(
    draw([commit('o', 'a', 'b', 'c'), commit('a'), commit('b'), commit('c')]),
  ).toEqual(['○─╮─╮', '● │ │', '  ● │', '    ●'])
})

test('layoutGraph: a closed lane is reused by the next branch', () => {
  const rows = layoutGraph([
    commit('m', 'a', 'b'),
    commit('b', 'a'),
    commit('a', 'r'),
    commit('t', 'r'),
    commit('r'),
  ])
  // lane 1 closed at `a`; the new tip `t` takes it back
  expect(rows.map(row => row.lane)).toEqual([0, 1, 0, 1, 0])
  expect(rows[3]?.cells.map(c => c.glyph).join('').trimEnd()).toBe('│ ●')
  // a new lane-run gets a new color
  expect(rows[3]?.cells[2]?.color).not.toBe(rows[1]?.cells[2]?.color)
})

test('layoutGraph: a horizontal crosses a passing lane', () => {
  expect(
    draw([
      commit('p', 'q', 'r'),
      commit('q', 'a', 'b'),
      commit('a'),
      commit('b'),
      commit('r'),
    ]),
  ).toEqual(['○─╮', '○─┼─╮', '● │ │', '  │ ●', '  ●'])
})

test('layoutGraph: lane color is stable from open to close', () => {
  const rows = layoutGraph([
    commit('m', 'a', 'b'),
    commit('a', 'r'),
    commit('x', 'r'),
    commit('b', 'r'),
    commit('r'),
  ])
  const opened = rows[0]?.cells[2]?.color
  expect(rows[1]?.cells[2]?.color).toBe(opened)
  expect(rows[0]?.cells[0]?.color).toBe(rows[1]?.cells[0]?.color)
})

test('layoutGraph: lanes past the cap collapse into …', () => {
  const commits = [
    commit('o', 'a', 'b', 'c', 'd'),
    commit('a'),
    commit('b'),
    commit('c'),
    commit('d'),
  ]
  const lines = draw(commits, 2)
  expect(lines[0]).toBe('○─╮─…')
  expect(lines.every(line => line.length <= 5)).toBe(true)
})

test('cellRuns and infoHead', () => {
  const rows = layoutGraph([commit('m', 'a', 'b'), commit('a'), commit('b')])
  expect(cellRuns(rows[0]?.cells ?? [], 6).map(run => run.text).join('')).toBe('○─╮   ')
  const head = infoHead(['sha', 'A <a@b>', 'date', '', 'subject'], {
    ...commit('m', '1234567890', 'abcdef0123'),
    refs: ['origin/main'],
  })
  expect(head).toEqual([
    'sha',
    'A <a@b>',
    'date',
    'parents 1234567 abcdef0',
    'refs origin/main',
    'subject',
  ])
  const m = { ...commit('m', '1234567890'), refs: [] }
  expect(
    infoHead(['sha', 'A', 'date', '', 'subject'], m, { local: ['fix', 'main'], remote: ['origin/main', 'up/x'] }, 'main'),
  ).toEqual([
    'sha',
    'A',
    'date',
    'parents 1234567',
    'local  fix, *main',
    'remote origin/main, up/x',
    'subject',
  ])
  expect(infoHead(['sha', 'A', 'date'], m, { local: ['main'], remote: [] })).toEqual([
    'sha',
    'A',
    'date',
    'parents 1234567',
    'local  main',
  ])
  expect(infoHead(['sha', 'A', 'date'], m, { local: [], remote: [] })).toEqual(['sha', 'A', 'date', 'parents 1234567'])
})

test('helpers', () => {
  expect(parseRefs('')).toEqual([])
  expect(parseRefs('tag: v1, origin/HEAD')).toEqual(['tag: v1'])
  expect(trackLabel('[ahead 1, behind 2]')).toBe('+1 -2')
  expect(trackLabel('[gone]')).toBe('gone')
  expect(trackLabel(undefined)).toBe('')
  expect(splitShow('a\nb\n\n')).toEqual(['a', 'b'])
})

test('sliceDiff at offset 0: a cut diff keeps hunk counts valid', () => {
  const diff = [
    'diff --git a/x b/x',
    '--- a/x',
    '+++ b/x',
    '@@ -1,3 +1,4 @@ ctx',
    ' a',
    '-b',
    '+c',
    '+d',
    ' e',
  ].join('\n')
  expect(sliceDiff(diff, 0, 100)).toBe(diff)
  expect(sliceDiff(diff, 0, 6).split('\n')[3]).toBe('@@ -1,2 +1,1 @@ ctx')
  expect(sliceDiff(diff, 0, 3)).toBe('')
  expect(sliceDiff(PATCH, 0, 12)).toContain('@@')
})

const DIFF = [
  'diff --git a/x b/x',
  '--- a/x',
  '+++ b/x',
  '@@ -1,3 +1,4 @@ ctx',
  ' a',
  '-b',
  '+c',
  '+d',
  ' e',
  'diff --git a/y b/y',
  '--- a/y',
  '+++ b/y',
  '@@ -10,2 +10,2 @@',
  '-- q',
  '+r',
  ' s',
].join('\n')

test('diffBody: hunk body lines only, a removed -- line included', () => {
  expect(diffBody(DIFF)).toEqual([' a', '-b', '+c', '+d', ' e', '-- q', '+r', ' s'])
  expect(diffBody('')).toEqual([])
  expect(diffBody('Binary files a/x and b/x differ')).toEqual([])
})

test('diffGutter: the widest line number plus two blanks; 0 without a body', () => {
  expect(diffGutter(DIFF)).toBe(4) // line 11
  expect(diffGutter('@@ -1,2 +1,2 @@\n a\n-b\n+c')).toBe(3)
  expect(diffGutter('@@ -9,1 +1234,1 @@\n-x\n+y')).toBe(6)
  expect(diffGutter('')).toBe(0)
})

test('sliceDiff: offset 0 keeps a whole diff as is', () => {
  expect(sliceDiff(DIFF, 0, 100)).toBe(DIFF)
  expect(sliceDiff(DIFF, 0, 6).split('\n')[3]).toBe('@@ -1,2 +1,1 @@ ctx')
})

test('sliceDiff: a hunk entered mid-way gets a header of its own', () => {
  // starts at "-b": old line 2, new line 2; keeps -b +c +d ' e'
  expect(sliceDiff(DIFF, 5, 4)).toBe(
    ['@@ -2,2 +2,3 @@ ctx', '-b', '+c', '+d', ' e'].join('\n'),
  )
  // cut at both ends
  expect(sliceDiff(DIFF, 6, 2)).toBe(['@@ -2,0 +2,2 @@ ctx', '+c', '+d'].join('\n'))
})

test('sliceDiff: file headers only with a hunk after them', () => {
  // ends inside the second file's header block: nothing of it is kept
  expect(sliceDiff(DIFF, 3, 8)).toBe(
    ['@@ -1,3 +1,4 @@ ctx', ' a', '-b', '+c', '+d', ' e'].join('\n'),
  )
  // starts at the second file's `diff` line
  expect(sliceDiff(DIFF, 9, 100)).toBe(DIFF.split('\n').slice(9).join('\n'))
  // starts inside a header block: its lines are dropped, the hunk kept
  expect(sliceDiff(DIFF, 10, 100)).toBe(DIFF.split('\n').slice(12).join('\n'))
  expect(sliceDiff(DIFF, 0, 3)).toBe('')
  expect(sliceDiff(DIFF, 99, 5)).toBe('')
  expect(sliceDiff('', 0, 5)).toBe('')
})

test('sliceDiff: a removed `-- q` line is a body line, not a header', () => {
  expect(sliceDiff(DIFF, 14, 2)).toBe(['@@ -11,1 +10,2 @@', '+r', ' s'].join('\n'))
})

test('sliceDiff: fixture slices keep valid hunks', () => {
  const total = diffLines(PATCH).length
  for (let offset = 0; offset < total; offset += 7) {
    const text = sliceDiff(PATCH, offset, 9)
    const rows = text === '' ? [] : text.split('\n')
    let i = 0
    while (i < rows.length) {
      const m = /^@@ -\d+,(\d+) \+\d+,(\d+) @@/.exec(rows[i] ?? '')
      if (m === null) {
        i++
        continue
      }
      let o = 0
      let n = 0
      for (i++; i < rows.length && !/^(@@|diff )/.test(rows[i] ?? ''); i++) {
        const c = (rows[i] ?? '')[0]
        if (c !== '+') o++
        if (c !== '-') n++
      }
      expect([o, n]).toEqual([Number(m[1]), Number(m[2])])
    }
  }
})

test('branchTree groups branches by / with local first', () => {
  const b = (name: string, isRemote = false, isHead = false) =>
    ({ name, sha: 'x', isHead, isRemote }) as const
  const rows = branchTree(
    [b('main', false, true), b('fix/a'), b('fix/b'), b('origin/main', true), b('origin/team/x', true)],
    new Set(),
  )
  const label = (r: (typeof rows)[number]) =>
    '  '.repeat(r.depth) + (r.kind === 'folder' ? (r.isGroup === true ? `[${r.name} ${r.count}]` : r.name + '/') : r.name)
  expect(rows.map(label)).toEqual([
    '[Local 3]',
    '  main',
    '  fix/',
    '    a',
    '    b',
    '[Remote 2]',
    '  origin/',
    '    main',
    '    team/',
    '      x',
  ])
  expect(rows[0]).toMatchObject({ kind: 'folder', key: 'l:', isOpen: true, isGroup: true })
  expect(rows[5]).toMatchObject({ kind: 'folder', key: 'r:', isOpen: true, isGroup: true })
  const shut = branchTree([b('fix/a'), b('origin/main', true)], new Set(['l:fix']))
  expect(shut.map(r => r.name)).toEqual(['Local', 'fix', 'Remote', 'origin', 'main'])
  // Collapsing `r:` hides every remote row but keeps its category row.
  const noRemote = branchTree(
    [b('main'), b('origin/main', true), b('origin/team/x', true)],
    new Set(['r:']),
  )
  expect(noRemote.map(label)).toEqual(['[Local 1]', '  main', '[Remote 2]'])
  expect(noRemote[2]).toMatchObject({ isOpen: false })
  // An empty group has no category row.
  expect(branchTree([b('main')], new Set()).map(r => r.name)).toEqual(['Local', 'main'])
  expect(branchTree([], new Set())).toEqual([])
})

test('branchHit: bar, rails, a folder\'s arrow, then the name', () => {
  // Cell 0 is the selection bar, counted as the name.
  expect(branchHit(0, true, 0)).toBe('name')
  // A category row (depth 0): the arrow at 1-2.
  expect([1, 2, 3].map(x => branchHit(0, true, x))).toEqual(['arrow', 'arrow', 'name'])
  // Depth 2: rails at 1-4, the arrow at 5-6.
  expect([4, 5, 6, 7].map(x => branchHit(2, true, x))).toEqual(['name', 'arrow', 'arrow', 'name'])
  // A branch has no arrow.
  expect([0, 1, 2, 5, 6].map(x => branchHit(2, false, x))).toEqual(['name', 'name', 'name', 'name', 'name'])
})

test('copyTextOf: branch name, folder path with /, nothing for a category', () => {
  const b = (name: string, isRemote = false) => ({ name, sha: 'x', isHead: false, isRemote }) as const
  const rows = branchTree(
    [b('main'), b('feature/ui/a'), b('origin/main', true), b('origin/team/x', true)],
    new Set(),
  )
  expect(rows.map(r => [r.kind === 'folder' ? r.key : r.name, copyTextOf(r)])).toEqual([
    ['l:', undefined],
    ['main', 'main'],
    ['l:feature', 'feature/'],
    ['l:feature/ui', 'feature/ui/'],
    ['a', 'feature/ui/a'],
    ['r:', undefined],
    ['r:origin', 'origin/'],
    ['main', 'origin/main'],
    ['r:origin/team', 'origin/team/'],
    ['x', 'origin/team/x'],
  ])
})

test('remote actions: argv and summaries', () => {
  expect(remoteArgv('fetch')).toEqual(['git', 'fetch', '--all'])
  expect(remoteArgv('pull')).toEqual(['git', 'pull', '--ff-only'])
  expect(remoteSummary('pull', 0, 'Already up to date.\n', '')).toBe('git pull: Already up to date.')
  expect(remoteSummary('fetch', 0, '', 'Fetching origin\n')).toBe('git fetch: done')
  expect(remoteSummary('pull', 128, '', 'fatal: Not possible to fast-forward, aborting.\n')).toBe(
    'git pull: failed: fatal: Not possible to fast-forward, aborting.',
  )
})

test('parseStatus: untracked, staged add, rename, delete, MM', () => {
  const out = [
    '?? new.txt',
    'A  added.txt',
    'R  to.txt',
    'from.txt',
    ' D gone.txt',
    'MM both.txt',
    '',
  ].join('\0')
  const changes = parseStatus(out)
  expect(changes.map(c => c.kind)).toEqual([
    'added',
    'added',
    'modified',
    'deleted',
    'modified',
  ])
  expect(changes[2]).toMatchObject({ path: 'to.txt', from: 'from.txt' })
  expect(changes[4]).toMatchObject({ path: 'both.txt', x: 'M', y: 'M' })
  expect(changeCounts(changes)).toEqual({ added: 2, modified: 2, deleted: 1 })
  expect(parseStatus('')).toEqual([])
})

test('shortDir: ~ under home only', () => {
  expect(shortDir('/home/u/p/repo', '/home/u')).toBe('~/p/repo')
  expect(shortDir('/home/u', '/home/u/')).toBe('~')
  expect(shortDir('/home/ux/repo', '/home/u')).toBe('/home/ux/repo')
  expect(shortDir('/repo', undefined)).toBe('/repo')
})

test('pathTree: groups by /, leaves first, collapsed folders hide their rows', () => {
  const items = ['a.txt', 'src/b.ts', 'src/ui/c.ts', 'z/d.ts'].map(path => ({ path, item: path }))
  const label = (r: ReturnType<typeof pathTree<string>>[number]) =>
    '  '.repeat(r.depth) + (r.kind === 'folder' ? (r.isOpen ? '▾' : '▸') + r.name + '/' : r.name)
  expect(pathTree(items, new Set(), 'c:').map(label)).toEqual([
    'a.txt',
    '▾src/',
    '  b.ts',
    '  ▾ui/',
    '    c.ts',
    '▾z/',
    '  d.ts',
  ])
  const shut = pathTree(items, new Set(['c:src', 'c:z']), 'c:')
  expect(shut.map(label)).toEqual(['a.txt', '▸src/', '▸z/'])
  expect(shut[1]).toMatchObject({ key: 'c:src' })
  expect(pathTree(items, new Set(), 'c:')[3]).toMatchObject({ key: 'c:src/ui' })
})

test('changeRows: sorted, grouped by folder', () => {
  const changes = parseStatus(['?? src/b.ts', ' M a.txt', ''].join('\0'))
  const tree = changeRows(changes, new Set())
  expect(tree.map(r => r.name)).toEqual(['a.txt', 'src', 'b.ts'])
})

test('changeGlyph and changeDiffArgv', () => {
  const [untracked, modified, renamed] = parseStatus(
    ['?? n.txt', ' M m.txt', 'R  to.txt', 'from.txt', ''].join('\0'),
  )
  expect([untracked, modified, renamed].map(c => changeGlyph(c!))).toEqual(['?', 'M', 'R'])
  expect(changeDiffArgv(untracked!)).toEqual([
    'git', 'diff', '--no-index', '--color=never', '--', '/dev/null', 'n.txt',
  ])
  expect(changeDiffArgv(modified!)).toEqual([
    'git', 'diff', 'HEAD', '--color=never', '-M', '--', 'm.txt',
  ])
  expect(changeDiffArgv(renamed!)).toContain('from.txt')
  expect(changeDiffArgv(modified!, false).slice(0, 3)).toEqual(['git', 'diff', '--cached'])
})

test('fitStart cuts from the start', () => {
  expect(fitStart('src/ui/file.ts', 20)).toBe('src/ui/file.ts')
  expect(fitStart('src/ui/file.ts', 8)).toBe('…file.ts')
})

test('graphColumns: wide adds date and author, narrow drops author, subject takes the rest', () => {
  const wide = graphColumns(150, 3)
  expect(wide).toMatchObject({ author: 16, date: 10 })
  expect(wide.subject).toBe(150 - 3 - 10 - DIFF_COLS - 11 - 17)
  expect(graphColumns(79, 3)).toMatchObject({ author: 0, date: 10 })
  expect(graphColumns(60, 3, false)).toEqual({ subject: 60 - 3 - 10 - DIFF_COLS, author: 0, date: 0 })
  expect(graphColumns(10, 5).subject).toBe(4)
})

test('filesArgv and patchArgv diff a merge against its first parent', () => {
  expect(filesArgv('abc')).toEqual([
    'git', '-c', 'core.quotePath=false', 'show', '--name-status', '-M', '--diff-merges=first-parent', '--format=', 'abc',
  ])
  expect(patchArgv('abc')).toContain('--diff-merges=first-parent')
  expect(patchArgv('abc').slice(1, 3)).toEqual(['-c', 'core.quotePath=false'])
})

test('UTF-8 paths: parseNameStatus and fileDiff agree on the unquoted name', () => {
  const status = 'A\tcafé.md\nR100\told.md\tnaïve/ü.md\n'
  const patch =
    'diff --git a/café.md b/café.md\nnew file mode 100644\n+one\n' +
    'diff --git a/old.md b/naïve/ü.md\nsimilarity index 100%\n+two\n'
  const paths = parseNameStatus(status).map(c => c.path)
  expect(paths).toEqual(['café.md', 'naïve/ü.md'])
  expect(fileDiff(patch, paths[0] ?? '')).toContain('+one')
  expect(fileDiff(patch, paths[1] ?? '')).toContain('+two')
})

test('maxLanesFor: a row at the most lanes fits the width, wide and compact', () => {
  for (const width of [100, 160]) {
    for (const wide of [true, false]) {
      const lanes = maxLanesFor(width, wide)
      // lane cells plus the `…` cell pair
      const laneCols = lanes * 2 + 2
      const cols = graphColumns(width, laneCols, wide)
      expect(laneCols + 10 + DIFF_COLS + (cols.date ? cols.date + 1 : 0) + (cols.author ? cols.author + 1 : 0) + cols.subject).toBeLessThanOrEqual(width)
      expect(cols.subject).toBeGreaterThanOrEqual(4)
    }
  }
})

test('parseNameStatus: modify, add, delete, rename, path with spaces', () => {
  const changes = parseNameStatus(NAME_STATUS)
  expect(changes.map(c => [c.path, c.from, changeGlyph(c)])).toEqual([
    ['CHANGELOG.md', undefined, 'M'],
    ['plugin/package.json', undefined, 'M'],
    ['docs/read me.md', undefined, 'A'],
    ['old.txt', undefined, 'D'],
    ['src/b.ts', 'src/a.ts', 'R'],
  ])
  expect(changeRows(changes, new Set()).filter(r => r.kind === 'leaf').length).toBe(5)
})

test('parseNameStatus: a merge lists its first-parent files', () => {
  expect(parseNameStatus(MERGE_NAME_STATUS).map(c => c.path)).toEqual(['from-develop.txt'])
  expect(parseNameStatus('')).toEqual([])
})

test('fileDiff: the block of one path', () => {
  expect(fileDiff(MULTI_PATCH, 'CHANGELOG.md')).toContain('+changelog line')
  expect(fileDiff(MULTI_PATCH, 'CHANGELOG.md')).not.toContain('package.json')
  expect(fileDiff(MULTI_PATCH, 'plugin/package.json')).toContain('0.7.1')
  expect(fileDiff(MULTI_PATCH, 'docs/read me.md')).toBe(
    MULTI_PATCH.split('diff --git ').filter(b => b.startsWith('a/docs/read me.md')).map(b => 'diff --git ' + b)[0],
  )
  expect(fileDiff(MULTI_PATCH, 'old.txt')).toContain('-gone')
  expect(fileDiff(MULTI_PATCH, 'src/b.ts')).toContain('rename to src/b.ts')
    expect(fileDiff(PATCH, 'CHANGELOG.md')).toBe(PATCH)
  expect(fileDiff(MERGE_PATCH, 'nope')).toBe('')
})

test('layoutGraph: each row carries its lane color', () => {
  const rows = layoutGraph([commit('m', 'a', 'b'), commit('a', 'r'), commit('b', 'r'), commit('r')])
  expect(rows.map(row => row.lane)).toEqual([0, 0, 1, 0])
  expect(rows[1]?.color).toBe(rows[0]?.color)
  expect(rows[3]?.color).toBe(rows[0]?.color)
  expect(rows[2]?.color).not.toBe(rows[0]?.color)
  expect(rows[2]?.color).toBe(rows[0]?.cells[2]?.color)
})

test('layoutGraph: a collapsed lane keeps its row color', () => {
  const commits = [commit('m', 'a', 'b'), commit('a', 'r'), commit('b', 'r'), commit('r')]
  const full = layoutGraph(commits)
  const capped = layoutGraph(commits, 1)
  expect(capped[2]?.lane).toBe(1)
  expect(capped[2]?.color).toBe(full[2]?.color)
  expect(capped[2]?.color).not.toBe(capped[0]?.color)
})

test('containsArgv and parseContains', () => {
  expect(containsArgv('abc')).toEqual(['git', 'branch', '-a', '--contains', 'abc', '--format=%(refname)'])
  const stdout = [
    'refs/remotes/origin/HEAD',
    'refs/remotes/origin/main',
    'refs/heads/main',
    '(HEAD detached at abc1234)',
    'refs/remotes/upstream/fix/x',
    'refs/heads/fix/y',
    'refs/tags/v1',
    '',
  ].join('\n')
  expect(parseContains(stdout)).toEqual({ local: ['main', 'fix/y'], remote: ['origin/main', 'upstream/fix/x'] })
  expect(parseContains('')).toEqual({ local: [], remote: [] })
})
