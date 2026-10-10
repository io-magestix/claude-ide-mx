import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { sliceCols } from '../shared/hscroll'
import { PALETTE_SIZE, layoutGraph, parseLog } from './git'
import { lanePalette } from './git-theme'
import { themeFromClaudeCode } from '../shared/term-theme'
import { sessionHex } from '../shared/color'
import { onDefaultFg } from '../shared/ui'
import { BRANCHES, LOG, MERGE_NAME_STATUS, MERGE_PATCH, MULTI_PATCH, NAME_STATUS, STAT } from './fixtures'

// The panels' theme in the tests: Claude Code's dark theme, no terminal scheme.
const DARK = themeFromClaudeCode('dark', undefined)

const CWD = '/repo'
const LANES = lanePalette(DARK)
const SEL = onDefaultFg(DARK.surfaceHover)
const PLUGIN = 'ide-panes'
const VIEWPORT = { columns: 120, rows: 30 }
const props = (bodyColumns: number) =>
  ({
    title: 'Git',
    isFocused: true,
    bodyColumns,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  }) as const

// untracked + staged add, modified, deleted
const STATUS = ['?? a.txt', ' M b.txt', ' D c.txt', ''].join('\0')

const MOD_DIFF =
  'diff --git a/b.txt b/b.txt\nindex 111..222 100644\n--- a/b.txt\n+++ b/b.txt\n@@ -1,2 +1,2 @@\n keep\n-old line\n+new line\n'
const NEW_DIFF =
  'diff --git a/a.txt b/a.txt\nnew file mode 100644\nindex 0000000..333\n--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1 @@\n+brand new\n'

const result = (stdout: string, exitCode = 0, stderr = '') => ({
  value: {
    exitCode,
    stdout,
    stderr,
  },
})

// `isRepo` false answers every git call with exit 128; the first `rootFails`
// root lookups throw, as when the engine aborts a superseded render's call.
// `answer` may answer a call first (undefined: the defaults below).
const fake = (
  on: On,
  calls: string[][],
  isRepo = true,
  log = LOG,
  head: { name: string } = { name: 'main' },
  status = STATUS,
  rootFails = 0,
  answer: (argv: readonly string[]) => ReturnType<typeof result> | undefined = () => undefined,
): void => {
  let failsLeft = rootFails
  on('process.run', (_$, e) => {
    calls.push([...e.argv])
    if (!isRepo) return result('', 128)
    const answered = answer(e.argv)
    if (answered !== undefined) return answered
    if (failsLeft > 0 && e.argv.includes('--show-toplevel')) {
      failsLeft -= 1
      throw new Error('aborted')
    }
    const sub = e.argv[1] === '-c' ? e.argv[3] : e.argv[1]
    if (sub === 'rev-parse') {
      if (e.argv.includes('--abbrev-ref')) return result(head.name + '\n')
      if (e.argv.includes('--short')) return result('abc1234\n')

      return result(CWD + '\n')
    }
    if (sub === 'status') return result(status)
    if (sub === 'for-each-ref') return result(BRANCHES)
    if (sub === 'fetch') return result('')
    if (sub === 'pull') return result('', 128, 'fatal: Not possible to fast-forward, aborting.\n')
    if (sub === 'push') return result('', 0, 'Everything up-to-date\n')
    if (sub === 'log') return result(log)
    if (sub === 'diff') {
      return e.argv.includes('--no-index')
        ? result(NEW_DIFF, 1)
        : result(e.argv.includes('c.txt') ? '' : MOD_DIFF)
    }
    if (sub === 'show') {
      const merge = (e.argv.at(-1) ?? '').startsWith('352e0cc')
      if (e.argv.includes('--name-status')) return result(merge ? MERGE_NAME_STATUS : NAME_STATUS)
      if (e.argv.includes('--stat')) return result(STAT)

      return result(merge ? MERGE_PATCH : MULTI_PATCH)
    }

    return result('', 1)
  })
  on('env.get', () => ({ value: '/home/u' }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.root', () => ({ value: CWD }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
}

// The marker before a drawn commit's hash: a row of the hash Client (`dots` in
// Commits, `shas` in Graph) on terminal and desktop, else the hash Button's label.
type Mounted = Pick<Awaited<ReturnType<Engine['ui']['mount']>>, 'find' | 'findAll'>
type HashRow = { glyph?: string; color?: string; mark: string; short: string }
const hashRows = async (ui: Mounted, key: 'dots' | 'shas') =>
  ((await ui.find({ key }))?.props.props as { rows?: HashRow[] } | undefined)?.rows
const markOf = async (ui: Mounted, sha: string): Promise<string | undefined> => {
  // the Client's rows line up with the drawn `row:<sha>` Boxes
  const at = (await ui.findAll({ type: 'Box' }))
    .filter(box => box.key?.startsWith('row:'))
    .findIndex(box => box.key === 'row:' + sha)
  for (const key of ['dots', 'shas'] as const) {
    const row = (await hashRows(ui, key))?.[at]
    if (row !== undefined) return row.mark
  }
  const label = (await ui.find({ key: 'commit:' + sha }))?.props.label

  return typeof label === 'string' ? label[0] : undefined
}

const start = (surface: 'terminal' | 'desktop') => ({
  cwd: CWD,
  surface,
  isInteractive: true,
})

for (const surface of ['terminal', 'desktop'] as const) {
  for (const columns of [100, 160]) {
    const mount = ($: Engine) =>
      $.ui.mount({
        plugin: PLUGIN,
        surface,
        component: 'Pane',
        props: props(columns),
        requestId: 'ide-git',
        viewport: VIEWPORT,
      })

    test(`${surface}/${columns}: one header line: title, panel tabs, then actions`, async ($, on) => {
      mock.store(on)
      fake(on, [])
      await $.session.start(start(surface))
      const ui = await mount($)

      const boxes = await ui.findAll({ type: 'Box' })
      const lines = boxes.map(box => box.key ?? '').filter(key => key.startsWith('header:'))
      expect(lines).toEqual(['header:tabs'])
      const header = boxes.find(box => box.key === 'header')
      expect(header?.props.height).toBe(1)
      expect(boxes.find(box => box.key === 'header:tabs')?.props.gap).toBe(2)
      // the title, the tabs and the actions share the row, in that order
      const row = (await ui.findAll({ type: 'Button' }))
        .map(b => b.key ?? '')
        .filter(k => k.startsWith('tab:') || ['back', 'refresh', 'fetch', 'pull', 'push'].includes(k))
      expect(row).toEqual(['tab:overview', 'tab:graph', 'tab:changelog', 'fetch', 'pull', 'push'])
      expect((boxes.find(box => box.key === 'header:tabs')?.text ?? '').startsWith(' Git')).toBe(true)
      expect(await ui.find({ key: 'refresh' })).toBeUndefined()
      // the theme lives in Settings, not here
      expect(await ui.find({ key: 'theme' })).toBeUndefined()
    })

    test(`${surface}/${columns}: the theme styles the panel (dots, selection, frames)`, async ($, on) => {
      const store = new Map<string, unknown>()
      on('store.get', (_$, e) => ({ value: store.get(e.key) }))
      on('store.set', (_$, e) => {
        store.set(e.key, e.value)

        return { value: undefined }
      })
      fake(on, [])
      await $.session.start(start(surface))
      const ui = await mount($)

      const first = layoutGraph(parseLog(LOG))[0]?.color ?? 0
      expect((await hashRows(ui, 'dots'))?.[0]?.color).toBe(lanePalette(DARK)[first])
      const sel = onDefaultFg(DARK.surfaceHover)
      expect((await ui.find({ key: 'row:' + parseLog(LOG)[0]?.sha }))?.props.backgroundColor).toBe(sel)
      const frames = (await ui.findAll({ type: 'Box' })).filter(box => box.props.borderStyle === 'round')
      expect(frames.length).toBeGreaterThan(0)
      for (const box of frames.filter(b => b.props.paddingX === undefined)) {
        expect(box.props.borderColor).toBe(DARK.border)
      }
    })

    test(`${surface}/${columns}: /color tints the frames and the accent`, async ($, on) => {
      mock.store(on)
      fake(on, [])
      on('command.run', { command: 'color' }, () => ({ text: 'Session color set to: green' }))
      await $.session.start(start(surface))
      await $.command.run({
        command: 'color',
        args: 'green',
        origin: { kind: 'composer' },
        presentation: { isFullscreen: true, columns: 120 },
      })
      const ui = await mount($)

      const green = sessionHex('green')
      const frames = (await ui.findAll({ type: 'Box' })).filter(box => box.props.borderStyle === 'round')
      expect(frames.length).toBeGreaterThan(0)
      for (const box of frames.filter(b => b.props.paddingX === undefined)) {
        expect(box.props.borderColor).toBe(green)
      }
      expect((await ui.find({ key: 'title:commits:chrome' }))?.props.backgroundColor).toBe(onDefaultFg(green))
    })

    test(`${surface}/${columns}: branches listed, current marked`, async ($, on) => {
      mock.store(on)
      fake(on, [])
      await $.session.start(start(surface))
      const ui = await mount($)

      const rowOf = async (key: string) =>
        (await ui.find({ key: 'bitem:' + key }))?.props.props as
          | { label?: string; isHead?: boolean; isRemote?: boolean }
          | undefined
      expect((await rowOf('b:develop'))?.isHead).toBe(true)
      expect((await rowOf('b:develop'))?.label).toContain('develop')
      expect(await ui.find({ key: 'branch:develop' })).toBeDefined()
      expect(await ui.find({ key: 'branch:origin/main' })).toBeDefined()
      expect(await ui.find({ key: 'branch:origin/HEAD' })).toBeUndefined()
      expect((await rowOf('b:origin/main'))?.isRemote).toBe(true)
      expect((await rowOf('b:develop'))?.isRemote).toBe(false)
    })

    test(`${surface}/${columns}: sections are titled, footer shows dir and counts`, async ($, on) => {
      mock.store(on)
      fake(on, [])
      await $.session.start(start(surface))
      const ui = await mount($)

      expect((await ui.find({ key: 'title:branches:chrome' }))?.text).toBe(' Branches ')
      expect((await ui.find({ key: 'title:commits:chrome' }))?.text).toBe(' Commits ')
      expect((await ui.find({ key: 'title:info:chrome' }))?.text).toBe(' Info ')
      expect(await ui.find({ type: 'Text', text: /\/repo/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'develop' })).toBeDefined()
      for (const count of ['+1', '~1', '-1']) expect(await ui.find({ type: 'Text', text: count })).toBeDefined()
      // the full path is not in the header any more
      expect(await ui.find({ type: 'Text', text: '/home/u' })).toBeUndefined()
    })

    test(`${surface}/${columns}: a title is a label, not a Button`, async ($, on) => {
      mock.store(on)
      fake(on, [])
      await $.session.start(start(surface))
      const ui = await mount($)

      for (const [key, name] of [['title:branches', 'Branches'], ['title:commits', 'Commits'], ['title:info', 'Info']] as const) {
        expect((await ui.find({ key: key + ':chrome' }))?.text).toBe(' ' + name + ' ')
        expect(await ui.find({ type: 'Button', key })).toBeUndefined()
      }
    })

    test(`${surface}/${columns}: pressing a branch re-runs log with that ref`, async ($, on) => {
      mock.store(on)
      const calls: string[][] = []
      fake(on, calls)
      await $.session.start(start(surface))
      const ui = await mount($)

      expect(calls.some(a => a[1] === 'log' && a.includes('--all'))).toBe(true)
      await ui.press({ key: 'branch:origin/main' })
      expect(
        calls.some(a => a[1] === 'log' && a[a.length - 1] === 'origin/main'),
      ).toBe(true)
    })

    test(`${surface}/${columns}: pressing a commit shows its info, no diff`, async ($, on) => {
      mock.store(on)
      fake(on, [])
      await $.session.start(start(surface))
      const ui = await mount($)

      await ui.press({ key: 'commit:908022ab43fb9bc599342842219a42dfd653f899' })
      expect(
        await ui.find({ type: 'Text', text: /oh-my-project v0.7.1/ }),
      ).toBeDefined()
      expect(await ui.find({ type: 'Code' })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: /eLeSTRaGo/ })).toBeDefined()
    })

    test(`${surface}/${columns}: Commits rows draw a colored dot, no lanes`, async ($, on) => {
      mock.store(on)
      fake(on, [])
      await $.session.start(start(surface))
      const ui = await mount($)

      const sha = '908022ab43fb9bc599342842219a42dfd653f899'
      const rows = await ui.findAll({ type: 'Box' })
      const row = rows.find(box => box.key === 'row:' + sha)
      expect(row).toBeDefined()
      // the rows hold no lane glyphs and no hash: dot, marker and hash are the
      // dots Client's column
      const drawn = rows.filter(box => box.key?.startsWith('row:')).map(box => box.text)
      expect(drawn.length).toBe(9)
      for (const text of drawn) {
        expect(text).not.toMatch(/^[ >][0-9a-f]{7} /)
        expect(text).not.toMatch(/[│╮╯┤├●○]/)
      }
      const laid = layoutGraph(parseLog(LOG))
      const dots = await hashRows(ui, 'dots')
      expect(dots).toEqual(
        laid.map((r, i) => ({
          glyph: r.commit.parents.length > 1 ? '○' : '●',
          color: LANES[r.color % PALETTE_SIZE],
          mark: i === 0 ? '>' : ' ',
          short: r.commit.short,
        })),
      )
      // the lanes differ, so do the dots
      expect(dots?.[0]?.color).not.toBe(dots?.[1]?.color)
      const cells = (await ui.findAll({ type: 'Text', in: 'dots' })).map(t => t.text)
      expect(cells).toContain('○ ')
      expect(cells).toContain(' ' + sha.slice(0, 7) + ' ')
      // the hash is no Button: the subject holds commit:<sha>
      const commitButtons = (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('commit:'))
      expect(commitButtons.length).toBe(9)
      expect(commitButtons.some(b => /^[ >][0-9a-f]{7}$/.test(String(b.props.label)))).toBe(false)
      expect(await ui.find({ key: 'subject:' + sha })).toBeUndefined()
      // info head: author, date, parents
      await ui.press({ key: 'commit:' + sha })
      expect(await ui.find({ type: 'Text', text: /eLeSTRaGo/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^parents 06615e2/ })).toBeDefined()
    })

    test(`${surface}/${columns}: Graph draws lanes, then the shas Client, then the rows`, async ($, on) => {
      mock.store(on)
      fake(on, [])
      await $.session.start(start(surface))
      const ui = await mount($)
      await ui.press({ key: 'tab:graph' })

      expect(await ui.find({ key: 'dots' })).toBeUndefined()
      const sha = '908022ab43fb9bc599342842219a42dfd653f899'
      // three parallel columns: lanes, the hash Client, the rest of each row
      const lanes = (await ui.findAll({ type: 'Box' })).find(box => box.key === 'lanes:' + sha)
      expect(lanes?.text).toContain('●')
      const shas = await hashRows(ui, 'shas')
      expect(shas?.length).toBe(9)
      expect(shas?.every(r => r.glyph === undefined)).toBe(true)
      expect(shas?.map(r => r.short)).toContain(sha.slice(0, 7))
      const row = (await ui.findAll({ type: 'Box' })).find(box => box.key === 'row:' + sha)
      expect(row?.text).not.toMatch(/[│●○]/)
      expect(row?.text).not.toContain(sha.slice(0, 7))
      expect(await ui.find({ key: 'commit:' + sha })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /│/ })).toBeDefined()
      // the selected row reads as one: its lanes, hash and rest are painted
      const first = (await ui.findAll({ type: 'Box' })).find(box => box.key?.startsWith('lanes:'))
      const firstSha = first?.key?.slice('lanes:'.length) ?? ''
      expect(first?.props.backgroundColor).toBe(SEL)
      expect((await ui.find({ key: 'row:' + firstSha }))?.props.backgroundColor).toBe(SEL)
      expect((await ui.find({ key: 'shas' }))?.props.props).toMatchObject({ background: SEL })
      expect(await markOf(ui, firstSha)).toBe('>')
    })

    test(`${surface}/${columns}: more raises the limit`, async ($, on) => {
      mock.store(on)
      const calls: string[][] = []
      // the fixture has 9 commits, below the page size: fake a full page
      const many = Array.from({ length: 200 }, (_, i) =>
        `* \x1f${String(i).padStart(40, '0')}\x1f${String(i).padStart(7, '0')}\x1f\x1fa\x1f2026-01-01\x1fc${i}`,
      ).join('\n')
      fake(on, calls, true, many)
      await $.session.start(start(surface))
      const ui = await mount($)

      await ui.press({ key: 'more' })
      expect(
        calls.some(a => a[1] === 'log' && a[a.indexOf('-n') + 1] === '400'),
      ).toBe(true)
    })
  }

  test(`${surface}: not a repo shows the message`, async ($, on) => {
    mock.store(on)
    fake(on, [], false)
    await $.session.start(start(surface))
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'Pane',
      props: props(120),
      requestId: 'ide-git',
      viewport: VIEWPORT,
    })

    expect(
      await ui.find({ type: 'Text', text: /Not a git repository/ }),
    ).toBeDefined()
  })

  test(`${surface}: a real not-a-repo does not look again on its own`, async ($, on) => {
    mock.store(on)
    const clock = mock.clock(on)
    const calls: string[][] = []
    fake(on, calls, false)
    await $.session.start(start(surface))
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'Pane',
      props: props(120),
      requestId: 'ide-git',
      viewport: VIEWPORT,
    })

    expect(
      await ui.find({ type: 'Text', text: /Not a git repository/ }),
    ).toBeDefined()
    const lookups = () => calls.filter(a => a.includes('--show-toplevel')).length
    const seen = lookups()
    await clock.advance(5000)
    expect(lookups()).toBe(seen)
  })

  // Changes made outside Claude: the watch looks every 2 s while the pane is up.
  const watched = async ($: Engine, on: On, answer: (argv: readonly string[]) => ReturnType<typeof result> | undefined) => {
    mock.store(on)
    const clock = mock.clock(on)
    on('ui.panes', () => ({ value: [{ id: 'ide-git', isFocused: true }] as never }))
    const calls: string[][] = []
    fake(on, calls, true, LOG, { name: 'main' }, STATUS, 0, answer)
    await $.session.start(start(surface))
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'Pane',
      props: props(120),
      requestId: 'ide-git',
      viewport: VIEWPORT,
    })

    return { ui, clock, calls }
  }

  test(`${surface}: a commit or checkout outside Claude reads the repo again after the next look`, async ($, on) => {
    let refs = 'aaa HEAD\naaa refs/heads/main\n'
    const { ui, clock, calls } = await watched($, on, argv => (argv[1] === 'show-ref' ? result(refs) : undefined))
    const logs = () => calls.filter(a => a[1] === 'log').length
    await ui.find({ key: 'all' })
    const drawn = logs()
    expect(drawn).toBeGreaterThan(0)
    // a look reads HEAD and every ref
    expect(calls).toContainEqual(['git', 'show-ref', '--head'])

    // nothing moved: nothing read again
    await clock.advance(2000)
    await ui.find({ key: 'all' })
    expect(logs()).toBe(drawn)

    refs = 'bbb HEAD\nbbb refs/heads/main\n'
    await clock.advance(2000)
    await ui.find({ key: 'all' })
    expect(logs()).toBeGreaterThan(drawn)
  })

  test(`${surface}: files changed outside Claude move the counts after the next look`, async ($, on) => {
    let tree = STATUS
    const { ui, clock, calls } = await watched($, on, argv => (argv[1] === 'status' ? result(tree) : undefined))
    for (const count of ['+1', '~1', '-1']) expect(await ui.find({ type: 'Text', text: count })).toBeDefined()
    const logs = () => calls.filter(a => a[1] === 'log').length
    const drawn = logs()

    tree = [' M b.txt', ' M d.txt', ''].join('\0')
    await clock.advance(2000)
    for (const count of ['+0', '~2', '-0']) expect(await ui.find({ type: 'Text', text: count })).toBeDefined()
    // the commits stay as read
    expect(logs()).toBe(drawn)
  })

  test(`${surface}: an aborted root lookup is not cached, a retry recovers`, async ($, on) => {
    mock.store(on)
    const clock = mock.clock(on)
    fake(on, [], true, LOG, { name: 'main' }, STATUS, 1)
    await $.session.start(start(surface))
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'Pane',
      props: props(120),
      requestId: 'ide-git',
      viewport: VIEWPORT,
    })

    expect(
      await ui.find({ type: 'Text', text: /Not a git repository/ }),
    ).toBeDefined()
    await clock.advance(1000)
    expect(
      await ui.find({ type: 'Text', text: /Not a git repository/ }),
    ).toBeUndefined()
    expect(await ui.find({ key: 'branch:develop' })).toBeDefined()
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  const bash = (command: string) => ({ tool: 'Bash', command }) as const

  test(`${surface}: a Bash call re-runs git log on the next render`, async ($, on) => {
    mock.store(on)
    const calls: string[][] = []
    fake(on, calls)
    on('tool.call', () => ({ result: {}, text: '' }) as never)
    await $.session.start(start(surface))
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'Pane',
      props: props(120),
      requestId: 'ide-git',
      viewport: VIEWPORT,
    })
    const logs = () => calls.filter(a => a[1] === 'log').length
    expect(logs()).toBe(1)

    await $.tool.call(bash('git commit -m x'))
    await ui.find({ key: 'all' })
    expect(logs()).toBe(2)
  })

  test(`${surface}: a clean tree shows +0 ~0 -0; an Edit re-runs git status`, async ($, on) => {
    mock.store(on)
    const calls: string[][] = []
    fake(on, calls, true, LOG, { name: 'main' }, '')
    on('tool.call', () => ({ result: {}, text: '' }) as never)
    await $.session.start(start(surface))
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'Pane',
      props: props(120),
      requestId: 'ide-git',
      viewport: VIEWPORT,
    })
    const statuses = () => calls.filter(a => a[1] === 'status').length
    for (const count of ['+0', '~0', '-0']) expect(await ui.find({ type: 'Text', text: count })).toBeDefined()
    expect(statuses()).toBe(1)
    expect(calls.find(a => a[1] === 'status')).toEqual([
      'git',
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
    ])

    await $.tool.call({ tool: 'Edit', file_path: '/repo/x', old_string: 'a', new_string: 'b' } as never)
    await ui.find({ key: 'all' })
    expect(statuses()).toBe(2)
  })

  test(`${surface}: no Button carries a hotkey; no refresh is drawn`, async ($, on) => {
    mock.store(on)
    const calls: string[][] = []
    fake(on, calls)
    await $.session.start(start(surface))
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'Pane',
      props: props(120),
      requestId: 'ide-git',
      viewport: VIEWPORT,
    })

    expect(await ui.find({ key: 'all' })).toBeDefined()
    expect(await ui.find({ key: 'refresh' })).toBeUndefined()
    for (const b of await ui.findAll({ type: 'Button' })) expect(b.props.hotkey).toBeUndefined()
    await ui.press({ key: 'branch:origin/main' })
    await ui.press({ key: 'all' })
    expect(
      calls.filter(a => a[1] === 'log' && a.includes('--all')).length,
    ).toBeGreaterThan(0)
  })

  test(`${surface}: fetch, pull and push run git and report in a toast`, async ($, on) => {
    mock.store(on)
    const calls: string[][] = []
    const toasts: string[] = []
    fake(on, calls)
    on('ui.toast', (_$, e) => {
      toasts.push(e.text)

      return { value: undefined }
    })
    await $.session.start(start(surface))
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'Pane',
      props: props(120),
      requestId: 'ide-git',
      viewport: VIEWPORT,
    })

    expect(await ui.find({ key: 'fetch' })).toBeDefined()
    expect(await ui.find({ key: 'pull' })).toBeDefined()
    await ui.press({ key: 'fetch' })
    expect(calls).toContainEqual(['git', 'fetch', '--all'])
    expect(toasts.at(-1)).toBe('git fetch: done')
    await ui.press({ key: 'pull' })
    expect(calls).toContainEqual(['git', 'pull', '--ff-only'])
    expect(toasts.at(-1)).toBe('git pull: failed: fatal: Not possible to fast-forward, aborting.')
    expect((await ui.find({ key: 'push' }))?.props.label).toBe('Push')
    await ui.press({ key: 'push' })
    expect(calls).toContainEqual(['git', 'push'])
    expect(toasts.at(-1)).toBe('git push: Everything up-to-date')
  })
}

const many = Array.from({ length: 40 }, (_, i) =>
  [
    String(i).padStart(40, '0'),
    String(i).padStart(7, '0'),
    String(i + 1).padStart(40, '0'),
    '',
    'a',
    '2026-01-01',
    `c${i}`,
  ].join('\x1f'),
).join('\n')

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: wheel scrolls graph and details, keys move the commit`, async ($, on) => {
    mock.store(on)
    fake(on, [], true, many)
    on('ui.focus', () => ({}))
    on('ui.scroll', () => ({}))
    await $.session.start(start(surface))
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'Pane',
      props: { ...props(160), scroll: { offset: 0, bodyRows: 14 } },
      requestId: 'ide-git',
      viewport: VIEWPORT,
    })
    const commits = async () =>
      (await ui.findAll({ type: 'Button' }))
        .map(b => b.key ?? '')
        .filter(key => key.startsWith('commit:'))
    const scroll = (by: number, pointer?: { column: number; row: number }) =>
      $.ui.scroll({
        component: 'Pane',
        requestId: 'ide-git',
        plugin: PLUGIN,
        offset: 0,
        by,
        bodyRows: 14,
        contentRows: 14,
        origin: { kind: 'person' },
        ...(pointer === undefined ? {} : { pointer }),
      } as never)
    const first = (await commits())[0]
    expect(await ui.find({ type: 'Text', text: '┃', in: 'sb:graph' })).toBeDefined()

    // wide layout: columns 32-95 are the graph
    await scroll(6, { column: 60, row: 3 })
    const after = await commits()
    expect(after[0]).not.toBe(first)
    expect(after[0]).toBe('commit:' + String(6).padStart(40, '0'))

    // an arrow key selects the next commit
    await ui.press({ key: after[0] ?? '' })
    await scroll(1)
    expect(await markOf(ui, String(7).padStart(40, '0'))).toBe('>')
  })

  test(`${surface}: wheel over Info scrolls its lines, over Commits the list`, async ($, on) => {
    mock.store(on)
    fake(on, [], true, LOG)
    on('ui.focus', () => ({}))
    on('ui.scroll', () => ({}))
    await $.session.start(start(surface))
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'Pane',
      props: { ...props(160), scroll: { offset: 0, bodyRows: 14 } },
      requestId: 'ide-git',
      viewport: VIEWPORT,
    })
    await ui.press({ key: 'commit:908022ab43fb9bc599342842219a42dfd653f899' })
    const subject = () => ui.find({ type: 'Text', text: /^908022ab43fb/ })
    expect(await subject()).toBeDefined()
    expect(await ui.find({ type: 'Code' })).toBeUndefined()
    const scroll = (by: number, pointer: { column: number; row: number }) =>
      $.ui.scroll({
        component: 'Pane',
        requestId: 'ide-git',
        plugin: PLUGIN,
        offset: 0,
        by,
        bodyRows: 14,
        contentRows: 14,
        origin: { kind: 'person' },
        pointer,
      } as never)
    // bodyRows 14: Commits rows 2-8, Info below; Info is the right column
    await scroll(1, { column: 150, row: 3 })
    expect(await subject()).toBeDefined()
    await scroll(1, { column: 150, row: 12 })
    expect(await subject()).toBeUndefined()
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  for (const columns of [100, 160]) {
    const open = async ($: Engine, on: On, calls: string[][] = [], status = STATUS) => {
      mock.store(on)
      fake(on, calls, true, LOG, { name: 'main' }, status)
      on('ui.focus', () => ({}))
      on('ui.scroll', () => ({}))
      await $.session.start(start(surface))

      return $.ui.mount({
        plugin: PLUGIN,
        surface,
        component: 'Pane',
        props: props(columns),
        requestId: 'ide-git',
        viewport: VIEWPORT,
      })
    }
    const keys = async (ui: Awaited<ReturnType<typeof open>>, prefix: string) =>
      (await ui.findAll({ type: 'Button' }))
        .map(b => b.key ?? '')
        .filter(key => key.startsWith(prefix))

    // The selected tab: the pill's filled chrome Box on terminal, the primary Button elsewhere.
    const isOn = async (ui: Awaited<ReturnType<typeof open>>, key: string) =>
      surface === 'terminal'
        ? (await ui.find({ key: key + ':chrome' }))?.props.backgroundColor !== undefined
        : (await ui.find({ key }))?.props.variant === 'primary'

    test(`${surface}/${columns}: tabs switch the panel between Overview, Graph and Change Log`, async ($, on) => {
      const ui = await open($, on)

      expect(await ui.find({ key: 'tab:overview' })).toBeDefined()
      expect(await ui.find({ key: 'tab:graph' })).toBeDefined()
      expect(await ui.find({ key: 'tab:changelog' })).toBeDefined()
      // no change count on the tab
      expect((await ui.find({ key: 'tab:changelog' }))?.props.label).toBe('Change Log')
      expect(await isOn(ui, 'tab:overview')).toBe(true)
      // Overview: Branches, Commits, Info; no Files
      expect((await ui.find({ key: 'title:branches:chrome' }))?.text).toBe(' Branches ')
      expect((await ui.find({ key: 'title:commits:chrome' }))?.text).toBe(' Commits ')
      expect((await ui.find({ key: 'title:info:chrome' }))?.text).toBe(' Info ')
      expect(await ui.find({ key: 'title:files:chrome' })).toBeUndefined()
      expect(await ui.find({ key: 'change:b.txt' })).toBeUndefined()

      await ui.press({ key: 'tab:changelog' })
      expect(await isOn(ui, 'tab:changelog')).toBe(true)
      expect((await ui.find({ key: 'title:files:chrome' }))?.text).toBe(' Files ')
      expect((await ui.find({ key: 'title:diff:chrome' }))?.text).toBe(' Diff Preview ')
      expect(await ui.find({ key: 'title:branches:chrome' })).toBeUndefined()
      expect(await ui.find({ key: 'title:commits:chrome' })).toBeUndefined()
      expect(await keys(ui, 'change:')).toEqual(['change:a.txt', 'change:b.txt', 'change:c.txt'])
      expect(await keys(ui, 'commit:')).toEqual([])

      await ui.press({ key: 'tab:graph' })
      expect((await ui.find({ key: 'title:graph:chrome' }))?.text).toBe(' Graph ')
      expect(await ui.find({ key: 'title:commits:chrome' })).toBeUndefined()
      // Graph over Info
      expect((await ui.find({ key: 'title:info:chrome' }))?.text).toBe(' Info ')
      expect(await ui.find({ key: 'title:branches:chrome' })).toBeUndefined()
      expect((await keys(ui, 'commit:')).length).toBeGreaterThan(0)

      await ui.press({ key: 'tab:overview' })
      expect((await ui.find({ key: 'title:info:chrome' }))?.text).toBe(' Info ')
    })

    test(`${surface}/${columns}: an old persisted tab 'changes' opens Change Log`, async ($, on) => {
      mock.store(on)
      fake(on, [], true, LOG, { name: 'main' }, STATUS)
      on('ui.focus', () => ({}))
      on('ui.scroll', () => ({}))
      // the value a previous version persisted
      on('state.get', (_$, e) =>
        e.key === 'git'
          ? {
              value: {
                value: { ref: 'all', offset: 0, limit: 200, branchOffset: 0, detailOffset: 0, tab: 'changes' },
                version: 1,
              },
            }
          : { value: { value: undefined, version: 0 } },
      )
      await $.session.start(start(surface))
      const ui = await $.ui.mount({
        plugin: PLUGIN,
        surface,
        component: 'Pane',
        props: props(columns),
        requestId: 'ide-git',
        viewport: VIEWPORT,
      })

      expect((await ui.find({ key: 'title:files:chrome' }))?.text).toBe(' Files ')
      expect(await isOn(ui, 'tab:changelog')).toBe(true)
    })

    test(`${surface}/${columns}: a change shows its diff; untracked uses --no-index`, async ($, on) => {
      const calls: string[][] = []
      const ui = await open($, on, calls)
      await ui.press({ key: 'tab:changelog' })

      // the first file (untracked) is selected: diffed against /dev/null, exit 1 accepted
      let code = await ui.find({ type: 'Code' })
      expect(code?.props.format).toBe('diff')
      expect(code?.text).toContain('+brand new')
      expect(calls).toContainEqual([
        'git', 'diff', '--no-index', '--color=never', '--', '/dev/null', 'a.txt',
      ])
      expect(await ui.find({ type: 'Text', text: 'untracked' })).toBeDefined()

      await ui.press({ key: 'change:b.txt' })
      code = await ui.find({ type: 'Code' })
      expect(code?.text).toContain('+new line')
      expect(await ui.find({ type: 'Text', text: 'modified' })).toBeDefined()
      expect(calls).toContainEqual([
        'git', 'diff', 'HEAD', '--color=never', '-M', '--', 'b.txt',
      ])

      // empty diff: a dim note, no Code
      await ui.press({ key: 'change:c.txt' })
      expect(await ui.find({ type: 'Code' })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: 'No textual changes.' })).toBeDefined()
    })

    test(`${surface}/${columns}: Files is a tree, no view toggle; folders collapse`, async ($, on) => {
      const ui = await open($, on, [], ['?? src/a.ts', ' M src/ui/b.ts', ' M top.txt', ''].join('\0'))
      await ui.press({ key: 'tab:changelog' })

      expect(await ui.find({ key: 'view' })).toBeUndefined()
      expect(await keys(ui, 'cdir:')).toEqual(['cdir:c:src', 'cdir:c:src/ui'])
      expect(await keys(ui, 'change:')).toEqual([
        'change:top.txt',
        'change:src/a.ts',
        'change:src/ui/b.ts',
      ])
      await ui.press({ key: 'cdir:c:src' })
      expect(await keys(ui, 'change:')).toEqual(['change:top.txt'])
      await ui.press({ key: 'cdir:c:src' })
      expect((await keys(ui, 'change:')).length).toBe(3)
      await ui.press({ key: 'cdir:c:src/ui' })
      expect(await keys(ui, 'change:')).toEqual(['change:top.txt', 'change:src/a.ts'])
    })

    test(`${surface}/${columns}: clean tree says so`, async ($, on) => {
      const ui = await open($, on, [], '')
      await ui.press({ key: 'tab:changelog' })

      expect(await ui.find({ type: 'Text', text: 'Working tree clean' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'Select a change.' })).toBeDefined()
    })

    test(`${surface}/${columns}: arrows move the selected change, wheel and scrollbar scroll`, async ($, on) => {
      const status = Array.from({ length: 40 }, (_, i) => ` M f${String(i).padStart(2, '0')}.txt`)
      const ui = await open($, on, [], [...status, ''].join('\0'))
      await ui.press({ key: 'tab:changelog' })
      const scroll = (by: number, pointer?: { column: number; row: number }) =>
        $.ui.scroll({
          component: 'Pane',
          requestId: 'ide-git',
          plugin: PLUGIN,
          offset: 0,
          by,
          bodyRows: 30,
          contentRows: 30,
          origin: { kind: 'person' },
          ...(pointer === undefined ? {} : { pointer }),
        } as never)

      expect((await keys(ui, 'change:'))[0]).toBe('change:f00.txt')
      expect(await ui.find({ key: 'sb:changes' })).toBeDefined()
      await scroll(1)
      expect((await ui.find({ type: 'Text', text: 'f01.txt' }))).toBeDefined()
      const info = await ui.find({ type: 'Text', text: 'f01.txt' })
      expect(info).toBeDefined()
      // wheel over Files moves the window, not the selection
      await scroll(5, { column: 10, row: 3 })
      expect((await keys(ui, 'change:'))[0]).toBe('change:f05.txt')
    })
  }
}

for (const surface of ['terminal', 'desktop'] as const) {
  for (const columns of [100, 160]) {
    test(`${surface}/${columns}: Graph shows author and date, and shares the selection with Overview`, async ($, on) => {
      mock.store(on)
      fake(on, [], true, LOG, { name: 'main' }, STATUS)
      on('ui.focus', () => ({}))
      on('ui.scroll', () => ({}))
      await $.session.start(start(surface))
      const ui = await $.ui.mount({
        plugin: PLUGIN,
        surface,
        component: 'Pane',
        props: props(columns),
        requestId: 'ide-git',
        viewport: VIEWPORT,
      })
      const sha = '908022ab43fb9bc599342842219a42dfd653f899'

      // Overview's compact list has neither column
      expect(await ui.find({ type: 'Text', text: /2026-07-09/ })).toBeUndefined()
      await ui.press({ key: 'tab:graph' })
      expect((await ui.find({ type: 'Text', text: / eLeSTRaGo/ }))).toBeDefined()
      expect((await ui.find({ type: 'Text', text: / 2026-07-08/ }))).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /2026-07-09/ })).toBeDefined()

      await ui.press({ key: 'commit:' + sha })
      expect(await markOf(ui, sha)).toBe('>')
      await ui.press({ key: 'tab:overview' })
      expect(await markOf(ui, sha)).toBe('>')
      expect(await ui.find({ type: 'Text', text: /^parents 06615e2/ })).toBeDefined()
    })
  }
}

const HEAD_SHA = '908022ab43fb9bc599342842219a42dfd653f899'
const MERGE_SHA = '352e0ccfcf8783cb444ee15822e54c65deb6da05'

for (const surface of ['terminal', 'desktop'] as const) {
  for (const columns of [100, 160]) {
    const open = async ($: Engine, on: On, calls: string[][] = []) => {
      mock.store(on)
      fake(on, calls, true, LOG, { name: 'main' }, STATUS)
      on('ui.focus', () => ({}))
      on('ui.scroll', () => ({}))
      await $.session.start(start(surface))

      return $.ui.mount({
        plugin: PLUGIN,
        surface,
        component: 'Pane',
        props: props(columns),
        requestId: 'ide-git',
        viewport: VIEWPORT,
      })
    }
    const keys = async (ui: Awaited<ReturnType<typeof open>>, prefix: string) =>
      (await ui.findAll({ type: 'Button' }))
        .map(b => b.key ?? '')
        .filter(key => key.startsWith(prefix))

    test(`${surface}/${columns}: every commit row has a diff button, kept when a commit is selected`, async ($, on) => {
      const ui = await open($, on)

      for (const tab of ['tab:overview', 'tab:graph']) {
        await ui.press({ key: tab })
        expect((await keys(ui, 'diff:')).length).toBe(9)
        expect((await ui.find({ key: 'diff:' + HEAD_SHA }))?.props.label).toContain('⧉')
        await ui.press({ key: 'commit:' + HEAD_SHA })
        expect((await keys(ui, 'diff:')).length).toBe(9)
      }
    })

    test(`${surface}/${columns}: a diff button opens Files | Diff Preview for that commit; a file shows only its hunks`, async ($, on) => {
      const calls: string[][] = []
      const ui = await open($, on, calls)

      await ui.press({ key: 'diff:' + HEAD_SHA })
      expect(calls).toContainEqual([
        'git', '-c', 'core.quotePath=false', 'show', '--name-status', '-M', '--diff-merges=first-parent', '--format=', HEAD_SHA,
      ])
      expect(calls.some(a => a.includes('show') && a.includes('--patch') && a.includes('--diff-merges=first-parent'))).toBe(true)
      expect((await ui.find({ key: 'title:files:chrome' }))?.text).toMatch(/^ Files · 9/)
      expect((await ui.find({ key: 'title:diff:chrome' }))?.text).toBe(' Diff Preview ')
      expect(await ui.find({ key: 'title:branches:chrome' })).toBeUndefined()
      expect(await ui.find({ key: 'title:commits:chrome' })).toBeUndefined()
      expect(await keys(ui, 'commit:')).toEqual([])
      // a tree: the top level's files before its folders
      expect(await keys(ui, 'dfile:')).toEqual([
        'dfile:CHANGELOG.md',
        'dfile:old.txt',
        'dfile:docs/read me.md',
        'dfile:plugin/package.json',
        'dfile:src/b.ts',
      ])
      expect(await ui.find({ key: 'back' })).toBeDefined()
      // the first file is shown
      let code = await ui.find({ type: 'Code' })
      expect(code?.text).toContain('+changelog line')
      expect(code?.text).not.toContain('0.7.1')

      await ui.press({ key: 'dfile:plugin/package.json' })
      code = await ui.find({ type: 'Code' })
      expect(code?.text).toContain('0.7.1')
      expect(code?.text).not.toContain('changelog line')

      await ui.press({ key: 'dfile:docs/read me.md' })
      expect((await ui.find({ type: 'Code' }))?.text).toContain('+spaced path')
      // the patch was fetched once
      expect(calls.filter(a => a.includes('show') && a.includes('--patch')).length).toBe(1)
    })

    test(`${surface}/${columns}: a merge commit lists its first-parent files`, async ($, on) => {
      const calls: string[][] = []
      const ui = await open($, on, calls)

      await ui.press({ key: 'diff:' + MERGE_SHA })
      expect(await keys(ui, 'dfile:')).toEqual(['dfile:from-develop.txt'])
      expect((await ui.find({ type: 'Code' }))?.text).toContain('+merged in')
      expect(calls.filter(a => a.includes('show') && a.includes('--diff-merges=first-parent')).length).toBe(2)
    })

    test(`${surface}/${columns}: back returns to the tab it came from, selection kept`, async ($, on) => {
      const ui = await open($, on)

      await ui.press({ key: 'tab:graph' })
      await ui.press({ key: 'diff:' + HEAD_SHA })
      expect(await ui.find({ key: 'title:graph:chrome' })).toBeUndefined()
      await ui.press({ key: 'back' })
      expect(await ui.find({ key: 'back' })).toBeUndefined()
      expect((await ui.find({ key: 'title:graph:chrome' }))?.text).toBe(' Graph ')
      expect(await markOf(ui, HEAD_SHA)).toBe('>')
      expect(await keys(ui, 'dfile:')).toEqual([])

      // from Overview, and a tab press closes the view too
      await ui.press({ key: 'tab:overview' })
      await ui.press({ key: 'diff:' + MERGE_SHA })
      expect(await keys(ui, 'dfile:')).toEqual(['dfile:from-develop.txt'])
      await ui.press({ key: 'back' })
      expect((await ui.find({ key: 'title:info:chrome' }))?.text).toBe(' Info ')
      expect(await markOf(ui, MERGE_SHA)).toBe('>')
      await ui.press({ key: 'diff:' + MERGE_SHA })
      await ui.press({ key: 'tab:graph' })
      expect(await ui.find({ key: 'back' })).toBeUndefined()
      expect((await ui.find({ key: 'title:graph:chrome' }))?.text).toBe(' Graph ')
    })

    test(`${surface}/${columns}: the diff view lists files as a tree, arrows move the file`, async ($, on) => {
      const ui = await open($, on)
      await ui.press({ key: 'diff:' + HEAD_SHA })

      expect(await ui.find({ key: 'view' })).toBeUndefined()
      expect(await keys(ui, 'cdir:')).toEqual(['cdir:c:docs', 'cdir:c:plugin', 'cdir:c:src'])
      const scroll = (by: number) =>
        $.ui.scroll({
          component: 'Pane',
          requestId: 'ide-git',
          plugin: PLUGIN,
          offset: 0,
          by,
          bodyRows: 30,
          contentRows: 30,
          origin: { kind: 'person' },
        } as never)
      // files before folders: CHANGELOG.md, then old.txt
      await scroll(1)
      expect((await ui.find({ type: 'Code' }))?.text).toContain('-gone')
    })
  }
}

// `$.store` from a Map the test reads back.
const memoryStore = (on: On, store: Map<string, unknown>) => {
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, e.value)

    return { value: undefined }
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  const open = async ($: Engine, on: On, columns: number, bodyRows: number, store?: Map<string, unknown>) => {
    if (store === undefined) mock.store(on)
    else memoryStore(on, store)
    fake(on, [], true, LOG, { name: 'main' }, STATUS)
    on('ui.focus', () => ({}))
    on('ui.scroll', () => ({}))
    await $.session.start(start(surface))

    return $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'Pane',
      props: { ...props(columns), scroll: { offset: 0, bodyRows } },
      requestId: 'ide-git',
      viewport: VIEWPORT,
    })
  }
  const cellsOf = async (ui: Awaited<ReturnType<typeof open>>, key: string) => {
    const props = (await ui.find({ key }))?.props.props as { cells?: number } | undefined

    return props?.cells
  }
  const scrollAt = ($: Engine, bodyRows: number, by: number, column: number, row: number) =>
    $.ui.scroll({
      component: 'Pane',
      requestId: 'ide-git',
      plugin: PLUGIN,
      offset: 0,
      by,
      bodyRows,
      contentRows: bodyRows,
      origin: { kind: 'person' },
      pointer: { column, row },
    } as never)

  test(`${surface}: switching Overview/Graph keeps the selected commit in view with its diff button`, async ($, on) => {
    const ui = await open($, on, 160, 14)
    const keys = async () =>
      (await ui.findAll({ type: 'Button' })).map(b => b.key ?? '').filter(k => k.startsWith('commit:'))
    const all = await keys()
    await scrollAt($, 14, 20, 60, 3)
    const last = (await keys()).at(-1) ?? ''
    expect(all.includes(last)).toBe(false)
    await ui.press({ key: last })
    for (const tab of ['tab:graph', 'tab:overview']) {
      await ui.press({ key: tab })
      expect(await keys()).toContain(last)
      expect(await ui.find({ key: 'diff:' + last.slice('commit:'.length) })).toBeDefined()
    }
  })

  test(`${surface}: dragging the Branches seam widens Branches and wheel routing follows`, async ($, on) => {
    const ui = await open($, on, 160, 14)
    const commits = async () =>
      (await ui.findAll({ type: 'Button' }))
        .map(b => b.key ?? '')
        .filter(key => key.startsWith('commit:'))
    expect(await cellsOf(ui, 'split:side')).toBe(32)

    await ui.pointer({ type: 'down', button: 'left', x: 0, y: 5, in: 'split:side' })
    await ui.pointer({ type: 'move', button: 'left', x: 10, y: 5, in: 'split:side' })
    expect(await cellsOf(ui, 'split:side')).toBe(42)
    // the seam moved under the pointer: the same pointer now reads 0 again
    await ui.pointer({ type: 'move', button: 'left', x: 0, y: 5, in: 'split:side' })
    expect(await cellsOf(ui, 'split:side')).toBe(42)
    await ui.pointer({ type: 'up', button: 'left', x: 0, y: 5, in: 'split:side' })
    expect(await cellsOf(ui, 'split:side')).toBe(42)

    // column 40 was Commits, now Branches: the wheel no longer moves the list
    const first = (await commits())[0]
    await scrollAt($, 14, 6, 40, 3)
    expect((await commits())[0]).toBe(first)
    await scrollAt($, 14, 6, 60, 3)
    expect((await commits())[0]).not.toBe(first)

    // a drag far left stops at the minimum
    await ui.pointer({ type: 'down', button: 'left', x: 0, y: 5, in: 'split:side' })
    await ui.pointer({ type: 'move', button: 'left', x: -100, y: 5, in: 'split:side' })
    expect(await cellsOf(ui, 'split:side')).toBe(12)
    await ui.pointer({ type: 'up', button: 'left', x: 0, y: 5, in: 'split:side' })
  })

  test(`${surface}: a stored layout:git sizes Branches; a drag's release writes it`, async ($, on) => {
    const store = new Map<string, unknown>([['layout:git', { side: 0.4, files: 0.5 }]])
    const ui = await open($, on, 160, 14, store)
    // 40% of 160 body columns
    expect(await cellsOf(ui, 'split:side')).toBe(64)

    await ui.pointer({ type: 'down', button: 'left', x: 0, y: 5, in: 'split:side' })
    await ui.pointer({ type: 'move', button: 'left', x: -10, y: 5, in: 'split:side' })
    expect(await cellsOf(ui, 'split:side')).toBe(54)
    // mid-drag moves don't write
    expect(store.get('layout:git')).toEqual({ side: 0.4, files: 0.5 })
    await ui.pointer({ type: 'up', button: 'left', x: 0, y: 5, in: 'split:side' })
    const saved = store.get('layout:git') as { side?: number; info?: number; files?: number }
    expect(Math.round((saved.side ?? 0) * 160)).toBe(54)
    expect(saved.info).toBeUndefined()
    // the stored Files width rides along
    expect(saved.files).toBe(0.5)
  })

  for (const value of ['x', { side: 7, info: -1, files: 'a' }])
    test(`${surface}: a garbage layout:git (${JSON.stringify(value)}) falls back to the default`, async ($, on) => {
      const ui = await open($, on, 160, 14, new Map<string, unknown>([['layout:git', value]]))
      expect(await cellsOf(ui, 'split:side')).toBe(32)
    })

  test(`${surface}: dragging the Commits/Info seam moves the Info boundary`, async ($, on) => {
    const ui = await open($, on, 160, 30)
    const before = (await cellsOf(ui, 'split:info')) ?? 0
    expect(before).toBe(Math.floor(28 * 0.6))

    await ui.pointer({ type: 'down', button: 'left', x: 3, y: 0, in: 'split:info' })
    await ui.pointer({ type: 'move', button: 'left', x: 3, y: 4, in: 'split:info' })
    await ui.pointer({ type: 'up', button: 'left', x: 3, y: 0, in: 'split:info' })
    expect(await cellsOf(ui, 'split:info')).toBe(before + 4)
  })

  test(`${surface}: the Branches seam takes a grab on Commits' border too`, async ($, on) => {
    const ui = await open($, on, 160, 14)
    const seam = await ui.find({ key: 'split:side' })
    expect(seam?.props.width).toBe(2)
    expect((seam?.props.props as { span?: number } | undefined)?.span).toBe(2)
    expect(await cellsOf(ui, 'split:side')).toBe(32)

    await ui.pointer({ type: 'down', button: 'left', x: 1, y: 5, in: 'split:side' })
    await ui.pointer({ type: 'move', button: 'left', x: 11, y: 5, in: 'split:side' })
    expect(await cellsOf(ui, 'split:side')).toBe(42)
    await ui.pointer({ type: 'up', button: 'left', x: 1, y: 5, in: 'split:side' })
    expect(await cellsOf(ui, 'split:side')).toBe(42)
  })

  test(`${surface}: the Branches seam keeps Commits' and Info's left corners`, async ($, on) => {
    const ui = await open($, on, 160, 14)
    const topRows = (await cellsOf(ui, 'split:info')) ?? 0
    const marks = ((await ui.find({ key: 'split:side' }))?.props.props as { marks?: unknown } | undefined)?.marks
    expect(marks).toEqual([
      { row: topRows - 2, text: '╰' },
      { row: topRows - 1, text: '╭' },
    ])
    // one outer Text per seam row; a marked row nests its corner Text
    const rows = (await ui.findAll({ type: 'Text', in: 'split:side' }))
      .map(text => text.text)
      .filter(text => text.length === 2)
    expect(rows[topRows - 3]).toBe('││')
    expect(rows[topRows - 2]).toBe('│╰')
    expect(rows[topRows - 1]).toBe('│╭')
    expect(rows[topRows]).toBe('││')
    // held, the corners stay
    await ui.pointer({ type: 'down', button: 'left', x: 0, y: 1, in: 'split:side' })
    const held = (await ui.findAll({ type: 'Text', in: 'split:side' })).map(text => text.text)
    expect(held).toContain('│╰')
    expect(held).toContain('│╭')
    await ui.pointer({ type: 'up', button: 'left', x: 0, y: 1, in: 'split:side' })
  })

  test(`${surface}: the Commits/Info seam takes a grab on Info's border too`, async ($, on) => {
    const ui = await open($, on, 160, 40)
    const seam = await ui.find({ key: 'split:info' })
    expect(seam?.props.height).toBe(2)
    const before = (await cellsOf(ui, 'split:info')) ?? 0

    await ui.pointer({ type: 'down', button: 'left', x: 3, y: 1, in: 'split:info' })
    await ui.pointer({ type: 'move', button: 'left', x: 3, y: 11, in: 'split:info' })
    // the seam moved under the pointer: the same spot reads y 1 again
    await ui.pointer({ type: 'up', button: 'left', x: 3, y: 1, in: 'split:info' })
    expect(await cellsOf(ui, 'split:info')).toBe(before + 10)
    // Info keeps its title over the seam
    expect(await ui.find({ key: 'title:info:chrome' })).toBeDefined()
  })

  test(`${surface}: Graph draws Graph over Info, the selected commit's head in Info`, async ($, on) => {
    const ui = await open($, on, 160, 30)
    await ui.press({ key: 'tab:graph' })
    await ui.press({ key: 'commit:' + HEAD_SHA })
    expect(await ui.find({ key: 'title:graph:chrome' })).toBeDefined()
    expect(await ui.find({ key: 'title:info:chrome' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^908022ab43fb/ })).toBeDefined()
    // area 28: Graph takes 65%, Info the rest
    expect(await cellsOf(ui, 'split:graph')).toBe(Math.floor(28 * 0.65))
    expect(await ui.find({ key: 'split:info' })).toBeUndefined()
  })

  test(`${surface}: dragging the Graph/Info seam resizes and saves layout:git.graph; Overview keeps its own`, async ($, on) => {
    const store = new Map<string, unknown>()
    const ui = await open($, on, 160, 30, store)
    const info = (await cellsOf(ui, 'split:info')) ?? 0
    await ui.press({ key: 'tab:graph' })
    const before = (await cellsOf(ui, 'split:graph')) ?? 0

    await ui.pointer({ type: 'down', button: 'left', x: 3, y: 0, in: 'split:graph' })
    await ui.pointer({ type: 'move', button: 'left', x: 3, y: -4, in: 'split:graph' })
    expect(store.get('layout:git')).toBeUndefined()
    await ui.pointer({ type: 'up', button: 'left', x: 3, y: 0, in: 'split:graph' })
    expect(await cellsOf(ui, 'split:graph')).toBe(before - 4)
    // stored as Info's share, as `info` is
    const saved = store.get('layout:git') as { graph?: number; info?: number }
    expect(Math.round((1 - (saved.graph ?? 0)) * 28)).toBe(before - 4)
    expect(saved.info).toBeUndefined()
    expect(await ui.find({ key: 'title:info:chrome' })).toBeDefined()

    await ui.press({ key: 'tab:overview' })
    expect(await cellsOf(ui, 'split:info')).toBe(info)
    expect(await ui.find({ key: 'split:graph' })).toBeUndefined()
  })

  test(`${surface}: in Graph the wheel over Info scrolls Info, over the list the list`, async ($, on) => {
    const ui = await open($, on, 160, 14)
    await ui.press({ key: 'tab:graph' })
    await ui.press({ key: 'commit:' + HEAD_SHA })
    const commits = async () =>
      (await ui.findAll({ type: 'Button' }))
        .map(b => b.key ?? '')
        .filter(key => key.startsWith('commit:'))
    const subject = () => ui.find({ type: 'Text', text: /^908022ab43fb/ })
    expect(await subject()).toBeDefined()
    // bodyRows 14: area 12, Graph rows 1-7, Info from row 8
    const first = (await commits())[0]
    await scrollAt($, 14, 1, 60, 12)
    expect(await subject()).toBeUndefined()
    expect((await commits())[0]).toBe(first)
    await scrollAt($, 14, 2, 60, 3)
    expect((await commits())[0]).not.toBe(first)
  })

  test(`${surface}: dragging the Files seam resizes Files in Change Log`, async ($, on) => {
    const ui = await open($, on, 100, 30)
    await ui.press({ key: 'tab:changelog' })
    expect(await cellsOf(ui, 'split:files')).toBe(30)
    await ui.pointer({ type: 'down', button: 'left', x: 0, y: 3, in: 'split:files' })
    await ui.pointer({ type: 'move', button: 'left', x: -8, y: 3, in: 'split:files' })
    await ui.pointer({ type: 'up', button: 'left', x: 0, y: 3, in: 'split:files' })
    expect(await cellsOf(ui, 'split:files')).toBe(22)
  })
}

// Horizontal bars: a line wider than Info or Diff Preview draws one on the
// section's bottom border; a drag moves the first column shown.
// 300 columns, column 5k starting `w<k>`, so a slice shows where it starts.
const WIDE_LINE = Array.from({ length: 60 }, (_, i) => ('w' + i).padEnd(5, '.')).join('')
const WIDE_STAT = STAT.replace('oh-my-project v0.7.1', WIDE_LINE)
const WIDE_DIFF =
  'diff --git a/b.txt b/b.txt\nindex 111..222 100644\n--- a/b.txt\n+++ b/b.txt\n' +
  '@@ -1,2 +1,2 @@\n keep\n-old line\n+' + WIDE_LINE + '\n' +
  '@@ -40,2 +40,2 @@\n tail\n-gone\n+came\n'
const WIDE_PATCH =
  'diff --git a/CHANGELOG.md b/CHANGELOG.md\nindex 2ab3741..af8640a 100644\n--- a/CHANGELOG.md\n+++ b/CHANGELOG.md\n' +
  '@@ -1 +1,2 @@\n keep\n+' + WIDE_LINE + '\n'

const wide = (argv: readonly string[]) => {
  const sub = argv[1] === '-c' ? argv[3] : argv[1]
  if (sub === 'show' && argv.includes('--stat')) return result(WIDE_STAT)
  if (sub === 'show' && !argv.includes('--name-status') && !(argv.at(-1) ?? '').startsWith('352e0cc')) {
    return result(WIDE_PATCH)
  }
  if (sub === 'diff' && argv.includes('b.txt')) return result(WIDE_DIFF)

  return undefined
}

for (const surface of ['terminal', 'desktop'] as const) {
  const open = async ($: Engine, on: On, isWide = true) => {
    mock.store(on)
    fake(on, [], true, LOG, { name: 'main' }, STATUS, 0, isWide ? wide : undefined)
    on('ui.focus', () => ({}))
    on('ui.scroll', () => ({}))
    await $.session.start(start(surface))

    return $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'Pane',
      props: props(100),
      requestId: 'ide-git',
      viewport: VIEWPORT,
    })
  }
  type Ui = Awaited<ReturnType<typeof open>>
  const drag = async (ui: Ui, key: string, to: number) => {
    await ui.pointer({ type: 'down', button: 'left', x: 0, y: 0, in: key })
    await ui.pointer({ type: 'move', button: 'left', x: to, y: 0, in: key })
    await ui.pointer({ type: 'up', button: 'left', x: to, y: 0, in: key })
  }
  const barOf = async (ui: Ui, key: string) =>
    (await ui.find({ key }))?.props.props as { axis?: string; offset: number; total: number; visible: number } | undefined
  // what every Text shows (a found Text carries no key)
  const texts = async (ui: Ui) => (await ui.findAll({ type: 'Text' })).map(text => text.text)
  const hunks = (source: string) => source.split('\n').filter(line => line.startsWith('@@'))

  test(`${surface}: a wide Info line draws hb:info; a drag shifts Info's lines`, async ($, on) => {
    const ui = await open($, on)
    await ui.press({ key: 'commit:' + HEAD_SHA })
    const before = ['eLeSTRaGo <elestrago63@gmail.com>', WIDE_LINE]
    for (const line of before) expect(await texts(ui)).toContain(line)
    const bar = await barOf(ui, 'hb:info')
    expect(bar?.axis).toBe('x')
    expect(bar?.offset).toBe(0)
    expect(bar?.total).toBe(300)

    await drag(ui, 'hb:info', 20)
    const left = (await barOf(ui, 'hb:info'))?.offset ?? 0
    expect(left).toBeGreaterThan(0)
    const shown = await texts(ui)
    // a line scrolled past its end draws a space
    for (const line of before) expect(shown).toContain(sliceCols(line, left) || ' ')
    expect(shown).not.toContain(WIDE_LINE)

    // another commit: back to column 0
    const other = (await ui.findAll({ type: 'Button' }))
      .map(b => b.key ?? '')
      .find(key => key.startsWith('commit:') && key !== 'commit:' + HEAD_SHA)
    await ui.press({ key: other ?? '' })
    expect((await barOf(ui, 'hb:info'))?.offset).toBe(0)
  })

  test(`${surface}: in Graph, hb:info spans the panel's width`, async ($, on) => {
    const ui = await open($, on)
    await ui.press({ key: 'commit:' + HEAD_SHA })
    const overview = (await barOf(ui, 'hb:info'))?.visible ?? 0
    await ui.press({ key: 'tab:graph' })
    // 100 columns past the frame and the vertical bar
    expect((await barOf(ui, 'hb:info'))?.visible).toBe(97)
    expect(overview).toBeLessThan(97)
    await drag(ui, 'hb:info', 20)
    expect((await barOf(ui, 'hb:info'))?.offset).toBeGreaterThan(0)
    expect(await texts(ui)).not.toContain(WIDE_LINE)
  })

  test(`${surface}: Info scrolled past its short lines keeps one Text row per line`, async ($, on) => {
    const ui = await open($, on)
    await ui.press({ key: 'commit:' + HEAD_SHA })
    await drag(ui, 'hb:info', 1000)
    const left = (await barOf(ui, 'hb:info'))?.offset ?? 0
    expect(left).toBeGreaterThan('eLeSTRaGo <elestrago63@gmail.com>'.length)
    const shown = await texts(ui)
    // a line shorter than `left` draws a space, not an empty Text (zero rows)
    expect(shown).not.toContain('')
    expect(shown).toContain(' ')
    expect(shown).toContain(sliceCols(WIDE_LINE, left))
  })

  test(`${surface}: short Info and Diff Preview lines draw no bar`, async ($, on) => {
    const ui = await open($, on, false)
    await ui.press({ key: 'commit:' + HEAD_SHA })
    expect(await ui.find({ key: 'hb:info' })).toBeUndefined()
    await ui.press({ key: 'tab:changelog' })
    await ui.press({ key: 'change:b.txt' })
    expect(await ui.find({ type: 'Code' })).toBeDefined()
    expect(await ui.find({ key: 'hb:details' })).toBeUndefined()
  })

  test(`${surface}: a wide change draws hb:details; a drag slices the diff and head, @@ kept`, async ($, on) => {
    const ui = await open($, on)
    await ui.press({ key: 'tab:changelog' })
    await ui.press({ key: 'change:b.txt' })
    const source = () => ui.find({ type: 'Code' }).then(code => String(code?.props.source ?? ''))
    const whole = await source()
    expect(whole).toContain('+' + WIDE_LINE)
    expect(await texts(ui)).toContain('modified')
    const bar = await barOf(ui, 'hb:details')
    expect(bar?.offset).toBe(0)
    // the body line's marker and the diff gutter (" 41 ") count
    expect(bar?.total).toBe(301 + 4)

    // a short drag, so the head line `modified` is cut, not gone
    await drag(ui, 'hb:details', 1)
    const left = (await barOf(ui, 'hb:details'))?.offset ?? 0
    expect(left).toBeGreaterThan(0)
    expect(left).toBeLessThan(8)
    const sliced = await source()
    expect(hunks(sliced)).toEqual(hunks(whole))
    expect(sliced).toContain('\n+' + sliceCols(WIDE_LINE, left) + '\n')
    expect(sliced).not.toContain('+' + WIDE_LINE)
    expect(await texts(ui)).toContain(sliceCols('modified', left))
    expect(await texts(ui)).not.toContain('modified')

    // another file: column 0, and its short diff draws no bar
    await ui.press({ key: 'change:a.txt' })
    expect(await ui.find({ key: 'hb:details' })).toBeUndefined()
    await ui.press({ key: 'change:b.txt' })
    expect((await barOf(ui, 'hb:details'))?.offset).toBe(0)
    expect(await source()).toBe(whole)
  })

  test(`${surface}: the diff view's Diff Preview scrolls sideways too`, async ($, on) => {
    const ui = await open($, on)
    await ui.press({ key: 'diff:' + HEAD_SHA })
    await ui.press({ key: 'dfile:CHANGELOG.md' })
    const source = () => ui.find({ type: 'Code' }).then(code => String(code?.props.source ?? ''))
    const whole = await source()
    expect(whole).toContain('+' + WIDE_LINE)
    expect(await barOf(ui, 'hb:details')).toBeDefined()

    await drag(ui, 'hb:details', 30)
    const left = (await barOf(ui, 'hb:details'))?.offset ?? 0
    expect(left).toBeGreaterThan(0)
    const sliced = await source()
    expect(hunks(sliced)).toEqual(hunks(whole))
    expect(sliced).toContain('+' + sliceCols(WIDE_LINE, left))

    // back closes the view: column 0 again
    await ui.press({ key: 'back' })
    await ui.press({ key: 'diff:' + HEAD_SHA })
    expect((await barOf(ui, 'hb:details'))?.offset).toBe(0)
  })
}

// The Commits hover card: the pointer resting on a dot for 600 ms lists the
// branches containing that row's commit (`git branch -a --contains`).
const CONTAINS =
  'refs/heads/develop\nrefs/heads/fix/delivery-readiness\nrefs/remotes/origin/HEAD\nrefs/remotes/origin/develop\nrefs/remotes/origin/main\n'

for (const surface of ['terminal', 'desktop'] as const) {
  const open = async ($: Engine, on: On, calls: string[][] = [], contains = CONTAINS) => {
    mock.store(on)
    fake(on, calls, true, LOG, { name: 'main' }, STATUS, 0, argv =>
      argv[1] === 'branch' && argv.includes('--contains') ? result(contains) : undefined,
    )
    on('ui.focus', () => ({}))
    on('ui.scroll', () => ({}))
    await $.session.start(start(surface))

    return $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'Pane',
      props: props(100),
      requestId: 'ide-git',
      viewport: VIEWPORT,
    })
  }
  type Ui = Awaited<ReturnType<typeof open>>
  // A Branches row Client's props (`k`: a folder key or `b:<branch>`).
  const rowOf = async (ui: Ui, k: string) =>
    (await ui.find({ key: 'bitem:' + k }))?.props.props as Record<string, unknown> | undefined
  const cardLines = async (ui: Ui) => {
    const card = await ui.find({ key: 'card' })
    if (card === undefined) return undefined

    return (await ui.findAll({ type: 'Text' })).map(text => text.text)
  }

  test(`${surface}: resting on a dot shows the commit's branches under Local and Remote`, async ($, on) => {
    const calls: string[][] = []
    const ui = await open($, on, calls)
    await ui.pointer({ type: 'move', x: 0, y: 2, in: 'dots' })
    await ui.advance(600)

    const lines = (await cardLines(ui)) ?? []
    const order = [
      'Branches · 908022a',
      'Local',
      '* develop',
      '  fix/delivery-readiness',
      'Remote',
      '  origin/develop',
      '  origin/main',
    ].map(line => lines.indexOf(line))
    expect(order.every(at => at >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(lines).not.toContain('  origin/HEAD')
    // the hovered commit's branches are fetched once (Info fetched the selected one's)
    expect(
      calls.filter(a => a[1] === 'branch' && a.includes('--contains') && a.includes(HEAD_SHA)),
    ).toEqual([['git', 'branch', '-a', '--contains', HEAD_SHA, '--format=%(refname)']])
    expect((await ui.find({ type: 'Text', text: /^Local$/ }))?.props.bold).toBe(true)
    expect((await ui.find({ type: 'Text', text: /^Remote$/ }))?.props.bold).toBe(true)
    const remote = await ui.find({ type: 'Text', text: '  origin/main' })
    expect(remote?.props.color).toBe(DARK.muted)
  })

  test(`${surface}: a local-only card has no Remote heading`, async ($, on) => {
    const ui = await open($, on, [], 'refs/heads/develop\n')
    await ui.pointer({ type: 'move', x: 0, y: 2, in: 'dots' })
    await ui.advance(600)
    const lines = (await cardLines(ui)) ?? []
    expect(lines).toContain('Local')
    expect(lines).toContain('* develop')
    expect(lines).not.toContain('Remote')
  })

  test(`${surface}: the card caps each group at 4, a lone group at 8`, async ($, on) => {
    const names = (pre: string, n: number) =>
      Array.from({ length: n }, (_, i) => pre + (i + 1)).join('\n') + '\n'
    const both = names('refs/heads/b', 6) + names('refs/remotes/o/r', 6)
    const ui = await open($, on, [], both)
    await ui.pointer({ type: 'move', x: 0, y: 2, in: 'dots' })
    await ui.advance(600)
    const lines = (await cardLines(ui)) ?? []
    expect(lines).toContain('  b4')
    expect(lines).not.toContain('  b5')
    expect(lines).toContain('  o/r4')
    expect(lines).not.toContain('  o/r5')
    expect(lines.filter(line => line === '  +2 more')).toHaveLength(2)
    // Info holds the whole list
    expect(await ui.find({ type: 'Text', text: /^local {2}b1, b2, b3, b4, b5, b6$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^remote o\/r1, o\/r2, o\/r3, o\/r4, o\/r5, o\/r6$/ })).toBeDefined()
  })

  test(`${surface}: a lone group lists 8 names`, async ($, on) => {
    const ten = Array.from({ length: 10 }, (_, i) => 'refs/heads/b' + (i + 1)).join('\n') + '\n'
    const ui = await open($, on, [], ten)
    await ui.pointer({ type: 'move', x: 0, y: 2, in: 'dots' })
    await ui.advance(600)
    const lines = (await cardLines(ui)) ?? []
    expect(lines).toContain('  b8')
    expect(lines).not.toContain('  b9')
    expect(lines).toContain('  +2 more')
    expect(lines).not.toContain('Remote')
    // the flipped or not, the card's bottom border stays inside Commits
    const card = await ui.find({ key: 'card' })
    const rows = ((await ui.find({ key: 'dots' }))?.props.height as number | undefined) ?? 0
    expect(card?.props.top).toBeLessThan(rows)
  })

  test(`${surface}: Info lists the selected commit's local and remote branches`, async ($, on) => {
    const ui = await open($, on)
    expect(await ui.find({ type: 'Text', text: /^local {2}\*develop, fix\/delivery-readiness$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^remote origin\/develop, origin\/main$/ })).toBeDefined()
    await ui.press({ key: 'tab:graph' })
    expect(await ui.find({ type: 'Text', text: /^local {2}\*develop/ })).toBeDefined()
  })

  test(`${surface}: Branches groups rows under Local and Remote; pressing Remote hides its rows`, async ($, on) => {
    const ui = await open($, on)
    expect(await rowOf(ui, 'l:')).toMatchObject({ label: 'Local (2)', isGroup: true, isOpen: true, isRemote: false })
    expect(await ui.find({ key: 'bdir:r:' })).toBeDefined()
    expect(await ui.find({ key: 'branch:origin/main' })).toBeDefined()
    expect(await ui.find({ key: 'branch:develop' })).toBeDefined()
    await ui.press({ key: 'bdir:r:' })
    expect(await ui.find({ key: 'branch:origin/main' })).toBeUndefined()
    expect(await ui.find({ key: 'bdir:r:origin' })).toBeUndefined()
    expect(await rowOf(ui, 'r:')).toMatchObject({ label: 'Remote (6)', isOpen: false })
    expect(await ui.find({ key: 'branch:develop' })).toBeDefined()
  })

  test(`${surface}: a Branches row's arrow opens and closes a category or folder`, async ($, on) => {
    const ui = await open($, on)
    expect(await rowOf(ui, 'r:origin')).toMatchObject({ label: 'origin/', isFolder: true, isRemote: true })
    await ui.post({ hit: 'arrow' }, { in: 'bitem:r:origin' })
    expect(await rowOf(ui, 'r:origin')).toMatchObject({ isOpen: false })
    expect(await ui.find({ key: 'bitem:b:origin/main' })).toBeUndefined()
    await ui.post({ hit: 'arrow' }, { in: 'bitem:r:origin' })
    expect(await ui.find({ key: 'bitem:b:origin/main' })).toBeDefined()
    await ui.post({ hit: 'arrow' }, { in: 'bitem:r:' })
    expect(await ui.find({ key: 'bitem:r:origin' })).toBeUndefined()
    expect(await rowOf(ui, 'r:')).toMatchObject({ isOpen: false })
  })

  test(`${surface}: a click on a Branches arrow (pointer) toggles the folder`, async ($, on) => {
    const ui = await open($, on)
    // depth 1: bar (x 0), one rail (x 1-2), the arrow at x 3-4
    await ui.pointer({ type: 'down', x: 3, y: 0, button: 'left', in: 'bitem:r:origin' })
    await ui.pointer({ type: 'up', x: 3, y: 0, button: 'left', in: 'bitem:r:origin' })
    expect(await rowOf(ui, 'r:origin')).toMatchObject({ isOpen: false })
  })

  test(`${surface}: a name click selects a branch and does nothing on a folder`, async ($, on) => {
    const calls: string[][] = []
    const ui = await open($, on, calls)
    await ui.post({ hit: 'name' }, { in: 'bitem:b:origin/main' })
    expect(await rowOf(ui, 'b:origin/main')).toMatchObject({ isSelected: true })
    expect(calls.some(a => a[1] === 'log' && a.at(-1) === 'origin/main')).toBe(true)
    await ui.post({ hit: 'name' }, { in: 'bitem:r:origin' })
    expect(await rowOf(ui, 'r:origin')).toMatchObject({ isOpen: true })
    expect(await rowOf(ui, 'b:origin/main')).toMatchObject({ isSelected: true })
  })

  test(`${surface}: a double-click copies the full ref, a folder's prefix, nothing on a category`, async ($, on) => {
    const copied: string[] = []
    const toasts: string[] = []
    on('ui.copy', (_$, e) => {
      copied.push(e.text)

      return { value: { isCopied: true } }
    })
    on('ui.toast', (_$, e) => {
      toasts.push(e.text)

      return { value: undefined }
    })
    const ui = await open($, on)
    await ui.post({ hit: 'double' }, { in: 'bitem:b:origin/main' })
    expect(copied).toEqual(['origin/main'])
    expect(toasts.at(-1)).toBe('Copied: origin/main')
    await ui.post({ hit: 'double' }, { in: 'bitem:r:origin' })
    expect(copied).toEqual(['origin/main', 'origin/'])
    expect(toasts.at(-1)).toBe('Copied: origin/')
    await ui.post({ hit: 'double' }, { in: 'bitem:r:' })
    expect(copied).toEqual(['origin/main', 'origin/'])
    expect(await rowOf(ui, 'r:')).toMatchObject({ isOpen: true })
  })

  test(`${surface}: a move rested only 200 ms shows no card`, async ($, on) => {
    const ui = await open($, on)
    await ui.pointer({ type: 'move', x: 0, y: 2, in: 'dots' })
    await ui.advance(200)
    expect(await ui.find({ key: 'card' })).toBeUndefined()
    // moving to another row starts the wait over
    await ui.pointer({ type: 'move', x: 0, y: 3, in: 'dots' })
    await ui.advance(500)
    expect(await ui.find({ key: 'card' })).toBeUndefined()
    await ui.advance(100)
    expect(await ui.find({ type: 'Text', text: 'Branches · 06615e2' })).toBeDefined()
  })

  test(`${surface}: leaving the dots removes the card`, async ($, on) => {
    const ui = await open($, on)
    await ui.pointer({ type: 'move', x: 0, y: 2, in: 'dots' })
    await ui.advance(600)
    expect(await ui.find({ key: 'card' })).toBeDefined()
    await ui.pointer({ type: 'leave', x: 0, y: 2, in: 'dots' })
    expect(await ui.find({ key: 'card' })).toBeUndefined()
  })

  test(`${surface}: a card near Commits' bottom flips above its row; a tab switch drops it`, async ($, on) => {
    const ui = await open($, on)
    const rows = ((await ui.find({ key: 'dots' }))?.props.height as number | undefined) ?? 0
    await ui.pointer({ type: 'move', x: 0, y: rows - 1, in: 'dots' })
    await ui.advance(600)
    const card = await ui.find({ key: 'card' })
    expect(card).toBeDefined()
    // the card ends on the row's line (Commits' top border is line 0)
    expect(card?.props.top).toBeLessThan(rows)
    await ui.press({ key: 'tab:graph' })
    await ui.press({ key: 'tab:overview' })
    expect(await ui.find({ key: 'card' })).toBeUndefined()
  })

  test(`${surface}: resting on a Commits hash shows the card, past the hash`, async ($, on) => {
    const ui = await open($, on)
    const client = await ui.find({ key: 'dots' })
    // dot, space, marker, 7 hex, space
    expect(client?.props.width).toBe(11)
    await ui.pointer({ type: 'move', x: 6, y: 2, in: 'dots' })
    await ui.advance(600)
    const card = await ui.find({ key: 'card' })
    expect(await ui.find({ type: 'Text', text: 'Branches · 908022a' })).toBeDefined()
    expect(card?.props.left).toBe(12)
  })

  test(`${surface}: a click on a Commits hash selects its row, Info follows`, async ($, on) => {
    const ui = await open($, on)
    expect(await markOf(ui, HEAD_SHA)).toBe(' ')
    // a down on one row and an up on another is no press
    await ui.pointer({ type: 'down', x: 5, y: 1, button: 'left', in: 'dots' })
    await ui.pointer({ type: 'up', x: 5, y: 2, button: 'left', in: 'dots' })
    expect(await markOf(ui, HEAD_SHA)).toBe(' ')
    await ui.pointer({ type: 'down', x: 5, y: 2, button: 'left', in: 'dots' })
    await ui.pointer({ type: 'up', x: 5, y: 2, button: 'left', in: 'dots' })
    expect(await markOf(ui, HEAD_SHA)).toBe('>')
    expect(await ui.find({ type: 'Text', text: /^parents 06615e2/ })).toBeDefined()
    expect((await ui.find({ key: 'commit:' + HEAD_SHA }))?.props.label).not.toMatch(/^[ >][0-9a-f]{7}$/)
    // the selected row's background spans the Client and the rest of the row
    expect((await ui.find({ key: 'row:' + HEAD_SHA }))?.props.backgroundColor).toBe(SEL)
  })

  test(`${surface}: resting on a Graph hash shows the card inside Graph; leaving drops it`, async ($, on) => {
    const ui = await open($, on)
    await ui.press({ key: 'tab:graph' })
    expect(await ui.find({ key: 'dots' })).toBeUndefined()
    await ui.pointer({ type: 'move', x: 3, y: 2, in: 'shas' })
    await ui.advance(600)
    const card = await ui.find({ key: 'card' })
    expect(await ui.find({ type: 'Text', text: 'Branches · 908022a' })).toBeDefined()
    // top on the row's line (Graph's top border is line 0), past lanes and hash
    expect(card?.props.top).toBe(3)
    const lanes = (await ui.findAll({ type: 'Box' })).find(box => box.key?.startsWith('lanes:'))
    expect(card?.props.left).toBe(1 + (lanes?.text.length ?? 0) + 9)
    await ui.pointer({ type: 'leave', x: 3, y: 2, in: 'shas' })
    expect(await ui.find({ key: 'card' })).toBeUndefined()
  })

  test(`${surface}: a Graph card near the seam flips above its row; Overview drops it`, async ($, on) => {
    const ui = await open($, on)
    await ui.press({ key: 'tab:graph' })
    const rows = ((await ui.find({ key: 'shas' }))?.props.height as number | undefined) ?? 0
    await ui.pointer({ type: 'move', x: 3, y: rows - 1, in: 'shas' })
    await ui.advance(600)
    const card = await ui.find({ key: 'card' })
    expect(card).toBeDefined()
    expect(card?.props.top).toBeLessThan(rows)
    await ui.press({ key: 'tab:overview' })
    expect(await ui.find({ key: 'card' })).toBeUndefined()
  })

  test(`${surface}: a click on a Graph hash selects its row`, async ($, on) => {
    const ui = await open($, on)
    await ui.press({ key: 'tab:graph' })
    await ui.pointer({ type: 'down', x: 2, y: 2, button: 'left', in: 'shas' })
    await ui.pointer({ type: 'up', x: 2, y: 2, button: 'left', in: 'shas' })
    expect(await markOf(ui, HEAD_SHA)).toBe('>')
    expect((await ui.find({ key: 'lanes:' + HEAD_SHA }))?.props.backgroundColor).toBe(SEL)
    expect((await ui.find({ key: 'row:' + HEAD_SHA }))?.props.backgroundColor).toBe(SEL)
    // a right click is no press
    await ui.pointer({ type: 'down', x: 2, y: 3, button: 'right', in: 'shas' })
    await ui.pointer({ type: 'up', x: 2, y: 3, button: 'right', in: 'shas' })
    expect(await markOf(ui, HEAD_SHA)).toBe('>')
  })
}

test('vscode: Commits rows draw plain dots, no Client and no card', async ($, on) => {
  mock.store(on)
  fake(on, [])
  await $.session.start(start('terminal'))
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'vscode',
    component: 'Pane',
    props: props(100),
    requestId: 'ide-git',
    viewport: VIEWPORT,
  })

  expect(await ui.find({ key: 'dots' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '○ ' })).toBeDefined()
  const drawn = (await ui.findAll({ type: 'Box' })).filter(box => box.key?.startsWith('row:'))
  expect(drawn.length).toBe(9)
  for (const row of drawn) expect(row.text).toMatch(/^[●○] [ >][0-9a-f]{7} /)
  // the hash is the commit Button there, the subject its own
  expect((await ui.find({ key: 'commit:908022ab43fb9bc599342842219a42dfd653f899' }))?.props.label).toBe(' 908022a')
  expect(await ui.find({ key: 'subject:908022ab43fb9bc599342842219a42dfd653f899' })).toBeDefined()
  await ui.press({ key: 'tab:graph' })
  expect(await ui.find({ key: 'shas' })).toBeUndefined()
  expect(await ui.find({ key: 'subject:908022ab43fb9bc599342842219a42dfd653f899' })).toBeDefined()
})

// ------------------------------------------------------------ Settings

for (const surface of ['terminal', 'desktop'] as const) {
  const open = async ($: Engine, on: On, entries: [string, unknown][] = [], calls: string[][] = [], log = LOG) => {
    const store = new Map<string, unknown>(entries)
    memoryStore(on, store)
    on('store.delete', (_$, e) => {
      store.delete(e.key)

      return { value: undefined }
    })
    fake(on, calls, true, log)
    on('ui.focus', () => ({}))
    await $.session.start(start(surface))
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', props: props(120), requestId: 'ide-git', viewport: VIEWPORT })

    return { ui, store }
  }
  const isOn = async (ui: Awaited<ReturnType<typeof open>>['ui'], key: string) =>
    surface === 'terminal'
      ? (await ui.find({ key: key + ':chrome' }))?.props.backgroundColor !== undefined
      : (await ui.find({ key }))?.props.variant === 'primary'
  const many = Array.from({ length: 120 }, (_, i) =>
    `* \x1f${String(i).padStart(40, '0')}\x1f${String(i).padStart(7, '0')}\x1f\x1fa\x1f2026-01-01\x1fc${i}`,
  ).join('\n')

  test(`${surface}: git's Settings opens the sheet from the title row; a default tab applies while none is chosen`, async ($, on) => {
    const { ui, store } = await open($, on)
    expect((await ui.find({ key: 'settings' }))?.props.label).toBe('Settings')
    expect((await ui.find({ key: 'exit' }))?.props.label).toBe('Exit')
    await ui.press({ key: 'settings' })
    expect(await ui.find({ key: 'settings:sheet' })).toBeDefined()
    // the title row and its Settings Button stay above the sheet
    expect((await ui.find({ key: 'settings:sheet' }))?.props.top).toBe(1)

    await ui.press({ key: 'settings:tab:graph' })
    expect(await isOn(ui, 'tab:graph')).toBe(true)
    // Settings again is done
    await ui.press({ key: 'settings' })
    expect(await ui.find({ key: 'settings:sheet' })).toBeUndefined()
    expect(store.get('settings')).toEqual({ gitTab: 'graph' })

    // a chosen tab wins over the default
    await ui.press({ key: 'tab:overview' })
    expect(await isOn(ui, 'tab:overview')).toBe(true)
  })

  test(`${surface}: while git's sheet is up its Buttons sleep: a press does nothing`, async ($, on) => {
    const calls: string[][] = []
    const { ui } = await open($, on, [], calls)
    expect(await isOn(ui, 'tab:overview')).toBe(true)

    await ui.press({ key: 'settings' })
    await ui.press({ key: 'tab:graph' })
    await ui.press({ key: 'fetch' })
    await ui.press({ key: 'pull' })
    await ui.press({ key: 'push' })
    expect(await isOn(ui, 'tab:overview')).toBe(true)
    expect(calls.some(a => a[1] === 'fetch' || a[1] === 'pull' || a[1] === 'push')).toBe(false)

    await ui.press({ key: 'settings:cancel' })
    await ui.press({ key: 'tab:graph' })
    expect(await isOn(ui, 'tab:graph')).toBe(true)
  })

  test(`${surface}: the Settings page size and tab are the defaults`, async ($, on) => {
    const calls: string[][] = []
    const { ui } = await open($, on, [['settings', { gitTab: 'changelog', gitLimit: 50 }]], calls, many)
    expect(await isOn(ui, 'tab:changelog')).toBe(true)
    expect(await ui.find({ key: 'view' })).toBeUndefined()

    await ui.press({ key: 'tab:overview' })
    expect(calls.some(a => a[1] === 'log' && a[a.indexOf('-n') + 1] === '50')).toBe(true)
    expect((await ui.find({ key: 'more' }))?.props.label).toBe('More (+50)')
    await ui.press({ key: 'more' })
    expect(calls.some(a => a[1] === 'log' && a[a.indexOf('-n') + 1] === '100')).toBe(true)

    // a new page size starts over at one page of it
    await ui.press({ key: 'settings' })
    await ui.press({ key: 'settings:limit:100' })
    expect((await ui.find({ key: 'more' }))?.props.label).toBe('More (+100)')
    await ui.press({ key: 'settings:cancel' })
    expect((await ui.find({ key: 'more' }))?.props.label).toBe('More (+50)')
  })

  test(`${surface}: reset layout from git clears both stored layouts and the splits`, async ($, on) => {
    const { ui, store } = await open($, on, [
      ['layout:git', { side: 0.5 }],
      ['layout:explorer', { tree: 0.6 }],
    ])
    const cells = async () => ((await ui.find({ key: 'split:side' }))?.props.props as { cells?: number } | undefined)?.cells
    expect(await cells()).toBe(60)

    await ui.press({ key: 'settings' })
    await ui.press({ key: 'settings:reset' })
    expect(store.has('layout:git')).toBe(false)
    expect(store.has('layout:explorer')).toBe(false)
    // 30% of 120 (narrow default)
    expect(await cells()).not.toBe(60)
    await ui.press({ key: 'settings:done' })
    expect(await ui.find({ key: 'settings:sheet' })).toBeUndefined()
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: before the first commit the footer names the branch, not "detached"`, async ($, on) => {
    mock.store(on)
    fake(on, [], true, LOG, { name: 'main' }, STATUS, 0, argv => {
      const sub = argv[1]
      if (sub === 'for-each-ref') return result('')
      if (sub === 'log') return result('', 128, 'fatal: your current branch does not have any commits yet\n')
      if (sub === 'rev-parse' && argv.includes('--abbrev-ref')) return result('', 128, "fatal: ambiguous argument 'HEAD'\n")
      if (sub === 'symbolic-ref') return result('trunk\n')

      return undefined
    })
    await $.session.start(start(surface))
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', props: props(120), requestId: 'ide-git', viewport: VIEWPORT })

    expect(await ui.find({ type: 'Text', text: 'trunk' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'detached' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '(no commits)' })).toBeDefined()
  })
}
