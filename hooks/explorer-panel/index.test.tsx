import { expect, mock, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'
import type { On } from 'claude-code'

import { draftFile } from './edit'
import { convertedPath } from './preview'
import { languageOf } from './tree'
import { layout, plainRow } from './markdown/layout'
import { parse } from './markdown/parse'
import type { MdRow } from './markdown/rows'
import { KEYMAPS } from './editor'
import { sessionHex } from '../shared/color'
import { themeFromClaudeCode } from '../shared/term-theme'
import { onDefaultFg } from '../shared/ui'

// The panels' theme in the tests: Claude Code's dark theme, no terminal scheme.
const DARK = themeFromClaudeCode('dark', undefined)

const CWD = '/proj'
const PLUGIN = 'ide-panes'
const VIEWPORT = { columns: 120, rows: 30 }
const PROPS = {
  title: 'Explorer',
  isFocused: true,
  bodyColumns: 118,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
} as const

const entry = (name: string, kind: 'file' | 'dir', size = 10) => ({
  name,
  kind,
  size,
  isLink: false,
})

const TREE: Record<string, ReturnType<typeof entry>[]> = {
  '/proj': [
    entry('src', 'dir'),
    entry('.git', 'dir'),
    entry('notes.txt', 'file'),
    entry('out.log', 'file'),
    entry('app.bin', 'file', 64),
  ],
  '/proj/src': [entry('main.ts', 'file', 40)],
}

const FILES: Record<string, string> = {
  '/proj/src/main.ts': 'export const answer = 42\n',
  '/proj/notes.txt': 'hello notes\n',
  '/proj/app.bin': 'MZ\0\0binary',
}

// mtimes `fs.write` set; a path not here has the fixed one.
const MTIMES: Record<string, number> = {}
let clock = 1_800_000_000_000

// `grep` output per cwd, for the Unity GUID index.
const GREP: Record<string, string> = {}

// The repo toplevel per root, for `copy path`; a root not here is no repo.
const TOPLEVELS: Record<string, string> = { '/proj': '/proj', '/mono/app': '/mono' }
// The home the fake answers. Not under /home: on macOS that is an automount,
// and the engine refuses `$.fs` writes there as a network location.
const HOME = '/Users/u'
// Environment variables the fake answers (any other: HOME).
const ENV: Record<string, string | undefined> = {}

// `git status` output per cwd; a cwd not here answers the default below.
const STATUS: Record<string, string> = {}

// Roots outside any repo (every git call there fails), and repos before their
// first commit (no HEAD to name; `symbolic-ref` answers `trunk`).
const NOT_REPOS = new Set<string>()
const UNBORN = new Set<string>()

// Paths the fake `rm` refuses (its exit 1 and stderr).
const FAIL_RM = new Set<string>()

// The fake `rm -rf`: the path, everything under it and its row in its dir.
const removePath = (path: string): void => {
  const under = (at: string) => at === path || at.startsWith(path + '/')
  for (const at of Object.keys(FILES)) if (under(at)) delete FILES[at]
  for (const at of Object.keys(TREE)) if (under(at)) delete TREE[at]
  const dir = path.slice(0, path.lastIndexOf('/'))
  const name = path.slice(dir.length + 1)
  if (TREE[dir] !== undefined) TREE[dir] = TREE[dir]!.filter(item => item.name !== name)
}

const descendants = (dir: string): number =>
  (TREE[dir] ?? []).reduce(
    (sum, item) => sum + 1 + (item.kind === 'dir' ? descendants(dir + '/' + item.name) : 0),
    0,
  )

// Base64 bytes per path, what `fs.read(path, { as: 'bytes' })` answers.
const BYTES: Record<string, string> = {}

// Image converters the fake machine has; a missing one exits 127.
const TOOLS = new Set<string>()

// A 200x100 PNG's header, written by the fake converters.
const PNG_200x100 = 'iVBORw0KGgoAAAANSUhEUgAAAMgAAABkCAYAAAA='

const ran = (exitCode: number, stdout = '', stderr = '') => ({
  value: { exitCode, stdout, stderr },
})

// Custom preview engine commands the fake machine has, by argv[0]: each gets
// the argv and the run's timeout.
const COMMANDS: Record<string, (argv: readonly string[], timeoutMs?: number) => ReturnType<typeof ran>> = {}

// Answers fs, git, session and command plumbing beneath the plugin.
const fake = (
  on: On,
  calls: string[][] = [],
  opened: unknown[] = [],
  names: string[] = [],
  root = (): string => CWD,
): void => {
  on('fs.list', (_$, e) => ({ value: TREE[e.path] ?? [] }))
  on('fs.write', (_$, e) => {
    FILES[e.path] = e.text
    MTIMES[e.path] = ++clock
    // As the real write: the file, and its dirs where missing, are listed.
    for (let path = e.path, kind: 'file' | 'dir' = 'file'; path.lastIndexOf('/') > 0; kind = 'dir') {
      const dir = path.slice(0, path.lastIndexOf('/'))
      const name = path.slice(dir.length + 1)
      const listed = TREE[dir] ?? []
      if (!listed.some(item => item.name === name)) TREE[dir] = [...listed, entry(name, kind, e.text.length)]
      path = dir
    }

    return { value: undefined }
  })
  on('fs.stat', (_$, e) => {
    const text = FILES[e.path]
    if (text === undefined) throw new Error('ENOENT ' + e.path)

    return {
      value: {
        kind: 'file' as const,
        size: text.length,
        mtimeMs: MTIMES[e.path] ?? 1_700_000_000_000,
        isLink: false,
      },
    }
  })
  on('fs.exists', (_$, e) => ({
    value: FILES[e.path] !== undefined || TREE[e.path] !== undefined,
  }))
  on('fs.read', (_$, e) => {
    if (e.as === 'bytes' && BYTES[e.path] !== undefined) return { value: { base64: BYTES[e.path]! } }
    const text = FILES[e.path]
    if (text === undefined) throw new Error('ENOENT ' + e.path)

    return { value: text }
  })
  on('process.run', (_$, e) => {
    calls.push([...e.argv])
    const tool = e.argv[0] ?? ''
    const custom = COMMANDS[tool]
    if (custom !== undefined) return custom(e.argv, e.init?.timeoutMs)
    if (tool === 'magick' || tool === 'convert' || tool === 'rsvg-convert') {
      if (!TOOLS.has(tool)) return ran(127, '', tool + ': not found\n')
      if (e.argv[1] === '-version' || e.argv[1] === '--version') return ran(0, tool + ' 7\n')
      // a conversion: writes a 200x100 PNG at the last operand
      const out = (e.argv.at(-1) ?? '').replace(/^png:/, '')
      FILES[out] = 'P'.repeat(300)
      BYTES[out] = PNG_200x100

      return ran(0)
    }
    if (tool === 'mkdir') return ran(0)
    if (e.argv[0] === 'rm') {
      // The operands: after `--`, else every non-flag argument.
      const dash = e.argv.indexOf('--')
      const paths = dash >= 0 ? e.argv.slice(dash + 1) : e.argv.slice(1).filter(arg => !arg.startsWith('-'))
      const refused = paths.find(path => FAIL_RM.has(path))
      if (refused !== undefined) {
        return {
          value: {
            exitCode: 1,
            stdout: '',
            stderr: `rm: cannot remove '${refused}': Permission denied\n`,
          },
        }
      }
      for (const path of paths) removePath(path)

      return {
        value: { exitCode: 0, stdout: '', stderr: '' },
      }
    }
    // `find "$1" -mindepth 1 | head | wc -l`: the entries under a dir.
    if (e.argv[0] === 'sh' && (e.argv[2] ?? '').includes('find')) {
      return {
        value: {
          exitCode: 0,
          stdout: `${descendants(e.argv[4] ?? '')}\n`,
          stderr: '',
        },
      }
    }
    // `git [-C <root>] rev-parse --show-toplevel`: the repo holding the root
    // (or the run's cwd)
    if (e.argv[0] === 'git' && e.argv.includes('--show-toplevel')) {
      const top = TOPLEVELS[(e.argv[1] === '-C' ? e.argv[2] : e.init?.cwd) ?? '']

      return {
        value: {
          exitCode: top === undefined ? 128 : 0,
          stdout: top === undefined ? '' : top + '\n',
          stderr: top === undefined ? 'fatal: not a git repository\n' : '',
        },
      }
    }
    const gitCwd = e.init?.cwd ?? ''
    if (e.argv[0] === 'git' && NOT_REPOS.has(gitCwd)) return ran(128, '', 'fatal: not a git repository\n')
    if (e.argv[0] === 'git' && UNBORN.has(gitCwd)) {
      if (e.argv[1] === 'symbolic-ref') return ran(0, 'trunk\n')
      if (e.argv[1] === 'rev-parse') return ran(128, '', "fatal: ambiguous argument 'HEAD'\n")
    }
    // a repo on `main` with one untracked, two modified and one deleted file
    if (e.argv[0] === 'git' && (e.argv[1] === 'rev-parse' || e.argv[1] === 'status')) {
      return {
        value: {
          exitCode: 0,
          stdout: e.argv[1] === 'rev-parse' ? 'main\n' : (STATUS[gitCwd] ?? '?? new.ts\0 M a.ts\0 D b.ts\0 M c.ts\0'),
          stderr: '',
        },
      }
    }
    if (e.argv[0] === 'grep') {
      return {
        value: {
          exitCode: 0,
          stdout: GREP[e.init?.cwd ?? ''] ?? '',
          stderr: '',
        },
      }
    }
    const stdin = e.init?.stdin ?? ''
    const hit = stdin.split('\0').filter(name => name === 'out.log')

    return {
      value: {
        exitCode: hit.length > 0 ? 0 : 1,
        stdout: hit.map(name => name + '\0').join(''),
        stderr: '',
      },
    }
  })
  on('env.get', (_$, e) => ({ value: e.name in ENV ? ENV[e.name] : HOME }))
  let cwd = CWD
  on('session.cwd', () => ({ value: cwd }))
  on('session.root', () => ({ value: root() }))
  on('session.start', (_$, e) => {
    cwd = e.cwd

    return { cwd: e.cwd }
  })
  on('command.register', (_$, e) => {
    names.push(e.name)

    return { value: { command: e.name } }
  })
  on('ui.open', (_$, e) => {
    opened.push({ id: e.id, focus: e.focus, columns: e.columns })

    return { value: { isPlaced: true } }
  })
}

const PRESENTATION = { isFullscreen: true, columns: 120 }

type Pane = Mounted<'terminal' | 'desktop', 'Pane'>

// The Edit title as read: the unsaved `●` (a Text on the border before the
// title chip) and the chip's label, e.g. ' ● Edit '.
const titleOf = async (ui: Pane): Promise<string> => {
  const label = String((await ui.find({ key: 'title:edit:chrome' }))?.text)
  const mark = await ui.find({ type: 'Text', text: '●' })

  return (mark === undefined ? '' : ' ●') + label
}

// Whether a panel tab is the active one: its pill's accent fill on the
// terminal, the primary variant of the native Button elsewhere (default theme).
const isActiveTab = async (ui: Pane, surface: 'terminal' | 'desktop', mode: 'files' | 'unity'): Promise<boolean> =>
  surface === 'terminal'
    ? (await ui.find({ key: 'tab:' + mode + ':chrome' }))?.props.backgroundColor === onDefaultFg(DARK.accent)
    : (await ui.find({ key: 'tab:' + mode }))?.props.variant === 'primary'

const start = (surface: 'terminal' | 'desktop') => ({
  cwd: CWD,
  surface,
  isInteractive: true,
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: tree expands a dir and previews a file`, async ($, on) => {
    mock.store(on)
    fake(on)
    await $.session.start(start(surface))
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'Pane',
      props: PROPS,
      requestId: 'ide-explorer',
      viewport: VIEWPORT,
    })

    expect(await ui.find({ key: 'row:/proj/src' })).toBeDefined()
    expect(await ui.find({ key: 'row:/proj/.git' })).toBeUndefined()
    expect(await ui.find({ key: 'row:/proj/src/main.ts' })).toBeUndefined()

    await ui.press({ key: 'row:/proj/src' })
    await ui.press({ key: 'row:/proj/src' })
    expect(await ui.find({ key: 'row:/proj/src/main.ts' })).toBeDefined()

    await ui.press({ key: 'row:/proj/src/main.ts' })
    const code = await ui.find({ type: 'Code' })
    expect(code?.text).toContain('answer = 42')
    expect(code?.props.language).toBe('typescript')
  })

  // A left click on a row Client's cell `x` (a dir's arrow is x 1-2 at depth 0).
  const click = async (ui: Pane, path: string, x: number, flags: { ctrl?: true; shift?: true } = {}) => {
    await ui.pointer({ type: 'down', x, y: 0, button: 'left', in: 'item:' + path, ...flags })
    await ui.pointer({ type: 'up', x, y: 0, button: 'left', in: 'item:' + path, ...flags })
  }

  test(`${surface}: a name click selects a dir, only its arrow opens and closes it`, async ($, on) => {
    mock.store(on)
    fake(on)
    await $.session.start(start(surface))
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'Pane',
      props: PROPS,
      requestId: 'ide-explorer',
      viewport: VIEWPORT,
    })
    const rowOf = async (path: string) =>
      (await ui.find({ key: 'item:' + path }))?.props.props as
        | { label?: string; isSelected?: boolean; isExpanded?: boolean }
        | undefined

    expect((await rowOf('/proj/src'))?.label).toBe('src/')
    expect(await ui.find({ type: 'Text', text: '▸ ', in: 'item:/proj/src' })).toBeDefined()
    // the keyboard ring: one blank cell after the row
    expect((await ui.find({ key: 'row:/proj/src' }))?.props.label).toBe(' ')

    // the name: selects (the preview shows the dir), never opens it
    await click(ui, '/proj/src', 3)
    expect((await rowOf('/proj/src'))?.isSelected).toBe(true)
    expect(await ui.find({ type: 'Text', text: /1 entries/ })).toBeDefined()
    expect(await ui.find({ key: 'item:/proj/src/main.ts' })).toBeUndefined()
    await ui.advance(500)
    await click(ui, '/proj/src', 4)
    expect(await ui.find({ key: 'item:/proj/src/main.ts' })).toBeUndefined()
    await ui.advance(500)

    // the arrow: opens and closes, the selection stays
    await click(ui, '/proj/src', 1)
    expect(await ui.find({ key: 'item:/proj/src/main.ts' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '▾ ', in: 'item:/proj/src' })).toBeDefined()
    await click(ui, '/proj/src', 2)
    expect(await ui.find({ key: 'item:/proj/src/main.ts' })).toBeUndefined()
    expect((await rowOf('/proj/src'))?.isSelected).toBe(true)

    // the arrow of an unselected dir opens it without selecting it
    await click(ui, '/proj/notes.txt', 5)
    await ui.advance(500)
    await click(ui, '/proj/src', 1)
    expect(await ui.find({ key: 'item:/proj/src/main.ts' })).toBeDefined()
    expect((await rowOf('/proj/src'))?.isSelected).toBe(false)
    expect((await rowOf('/proj/notes.txt'))?.isSelected).toBe(true)

    // the message the Client posts does the same
    await ui.post({ hit: 'arrow' }, { in: 'item:/proj/src' })
    expect(await ui.find({ key: 'item:/proj/src/main.ts' })).toBeUndefined()
  })

  test(`${surface}: Enter on the selected dir still opens and closes it`, async ($, on) => {
    mock.store(on)
    fake(on)
    await $.session.start(start(surface))
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'Pane',
      props: PROPS,
      requestId: 'ide-explorer',
      viewport: VIEWPORT,
    })

    // the blank `row:` Button is the keyboard ring: Enter selects, then toggles
    await ui.press({ key: 'row:/proj/src' })
    expect(await ui.find({ key: 'item:/proj/src/main.ts' })).toBeUndefined()
    await ui.press({ key: 'row:/proj/src' })
    expect(await ui.find({ key: 'item:/proj/src/main.ts' })).toBeDefined()
    await ui.press({ key: 'row:/proj/src' })
    expect(await ui.find({ key: 'item:/proj/src/main.ts' })).toBeUndefined()
  })

  test(`${surface}: a double-click copies the path from the repo toplevel`, async ($, on) => {
    mock.store(on)
    fake(on)
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
    await $.session.start(start(surface))
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'Pane',
      props: PROPS,
      requestId: 'ide-explorer',
      viewport: VIEWPORT,
    })
    await ui.post({ hit: 'arrow' }, { in: 'item:/proj/src' })

    // two clicks 120 ms apart on a nested file's name: select, then copy
    await click(ui, '/proj/src/main.ts', 6)
    await ui.advance(100)
    await click(ui, '/proj/src/main.ts', 6)
    expect(copied).toEqual(['src/main.ts'])
    expect(toasts.at(-1)).toBe('Copied: src/main.ts')
    expect(await ui.find({ type: 'Code' })).toBeDefined()

    // two clicks further apart than 400 ms are two clicks
    await ui.advance(500)
    await click(ui, '/proj/notes.txt', 3)
    await ui.advance(500)
    await click(ui, '/proj/notes.txt', 3)
    expect(copied).toHaveLength(1)

    // two quick clicks on an arrow open and close the dir, no copy
    await ui.advance(500)
    await click(ui, '/proj/src', 1)
    await click(ui, '/proj/src', 1)
    expect(copied).toHaveLength(1)
    expect(await ui.find({ key: 'item:/proj/src/main.ts' })).toBeDefined()

    // `copy path` (y) copies the cursor's row
    expect(await ui.find({ key: 'copy' })).toBeDefined()
    await ui.press({ key: 'copy' })
    expect(copied.at(-1)).toBe('src')
  })

  test(`${surface}: copy path names a root inside a repo from the repo's top`, async ($, on) => {
    mock.store(on)
    fake(on, [], [], [], () => '/mono/app')
    TREE['/mono/app'] = [entry('a.ts', 'file')]
    FILES['/mono/app/a.ts'] = 'a\n'
    const copied: string[] = []
    on('ui.copy', (_$, e) => {
      copied.push(e.text)

      return { value: { isCopied: true } }
    })
    await $.session.start({ cwd: '/mono/app', surface, isInteractive: true })
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'Pane',
      props: PROPS,
      requestId: 'ide-explorer',
      viewport: VIEWPORT,
    })
    expect(await ui.find({ key: 'copy' })).toBeUndefined()
    await ui.post({ hit: 'double' }, { in: 'item:/mono/app/a.ts' })
    expect(copied).toEqual(['app/a.ts'])
  })

  test(`${surface}: rows carry change marks: + added, * edited, * on a dir above a change`, async ($, on) => {
    mock.store(on)
    const calls: string[][] = []
    fake(on, calls)
    STATUS[CWD] = ' M src/main.ts\0?? notes.txt\0 D gone.txt\0'
    try {
      await $.session.start(start(surface))
      const ui = await $.ui.mount({
        plugin: PLUGIN,
        surface,
        component: 'Pane',
        props: PROPS,
        requestId: 'ide-explorer',
        viewport: VIEWPORT,
      })
      const rowOf = async (path: string) =>
        (await ui.find({ key: 'item:' + path }))?.props.props as
          | { change?: string; colors?: { change?: string } }
          | undefined

      // the Explorer asks for whole untracked dirs as one entry
      expect(calls.some(argv => argv[1] === 'status' && argv.includes('--untracked-files=normal'))).toBe(true)
      expect((await rowOf('/proj/notes.txt'))?.change).toBe('+')
      expect((await rowOf('/proj/src'))?.change).toBe('*')
      expect((await rowOf('/proj/out.log'))?.change).toBeUndefined()
      expect((await rowOf('/proj/notes.txt'))?.colors?.change).toBe(DARK.success)
      expect((await rowOf('/proj/src'))?.colors?.change).toBe(DARK.warning)
      await ui.post({ hit: 'arrow' }, { in: 'item:/proj/src' })
      expect((await rowOf('/proj/src/main.ts'))?.change).toBe('*')
      // drawn after the name
      expect(await ui.find({ type: 'Text', text: ' +', in: 'item:/proj/notes.txt' })).toBeDefined()
    } finally {
      delete STATUS[CWD]
    }
  })

  test(`${surface}: a dir untracked as a whole is + with everything under it`, async ($, on) => {
    mock.store(on)
    fake(on)
    STATUS[CWD] = '?? src/\0'
    try {
      await $.session.start(start(surface))
      const ui = await $.ui.mount({
        plugin: PLUGIN,
        surface,
        component: 'Pane',
        props: PROPS,
        requestId: 'ide-explorer',
        viewport: VIEWPORT,
      })
      const changeOf = async (path: string) =>
        ((await ui.find({ key: 'item:' + path }))?.props.props as { change?: string } | undefined)?.change

      expect(await changeOf('/proj/src')).toBe('+')
      await ui.post({ hit: 'arrow' }, { in: 'item:/proj/src' })
      expect(await changeOf('/proj/src/main.ts')).toBe('+')
      expect(await changeOf('/proj/notes.txt')).toBeUndefined()
    } finally {
      delete STATUS[CWD]
    }
  })

  test(`${surface}: sections are titled by text; pressing a title copies nothing`, async ($, on) => {
    mock.store(on)
    fake(on)
    await $.session.start(start(surface))
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'Pane',
      props: PROPS,
      requestId: 'ide-explorer',
      viewport: VIEWPORT,
    })

    // the label is a Text in its chip; no Button there to press
    for (const [key, text] of [['title:files', ' Files '], ['title:preview', ' Preview ']] as const) {
      const chip = await ui.find({ key: key + ':chrome' })
      expect(chip?.text).toBe(text)
      expect(await ui.find({ type: 'Button', key })).toBeUndefined()
      expect((await ui.findAll({ type: 'Button' })).some(button => button.text === text)).toBe(false)
    }
    // no footer: the root, branch and counts are Git's to show
    expect(await ui.find({ key: 'footer:dir' })).toBeUndefined()
    expect(await ui.find({ key: 'footer:counts' })).toBeUndefined()
  })

  test(`${surface}: binary shows metadata, ignored entry is dimmed`, async ($, on) => {
    mock.store(on)
    const calls: string[][] = []
    fake(on, calls)
    await $.session.start(start(surface))
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'Pane',
      props: PROPS,
      requestId: 'ide-explorer',
      viewport: VIEWPORT,
    })

    await ui.press({ key: 'row:/proj/app.bin' })
    expect(await ui.find({ type: 'Code' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /10 B/ })).toBeDefined()

    expect(calls.some(argv => argv[1] === 'check-ignore')).toBe(true)
    // the row Client draws the name, dimmed when ignored
    const rowProps = async (path: string) =>
      (await ui.find({ key: 'item:' + path }))?.props.props as { isIgnored?: boolean } | undefined
    expect((await rowProps('/proj/out.log'))?.isIgnored).toBe(true)
    expect((await rowProps('/proj/notes.txt'))?.isIgnored).toBe(false)
    const name = await ui.find({ type: 'Text', text: 'out.log', in: 'item:/proj/out.log' })
    expect(name?.props.dimColor).toBe(true)
  })

  test(`${surface}: dir preview counts entries`, async ($, on) => {
    mock.store(on)
    fake(on)
    await $.session.start(start(surface))
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'Pane',
      props: PROPS,
      requestId: 'ide-explorer',
      viewport: VIEWPORT,
    })

    await ui.press({ key: 'row:/proj/src' })
    expect(await ui.find({ type: 'Text', text: /1 entries/ })).toBeDefined()
  })

  test(`${surface}: a shell cd keeps the root and the expanded dirs`, async ($, on) => {
    mock.store(on)
    fake(on)
    await $.session.start(start(surface))
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'Pane',
      props: PROPS,
      requestId: 'ide-explorer',
      viewport: VIEWPORT,
    })
    await ui.press({ key: 'row:/proj/src' })
    await ui.press({ key: 'row:/proj/src' })

    await $.session.start({ ...start(surface), cwd: CWD + '/src' })
    expect(await ui.find({ key: 'row:/proj/src' })).toBeDefined()
    expect(await ui.find({ key: 'row:/proj/notes.txt' })).toBeDefined()
    expect(await ui.find({ key: 'row:/proj/src/main.ts' })).toBeDefined()
  })

  test(`${surface}: mode toggle writes the store and session.start restores it`, async ($, on) => {
    const store = new Map<string, unknown>()
    on('store.get', (_$, e) => ({ value: store.get(e.key) }))
    on('store.set', (_$, e) => {
      store.set(e.key, e.value)

    return { value: undefined }
    })
    fake(on)
    await $.session.start(start(surface))
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'Pane',
      props: PROPS,
      requestId: 'ide-explorer',
      viewport: VIEWPORT,
    })

    expect(await isActiveTab(ui, surface, 'files')).toBe(true)
    expect(await ui.find({ key: 'tab:files' })).toBeDefined()
    expect(await ui.find({ key: 'tab:unity' })).toBeDefined()
    await ui.press({ key: 'tab:unity' })
    expect(store.get('explorer.mode:' + CWD)).toBe('unity')
    expect(await isActiveTab(ui, surface, 'unity')).toBe(true)

    await $.session.start(start(surface))
    expect(await isActiveTab(ui, surface, 'unity')).toBe(true)
  })

  test(`${surface}: unity mode hints when the root is not a Unity project`, async ($, on) => {
    TREE['/game'] = [entry('Assets', 'dir'), entry('ProjectSettings', 'dir')]
    TREE['/game/ProjectSettings'] = [entry('ProjectVersion.txt', 'file')]
    FILES['/game/ProjectSettings/ProjectVersion.txt'] = 'm_EditorVersion: 6000.0.0f1\n'
    TREE['/plain'] = [entry('Assets', 'dir')]
    const store = new Map<string, unknown>([
      ['explorer.mode:/game', 'unity'],
      ['explorer.mode:/plain', 'unity'],
    ])
    on('store.get', (_$, e) => ({ value: store.get(e.key) }))
    on('store.set', (_$, e) => {
      store.set(e.key, e.value)

      return { value: undefined }
    })
    let root = '/plain'
    fake(on, [], [], [], () => root)
    await $.session.start({ ...start(surface), cwd: '/plain' })
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'Pane',
      props: PROPS,
      requestId: 'ide-explorer',
      viewport: VIEWPORT,
    })

    expect(await isActiveTab(ui, surface, 'unity')).toBe(true)
    expect(
      await ui.find({ type: 'Text', text: /not a Unity project/ }),
    ).toBeDefined()

    root = '/game'
    await $.session.start({ ...start(surface), cwd: '/game' })
    expect(await isActiveTab(ui, surface, 'unity')).toBe(true)
    expect(
      await ui.find({ type: 'Text', text: /not a Unity project/ }),
    ).toBeUndefined()
  })

  test(`${surface}: files mode shows no Unity hint`, async ($, on) => {
    mock.store(on)
    fake(on)
    await $.session.start(start(surface))
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'Pane',
      props: PROPS,
      requestId: 'ide-explorer',
      viewport: VIEWPORT,
    })

    expect(
      await ui.find({ type: 'Text', text: /not a Unity project/ }),
    ).toBeUndefined()
  })
}

const GUID_A = 'a'.repeat(32)
const GUID_B = 'b'.repeat(32)
const BUILTIN = '0000000000000000e000000000000000'
const GUID_X = 'c'.repeat(32)

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: unity preview lists references and jumps to a resolved one`, async ($, on) => {
    TREE['/uni'] = [entry('Assets', 'dir'), entry('ProjectSettings', 'dir')]
    TREE['/uni/ProjectSettings'] = [entry('ProjectVersion.txt', 'file')]
    TREE['/uni/Assets'] = [entry('Prefabs', 'dir'), entry('Art', 'dir')]
    TREE['/uni/Assets/Prefabs'] = [entry('hero.prefab', 'file')]
    TREE['/uni/Assets/Art'] = [entry('Mats', 'dir')]
    TREE['/uni/Assets/Art/Mats'] = [entry('skin.mat', 'file')]
    FILES['/uni/ProjectSettings/ProjectVersion.txt'] = 'm_EditorVersion: 6000.0.0f1\n'
    FILES['/uni/Assets/Prefabs/hero.prefab'] = [
      '--- !u!1 &1',
      `  m_Material: {fileID: 2100000, guid: ${GUID_A}, type: 2}`,
      `  m_Script: {fileID: 11500000, guid: ${GUID_A}, type: 3}`,
      `  m_Mesh: {fileID: 10202, guid: ${BUILTIN}, type: 0}`,
      `  m_Other: {fileID: 1, guid: ${GUID_X}, type: 3}`,
    ].join('\n')
    GREP['/uni'] = [
      `Assets/Art/Mats/skin.mat.meta:guid: ${GUID_A}`,
      `Assets/Prefabs/hero.prefab.meta:guid: ${GUID_B}`,
    ].join('\n')
    const store = new Map<string, unknown>([['explorer.mode:/uni', 'unity']])
    on('store.get', (_$, e) => ({ value: store.get(e.key) }))
    on('store.set', (_$, e) => {
      store.set(e.key, e.value)

      return { value: undefined }
    })
    fake(on, [], [], [], () => '/uni')
    await $.session.start({ ...start(surface), cwd: '/uni' })
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'Pane',
      props: PROPS,
      requestId: 'ide-explorer',
      viewport: VIEWPORT,
    })

    await ui.press({ key: 'row:/uni/Assets' })
    await ui.press({ key: 'row:/uni/Assets' })
    await ui.press({ key: 'row:/uni/Assets/Prefabs' })
    await ui.press({ key: 'row:/uni/Assets/Prefabs' })
    await ui.press({ key: 'row:/uni/Assets/Prefabs/hero.prefab' })
    expect(await ui.find({ type: 'Text', text: /References \(3\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Unity built-in/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /package or missing/ })).toBeDefined()
    expect(await ui.find({ key: 'row:/uni/Assets/Art/Mats/skin.mat' })).toBeUndefined()

    await ui.press({ key: 'ref:/uni/Assets/Art/Mats/skin.mat' })
    expect(await ui.find({ key: 'row:/uni/Assets/Art/Mats/skin.mat' })).toBeDefined()
    expect(await ui.find({ key: 'row:/uni/Assets/Art/Mats' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /References/ })).toBeUndefined()
  })
}

test('files mode shows no references', async ($, on) => {
  mock.store(on)
  fake(on)
  TREE['/proj/src'] = [entry('a.prefab', 'file')]
  FILES['/proj/src/a.prefab'] = `guid: ${GUID_A}\n`
  await $.session.start(start('terminal'))
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'Pane',
    props: PROPS,
    requestId: 'ide-explorer',
    viewport: VIEWPORT,
  })
  await ui.press({ key: 'row:/proj/src' })
  await ui.press({ key: 'row:/proj/src' })
  await ui.press({ key: 'row:/proj/src/a.prefab' })
  expect(await ui.find({ type: 'Text', text: /References/ })).toBeUndefined()
  TREE['/proj/src'] = [entry('main.ts', 'file', 40)]
})

test('focus moving past the window edge scrolls the tree', async ($, on) => {
  mock.store(on)
  fake(on, [], [], [], () => '/big')
  const names = Array.from({ length: 12 }, (_, i) => `f${String(i).padStart(2, '0')}.txt`)
  TREE['/big'] = names.map(name => entry(name, 'file'))
  on('ui.focus', () => ({}))
  await $.session.start({ cwd: '/big', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'Pane',
    // 1 header row, then Files' frame around 4 rows
    props: { ...PROPS, scroll: { offset: 0, bodyRows: 7 } },
    requestId: 'ide-explorer',
    viewport: VIEWPORT,
  })

  const rows = async () =>
    (await ui.findAll({ type: 'Button' }))
      .map(b => b.key ?? '')
      .filter(key => key.startsWith('row:'))
  expect(await rows()).toHaveLength(4)
  for (const name of names.slice(0, 6)) {
    await $.ui.focus({
      component: 'Pane',
      requestId: 'ide-explorer',
      plugin: PLUGIN,
      element: 'row:/big/' + name,
      origin: { kind: 'person' },
    })
  }
  const shown = await rows()
  expect(shown).toHaveLength(4)
  expect(shown).toContain('row:/big/f05.txt')
  expect(shown).toContain('row:/big/f06.txt')
  expect(shown).not.toContain('row:/big/f00.txt')
})

test('focus moves the cursor, Enter moves the selection', async ($, on) => {
  mock.store(on)
  fake(on, [], [], [], () => '/cur')
  TREE['/cur'] = ['a.txt', 'b.txt'].map(name => entry(name, 'file'))
  FILES['/cur/a.txt'] = 'alpha'
  FILES['/cur/b.txt'] = 'bravo'
  on('ui.focus', () => ({}))
  await $.session.start({ cwd: '/cur', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'Pane',
    props: PROPS,
    requestId: 'ide-explorer',
    viewport: VIEWPORT,
  })

  const code = async () => (await ui.find({ type: 'Code' }))?.text ?? ''
  await ui.press({ key: 'row:/cur/a.txt' })
  expect(await code()).toContain('alpha')
  await $.ui.focus({
    component: 'Pane',
    requestId: 'ide-explorer',
    plugin: PLUGIN,
    element: 'row:/cur/b.txt',
    origin: { kind: 'person' },
  })
  // the preview stays on the selected file while the cursor moves
  expect(await code()).toContain('alpha')
  await ui.press({ key: 'row:/cur/b.txt' })
  expect(await code()).toContain('bravo')
})

test('session.start registers /ide-panels only', async ($, on) => {
  mock.store(on)
  const names: string[] = []
  fake(on, [], [], names)
  await $.session.start(start('terminal'))

  expect(names).toEqual(['ide-panels'])
})

for (const surface of ['terminal', 'desktop'] as const) {
  const mount = ($: Engine) =>
    $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'Pane',
      props: PROPS,
      requestId: 'ide-explorer',
      viewport: VIEWPORT,
    })

  // The test's own bottom hook: the tool "runs" and reports success.
  const done = () => ({ result: {}, text: '' }) as never

  test(`${surface}: a Write of a new file shows its row without refresh`, async ($, on) => {
    mock.store(on)
    fake(on)
    on('tool.call', done)
    await $.session.start(start(surface))
    const ui = await mount($)
    await ui.press({ key: 'row:/proj/src' })
    await ui.press({ key: 'row:/proj/src' })
    expect(await ui.find({ key: 'row:/proj/src/new.ts' })).toBeUndefined()

    TREE['/proj/src'] = [...(TREE['/proj/src'] ?? []), entry('new.ts', 'file')]
    await $.tool.call({
      tool: 'Write',
      file_path: '/proj/src/new.ts',
      content: 'x',
    })
    expect(await ui.find({ key: 'row:/proj/src/new.ts' })).toBeDefined()
    TREE['/proj/src'] = [entry('main.ts', 'file', 40)]
  })

  test(`${surface}: a Bash call re-lists the tree`, async ($, on) => {
    mock.store(on)
    fake(on)
    on('tool.call', done)
    await $.session.start(start(surface))
    const ui = await mount($)
    expect(await ui.find({ key: 'row:/proj/fresh.txt' })).toBeUndefined()

    TREE['/proj'] = [...(TREE['/proj'] ?? []), entry('fresh.txt', 'file')]
    await $.tool.call({ tool: 'Bash', command: 'touch fresh.txt' })
    expect(await ui.find({ key: 'row:/proj/fresh.txt' })).toBeDefined()
    TREE['/proj'] = (TREE['/proj'] ?? []).filter(x => x.name !== 'fresh.txt')
  })

  test(`${surface}: no Button carries a hotkey; the panel tabs switch by click`, async ($, on) => {
    mock.store(on)
    fake(on)
    await $.session.start(start(surface))
    const ui = await mount($)

    expect(await ui.find({ key: 'mode' })).toBeUndefined()
    expect(await ui.find({ key: 'refresh' })).toBeDefined()
    for (const b of await ui.findAll({ type: 'Button' })) expect(b.props.hotkey).toBeUndefined()
    expect(await isActiveTab(ui, surface, 'files')).toBe(true)
    expect(await isActiveTab(ui, surface, 'unity')).toBe(false)
    await ui.press({ key: 'tab:unity' })
    expect(await ui.find({ type: 'Text', text: /not a Unity project/ })).toBeDefined()
    expect(await isActiveTab(ui, surface, 'unity')).toBe(true)
    await ui.press({ key: 'tab:files' })
    expect(await isActiveTab(ui, surface, 'files')).toBe(true)
    expect(await ui.find({ type: 'Text', text: /not a Unity project/ })).toBeUndefined()
  })
}

const scroll = ($: Engine, requestId: string, by: number, pointer?: { column: number; row: number }) =>
  $.ui.scroll({
    component: 'Pane',
    requestId,
    plugin: PLUGIN,
    offset: 0,
    by,
    bodyRows: 20,
    contentRows: 20,
    origin: { kind: 'person' },
    ...(pointer === undefined ? {} : { pointer }),
  } as never)

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: wheel scrolls the section under the pointer, keys move the selection and page the preview`, async ($, on) => {
    mock.store(on)
    fake(on, [], [], [], () => '/many')
    on('ui.focus', () => ({}))
    on('ui.scroll', () => ({}))
    const names = Array.from({ length: 30 }, (_, i) => `g${String(i).padStart(2, '0')}.txt`)
    TREE['/many'] = names.map(name => entry(name, 'file'))
    for (const name of names) {
      FILES['/many/' + name] = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
    }
    await $.session.start({ cwd: '/many', surface, isInteractive: true })
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'Pane',
      props: { ...PROPS, scroll: { offset: 0, bodyRows: 12 } },
      requestId: 'ide-explorer',
      viewport: VIEWPORT,
    })
    const keys = async () =>
      (await ui.findAll({ type: 'Button' }))
        .map(b => b.key ?? '')
        .filter(key => key.startsWith('row:'))
    const bars = async () =>
      (await ui.findAll({ type: 'Text', text: /^[┃│ ]$/, in: 'sb:preview' })).map(t => t.text).join('')
    await ui.press({ key: 'row:/many/g00.txt' })
    expect(await keys()).toContain('row:/many/g00.txt')
    expect(await bars()).toContain('┃')

    // wheel over the tree: the window moves, the selection stays
    await scroll($, 'ide-explorer', 5, { column: 5, row: 3 })
    const moved = await keys()
    expect(moved).not.toContain('row:/many/g00.txt')
    expect(moved).toContain('row:/many/g05.txt')
    const code = async () => await ui.find({ type: 'Code' })
    expect((await code())?.props.startLine).toBe(1)

    // wheel over the preview scrolls the file lines
    await scroll($, 'ide-explorer', 4, { column: 80, row: 3 })
    expect((await code())?.props.startLine).toBe(5)
    expect((await code())?.text).toContain('line 5')
    expect(await keys()).toEqual(moved)

    // a page key (no pointer) scrolls the preview by its rows
    await scroll($, 'ide-explorer', 20)
    expect(((await code())?.props.startLine as number) > 5).toBe(true)
    await scroll($, 'ide-explorer', -20)
    expect((await code())?.props.startLine).toBe(5)
    await scroll($, 'ide-explorer', -20)
    expect((await code())?.props.startLine).toBe(1)

    // an arrow key moves the selection and resets the preview
    await scroll($, 'ide-explorer', 1)
    expect(await keys()).toContain('row:/many/g01.txt')
    expect((await code())?.props.startLine).toBe(1)
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: dragging a scrollbar moves its section, the selection stays`, async ($, on) => {
    mock.store(on)
    fake(on, [], [], [], () => '/drag')
    on('ui.focus', () => ({}))
    const names = Array.from({ length: 30 }, (_, i) => `d${String(i).padStart(2, '0')}.txt`)
    TREE['/drag'] = names.map(name => entry(name, 'file'))
    for (const name of names) {
      FILES['/drag/' + name] = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
    }
    await $.session.start({ cwd: '/drag', surface, isInteractive: true })
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'Pane',
      // 1 header row, then frames around 9 rows
      props: { ...PROPS, scroll: { offset: 0, bodyRows: 12 } },
      requestId: 'ide-explorer',
      viewport: VIEWPORT,
    })
    await ui.press({ key: 'row:/drag/d00.txt' })
    const code = async () => await ui.find({ type: 'Code' })
    const keys = async () =>
      (await ui.findAll({ type: 'Button' }))
        .map(b => b.key ?? '')
        .filter(key => key.startsWith('row:'))
    const thumbs = async (key: string) =>
      (await ui.findAll({ type: 'Text', in: key })).map(t => t.text).join('')

    await ui.resize({ columns: 1, rows: 9, in: 'sb:preview' })
    await ui.resize({ columns: 1, rows: 9, in: 'sb:tree' })

    // preview: the thumb starts on top; drag it down, release at the bottom
    expect((await thumbs('sb:preview')).startsWith('┃')).toBe(true)
    await ui.pointer({ type: 'down', x: 0, y: 0, button: 'left', in: 'sb:preview' })
    expect((await code())?.props.startLine).toBe(1)
    await ui.pointer({ type: 'move', x: 0, y: 4, button: 'left', in: 'sb:preview' })
    expect((await code())?.props.startLine).toBe(27)
    await ui.pointer({ type: 'up', x: 0, y: 8, button: 'left', in: 'sb:preview' })
    expect((await code())?.props.startLine).toBe(52)
    expect((await thumbs('sb:preview')).endsWith('┃')).toBe(true)

    // a click on the track centres the thumb there
    await ui.pointer({ type: 'down', x: 0, y: 0, button: 'left', in: 'sb:preview' })
    await ui.pointer({ type: 'up', x: 0, y: 0, button: 'left', in: 'sb:preview' })
    expect((await code())?.props.startLine).toBe(1)

    // tree: the window moves, the selection and preview stay
    await ui.pointer({ type: 'down', x: 0, y: 8, button: 'left', in: 'sb:tree' })
    await ui.pointer({ type: 'up', x: 0, y: 8, button: 'left', in: 'sb:tree' })
    const moved = await keys()
    expect(moved).not.toContain('row:/drag/d00.txt')
    expect(moved).toContain('row:/drag/d29.txt')
    expect((await code())?.props.startLine).toBe(1)
    expect((await code())?.text).toContain('line 1')
  })
}

// `$.store` from a Map the test reads back.
const memoryStore = (on: On, store: Map<string, unknown>) => {
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, e.value)

    return { value: undefined }
  })
}

// ------------------------------------------------------------ Edit section

for (const surface of ['terminal', 'desktop'] as const) {
  const mountMany = async ($: Engine, on: On, store?: Map<string, unknown>) => {
    if (store === undefined) mock.store(on)
    else memoryStore(on, store)
    fake(on, [], [], [], () => '/many2')
    on('ui.focus', () => ({}))
    on('ui.scroll', () => ({}))
    const names = Array.from({ length: 30 }, (_, i) => `h${String(i).padStart(2, '0')}.txt`)
    TREE['/many2'] = names.map(name => entry(name, 'file'))
    for (const name of names) FILES['/many2/' + name] = 'x\n'
    await $.session.start({ cwd: '/many2', surface, isInteractive: true })

    return $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'Pane',
      props: { ...PROPS, scroll: { offset: 0, bodyRows: 12 } },
      requestId: 'ide-explorer',
      viewport: VIEWPORT,
    })
  }
  const cellsOf = async (ui: Awaited<ReturnType<typeof mountMany>>) => {
    const props = (await ui.find({ key: 'split:tree' }))?.props.props as { cells?: number } | undefined

    return props?.cells
  }

  test(`${surface}: dragging the Files seam widens Files and wheel routing follows`, async ($, on) => {
    const ui = await mountMany($, on)
    const keys = async () =>
      (await ui.findAll({ type: 'Button' }))
        .map(b => b.key ?? '')
        .filter(key => key.startsWith('row:'))
    // 35% of 118 body columns
    expect(await cellsOf(ui)).toBe(41)

    await ui.pointer({ type: 'down', button: 'left', x: 0, y: 3, in: 'split:tree' })
    await ui.pointer({ type: 'move', button: 'left', x: 10, y: 3, in: 'split:tree' })
    expect(await cellsOf(ui)).toBe(51)
    await ui.pointer({ type: 'up', button: 'left', x: 0, y: 3, in: 'split:tree' })
    expect(await cellsOf(ui)).toBe(51)

    // a grab on Preview's border (the seam's second cell) drags too
    await ui.pointer({ type: 'down', button: 'left', x: 1, y: 3, in: 'split:tree' })
    await ui.pointer({ type: 'move', button: 'left', x: 6, y: 3, in: 'split:tree' })
    expect(await cellsOf(ui)).toBe(56)
    // the seam moved under the pointer: the release is where the grab now is
    await ui.pointer({ type: 'up', button: 'left', x: 1, y: 3, in: 'split:tree' })
    expect(await cellsOf(ui)).toBe(56)

    // column 50 was Preview, now Files: the wheel moves the tree
    const first = (await keys())[0]
    await scroll($, 'ide-explorer', 5, { column: 50, row: 3 })
    expect((await keys())[0]).not.toBe(first)

    // a drag far left stops at the minimum
    await ui.pointer({ type: 'down', button: 'left', x: 0, y: 3, in: 'split:tree' })
    await ui.pointer({ type: 'move', button: 'left', x: -100, y: 3, in: 'split:tree' })
    expect(await cellsOf(ui)).toBe(12)
    await ui.pointer({ type: 'up', button: 'left', x: 0, y: 3, in: 'split:tree' })
  })

  test(`${surface}: a narrow Files cuts long tree labels with … so each row stays one line`, async ($, on) => {
    const ui = await mountMany($, on)
    await ui.pointer({ type: 'down', button: 'left', x: 0, y: 3, in: 'split:tree' })
    await ui.pointer({ type: 'move', button: 'left', x: -100, y: 3, in: 'split:tree' })
    await ui.pointer({ type: 'up', button: 'left', x: -100, y: 3, in: 'split:tree' })
    expect(await cellsOf(ui)).toBe(12)
    const items = (await ui.findAll({ type: 'Client' })).filter(c => (c.key ?? '').startsWith('item:'))
    const labels = items.map(c => String((c.props.props as { label?: string }).label))
    expect(labels.length > 0).toBe(true)
    // 12 columns: frame 2, vertical bar 1 and the keyboard cell 1 leave the
    // row Client 8: mark 1, file glyph 2, so 5 for 'h00.txt'
    for (const item of items) expect(item.props.width).toBe(8)
    for (const label of labels) {
      expect(label.length).toBe(5)
      expect(label.endsWith('…')).toBe(true)
      expect(label.includes('\n')).toBe(false)
    }
    expect(labels[0]).toBe('h00.…')
  })

  test(`${surface}: a Files seam drag writes layout:explorer on release only`, async ($, on) => {
    const store = new Map<string, unknown>()
    const ui = await mountMany($, on, store)
    await ui.pointer({ type: 'down', button: 'left', x: 0, y: 3, in: 'split:tree' })
    await ui.pointer({ type: 'move', button: 'left', x: 10, y: 3, in: 'split:tree' })
    expect(await cellsOf(ui)).toBe(51)
    expect(store.has('layout:explorer')).toBe(false)
    await ui.pointer({ type: 'up', button: 'left', x: 0, y: 3, in: 'split:tree' })
    const saved = store.get('layout:explorer') as { tree?: number }
    expect(Math.round((saved.tree ?? 0) * 118)).toBe(51)
  })

  test(`${surface}: session.start restores a stored layout:explorer`, async ($, on) => {
    const ui = await mountMany($, on, new Map<string, unknown>([['layout:explorer', { tree: 0.5 }]]))
    // 50% of 118 body columns
    expect(await cellsOf(ui)).toBe(59)
  })

  for (const value of ['x', { tree: 7 }])
    test(`${surface}: a garbage layout:explorer (${JSON.stringify(value)}) falls back to the default`, async ($, on) => {
      const ui = await mountMany($, on, new Map<string, unknown>([['layout:explorer', value]]))
      expect(await cellsOf(ui)).toBe(41)
    })
}

// A root of one dir with the given files; mounts the pane, selects the first
// file and opens the editor on it.
const editing = async (
  $: Engine,
  on: On,
  surface: 'terminal' | 'desktop',
  root: string,
  files: Record<string, string>,
  opened: unknown[] = [],
  stored: Record<string, unknown> = {},
) => {
  mock.store(on, stored)
  fake(on, [], opened, [], () => root)
  TREE[root] = Object.keys(files).map(name => entry(name, 'file', files[name]!.length))
  for (const [name, text] of Object.entries(files)) {
    FILES[root + '/' + name] = text
    delete MTIMES[root + '/' + name]
    delete FILES[draftFile(HOME, root + '/' + name)]
  }
  await $.session.start({ cwd: root, surface, isInteractive: true })
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface,
    component: 'Pane',
    props: PROPS,
    requestId: 'ide-explorer',
    viewport: VIEWPORT,
  })
  await ui.press({ key: 'row:' + root + '/' + Object.keys(files)[0] })
  expect(await ui.find({ key: 'edit' })).toBeDefined()
  await ui.press({ key: 'edit' })
  await ui.resize({ columns: 60, rows: 10, in: 'editor' })
  // Lets the client's posts and the hook's answers settle.
  const settle = async () => {
    for (let i = 0; i < 8; i++) await ui.advance(250)
  }
  await settle()
  const text = async () =>
    (await ui.findAll({ type: 'Text', in: 'editor' }))
      // one Text per row; its runs are Texts nested in it
      .filter(t => t.props.wrap === 'truncate-end')
      .map(t => t.text)
      .join('\n')
  const title = async () => titleOf(ui)

  return { ui, settle, text, title }
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: edit, type and save writes the file`, async ($, on) => {
    const { ui, settle, text, title } = await editing($, on, surface, '/ed1', { 'a.ts': 'one\ntwo\n' })
    expect(await text()).toContain('one')
    expect(await title()).toBe(' Edit ')
    // the Files seam is drawn beside the Edit section too
    expect(await ui.find({ key: 'split:tree' })).toBeDefined()

    await ui.key({ key: 'x', in: 'editor' })
    await settle()
    expect(await text()).toContain('xone')
    expect(await title()).toBe(' ● Edit ')

    await ui.key({ key: 's', ctrl: true, in: 'editor' })
    await settle()
    expect(FILES['/ed1/a.ts']).toBe('xone\ntwo\n')
    expect(await title()).toBe(' Edit ')
  })

  test(`${surface}: a 300k-char file loads in 4 chunks and saves intact`, async ($, on) => {
    const line = 'const value = "0123456789abcdefghijklmnopqrstuvwxyz";\n'
    const big = line.repeat(Math.ceil(300_000 / line.length))
    const { ui, settle, text } = await editing($, on, surface, '/ed2', { 'big.ts': big })
    const client = await ui.find({ key: 'editor' })
    const props = client?.props.props as { total: number; index: number }
    expect(props.total).toBe(4)
    expect(props.index).toBe(4)
    expect(await text()).toContain('0123456789')

    await ui.press({ key: 'edit:duplicateLines' })
    await settle()
    await ui.press({ key: 'edit:deleteLines' })
    await settle()
    await ui.press({ key: 'edit:save' })
    await settle()
    expect(FILES['/ed2/big.ts']).toBe(big)
  })

  test(`${surface}: save after an external change shows the conflict bar`, async ($, on) => {
    const { ui, settle } = await editing($, on, surface, '/ed3', { 'a.ts': 'one\n' })
    await ui.key({ key: 'x', in: 'editor' })
    MTIMES['/ed3/a.ts'] = ++clock
    FILES['/ed3/a.ts'] = 'theirs\n'
    await ui.key({ key: 's', ctrl: true, in: 'editor' })
    await settle()
    expect(FILES['/ed3/a.ts']).toBe('theirs\n')
    expect(await ui.find({ key: 'ask:overwrite' })).toBeDefined()

    await ui.press({ key: 'ask:overwrite' })
    await settle()
    expect(FILES['/ed3/a.ts']).toBe('xone\n')
    expect(await ui.find({ key: 'ask:overwrite' })).toBeUndefined()
  })

  test(`${surface}: selecting another file while dirty asks first`, async ($, on) => {
    const { ui, settle } = await editing($, on, surface, '/ed4', { 'a.ts': 'one\n', 'b.ts': 'two\n' })
    await ui.key({ key: 'x', in: 'editor' })
    await settle()
    await ui.press({ key: 'row:/ed4/b.ts' })
    expect(await ui.find({ key: 'ask:save' })).toBeDefined()
    expect(await ui.find({ key: 'editor' })).toBeDefined()

    await ui.press({ key: 'ask:cancel' })
    expect(await ui.find({ key: 'ask:save' })).toBeUndefined()
    expect(await ui.find({ key: 'editor' })).toBeDefined()

    await ui.press({ key: 'row:/ed4/b.ts' })
    await ui.press({ key: 'ask:discard' })
    expect(await ui.find({ key: 'editor' })).toBeUndefined()
    expect((await ui.find({ type: 'Code' }))?.text).toContain('two')
    expect(FILES['/ed4/a.ts']).toBe('one\n')
  })

  // The test kit raises no `ui.close` of its own: an inline plugin closes it.
  const closer = {
    name: 'closer',
    register: (on: On) => {
      on('command.run', { command: 'close-explorer' }, async $ => {
        await $.ui.close({ id: 'ide-explorer' })

        return { text: '' }
      })
    },
  }
  test(`${surface}: closing the pane while dirty keeps it open`, { plugins: [closer] }, async ($, on) => {
    let closed = 0
    on('ui.close', () => {
      closed += 1

      return { value: undefined }
    })
    const { ui, settle } = await editing($, on, surface, '/ed5', { 'a.ts': 'one\n' })
    await ui.key({ key: 'x', in: 'editor' })
    await settle()
    const close = () =>
      $.command.run({
        command: 'close-explorer',
        args: '',
        origin: { kind: 'composer' },
        presentation: PRESENTATION,
      })
    await close()
    expect(closed).toBe(0)
    expect(await ui.find({ key: 'ask:save' })).toBeDefined()

    await ui.press({ key: 'ask:save' })
    await settle()
    expect(FILES['/ed5/a.ts']).toBe('xone\n')
    expect(closed).toBe(1)
  })

  test(`${surface}: session.start restores the draft`, async ($, on) => {
    const { ui, settle, text, title } = await editing($, on, surface, '/ed6', { 'a.ts': 'one\n' })
    await ui.key({ key: 'x', in: 'editor' })
    await settle()
    const draft = draftFile(HOME, '/ed6/a.ts')
    expect(FILES[draft]).toBe('xone\n')

    await $.session.start({ cwd: '/ed6', surface, isInteractive: true })
    await settle()
    expect(await text()).toContain('xone')
    expect(await title()).toBe(' ● Edit ')
    expect(FILES['/ed6/a.ts']).toBe('one\n')

    await ui.press({ key: 'edit:save' })
    await settle()
    expect(FILES['/ed6/a.ts']).toBe('xone\n')
    expect(FILES[draft]).toBeUndefined()
  })

  test(`${surface}: a click places the cursor, alt+click adds one`, async ($, on) => {
    const { ui, settle, text } = await editing($, on, surface, '/ed8', { 'a.ts': 'one\ntwo' })
    // the gutter is two cells ("1 ")
    await ui.pointer({ type: 'down', x: 3, y: 1, button: 'left', in: 'editor' })
    await ui.pointer({ type: 'up', x: 3, y: 1, button: 'left', in: 'editor' })
    await ui.key({ key: 'Z', shift: true, in: 'editor' })
    await ui.pointer({ type: 'down', x: 2, y: 0, button: 'left', alt: true, in: 'editor' })
    await ui.pointer({ type: 'up', x: 2, y: 0, button: 'left', alt: true, in: 'editor' })
    await ui.key({ key: 'Q', shift: true, in: 'editor' })
    await settle()
    expect(await text()).toBe('1 Qone\n2 tZQwo')
  })

  // The test kit passes no userConfig options, so the overrides come from the
  // saved Settings, which `mergeKeys` lays over userConfig the same way.
  test(`${surface}: key overrides rebind a key`, async ($, on) => {
    const settings = { keys: '{"duplicateLines":"ctrl+shift+d"}' }
    const { ui, settle, text } = await editing($, on, surface, '/ed7', { 'a.ts': 'one\n' }, [], { settings })
    await ui.key({ key: 'd', ctrl: true, in: 'editor' })
    await settle()
    expect((await text()).match(/one/g)).toHaveLength(1)
    await ui.key({ key: 'd', ctrl: true, shift: true, in: 'editor' })
    await settle()
    expect((await text()).match(/one/g)).toHaveLength(2)
  })

  test(`${surface}: the Edit section's horizontal bar drags the view, the cursor still scrolls it`, async ($, on) => {
    const long = Array.from({ length: 300 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('')
    const { ui, settle, text } = await editing($, on, surface, '/ed9', { 'a.txt': long + '\nshort\n' })
    const firstRow = async () => (await text()).split('\n')[0]!
    const barProps = async () =>
      (await ui.find({ key: 'hb:edit' }))?.props.props as {
        total: number
        visible: number
        offset: number
        height: number
      }

    // 3 lines: a 2-cell gutter, so 58 text columns of the 60
    expect(await ui.find({ key: 'hb:edit' })).toBeDefined()
    const props = await barProps()
    expect(props.total).toBe(301) // the widest line and the caret cell past its end
    expect(props.visible).toBe(58)
    expect(props.offset).toBe(0)
    expect(await firstRow()).toBe('1 ' + long.slice(0, 58))
    // the border Buttons on the top border are still there
    expect(await ui.find({ key: 'edit:save' })).toBeDefined()

    // a drag: the client gets `left`, the rows start at that column
    const width = props.height
    await ui.resize({ columns: width, rows: 1, in: 'hb:edit' })
    const thumb = Math.round((width * props.visible) / props.total)
    const free = width - thumb
    const span = props.total - props.visible
    await ui.pointer({ type: 'down', x: 0, y: 0, button: 'left', in: 'hb:edit' })
    await ui.pointer({ type: 'move', x: 10, y: 0, button: 'left', in: 'hb:edit' })
    await ui.pointer({ type: 'up', x: 10, y: 0, button: 'left', in: 'hb:edit' })
    await settle()
    const mid = Math.round((10 / free) * span)
    expect(mid > 0).toBe(true)
    expect(await firstRow()).toBe('1 ' + long.slice(mid, mid + 58))
    expect((await barProps()).offset).toBe(mid)

    // the cursor did not move: typing lands at column 0, and the view follows
    // the cursor (now at column 1) back as it always has
    await ui.key({ key: 'X', shift: true, in: 'editor' })
    await settle()
    expect(await firstRow()).toBe('1 ' + long.slice(0, 58))
    expect((await barProps()).total).toBe(302)
    expect((await barProps()).offset).toBe(1)
    await ui.key({ key: 'home', in: 'editor' })
    await settle()
    expect(await firstRow()).toBe('1 X' + long.slice(0, 57))
    expect((await barProps()).offset).toBe(0)

    // the cursor past the right edge scrolls the view as before
    await ui.key({ key: 'end', in: 'editor' })
    await settle()
    const left = 301 - 58 + 1
    expect(await firstRow()).toBe('1 ' + ('X' + long).slice(left) + ' ')
    expect((await barProps()).offset).toBe(left)

    // the widest line deleted: every line is measured again, all fits, no bar
    await ui.press({ key: 'edit:deleteLines' })
    await settle()
    expect(await ui.find({ key: 'hb:edit' })).toBeUndefined()
  })

  test(`${surface}: a short file draws no horizontal bar in the Edit section`, async ($, on) => {
    const { ui, text } = await editing($, on, surface, '/ed10', { 'a.ts': 'one\ntwo\n' })
    expect(await text()).toContain('one')
    expect(await ui.find({ key: 'hb:edit' })).toBeUndefined()
  })

  test(`${surface}: a line exactly as wide as the view, caret at its end: a bar to drag back`, async ($, on) => {
    const line = 'a'.repeat(57) + 'z'
    const { ui, settle, text } = await editing($, on, surface, '/ed11', { 'a.txt': line + '\nb\n' })
    const firstRow = async () => (await text()).split('\n')[0]!
    const barProps = async () =>
      (await ui.find({ key: 'hb:edit' }))?.props.props as { total: number; visible: number; offset: number; height: number }
    // 58 columns, 58 text columns, plus the caret cell past the end: a bar
    expect((await barProps()).total).toBe(59)
    expect((await barProps()).offset).toBe(0)
    await ui.key({ key: 'end', in: 'editor' })
    await settle()
    // the caret cell past the end scrolled the view one column: a bar shows it
    expect((await barProps()).total).toBe(59)
    expect((await barProps()).offset).toBe(1)
    const width = (await barProps()).height
    await ui.resize({ columns: width, rows: 1, in: 'hb:edit' })
    // dragged fully left: back to column 0, shown at once on release
    await ui.pointer({ type: 'down', x: width - 1, y: 0, button: 'left', in: 'hb:edit' })
    await ui.pointer({ type: 'move', x: -100, y: 0, button: 'left', in: 'hb:edit' })
    await ui.pointer({ type: 'up', x: -100, y: 0, button: 'left', in: 'hb:edit' })
    expect((await barProps()).offset).toBe(0)
    await settle()
    expect((await barProps()).offset).toBe(0)
    expect(await firstRow()).toBe('1 ' + line)
    // dragged fully right: where End put the view
    await ui.pointer({ type: 'down', x: 0, y: 0, button: 'left', in: 'hb:edit' })
    await ui.pointer({ type: 'move', x: 100, y: 0, button: 'left', in: 'hb:edit' })
    await ui.pointer({ type: 'up', x: 100, y: 0, button: 'left', in: 'hb:edit' })
    expect((await barProps()).offset).toBe(1)
    await settle()
    expect((await barProps()).offset).toBe(1)
    expect(await firstRow()).toBe('1 ' + line.slice(1) + ' ')
  })
}

test('vscode: no Client, so no edit button', async ($, on) => {
  mock.store(on)
  fake(on)
  await $.session.start({ cwd: CWD, surface: 'vscode', isInteractive: true })
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'vscode',
    component: 'Pane',
    props: PROPS,
    requestId: 'ide-explorer',
    viewport: VIEWPORT,
  })
  await ui.press({ key: 'row:/proj/notes.txt' })
  expect(await ui.find({ type: 'Code' })).toBeDefined()
  expect(await ui.find({ key: 'edit' })).toBeUndefined()
  // `new` opens the editor, so it needs a Client too, though vscode has Input.
  expect(await ui.find({ key: 'new' })).toBeUndefined()
})

test('vscode: the name Button selects, the arrow Button opens and closes', async ($, on) => {
  mock.store(on)
  fake(on)
  const copied: string[] = []
  on('ui.copy', (_$, e) => {
    copied.push(e.text)

    return { value: { isCopied: true } }
  })
  await $.session.start({ cwd: CWD, surface: 'vscode', isInteractive: true })
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'vscode',
    component: 'Pane',
    props: PROPS,
    requestId: 'ide-explorer',
    viewport: VIEWPORT,
  })
  expect(await ui.find({ key: 'item:/proj/src' })).toBeUndefined()
  expect((await ui.find({ key: 'row:/proj/src' }))?.props.label).toBe('src/')
  expect((await ui.find({ key: 'arrow:/proj/src' }))?.props.label).toBe('▸ ')
  expect(await ui.find({ key: 'arrow:/proj/notes.txt' })).toBeUndefined()

  // a press on the name never opens the dir, the selected one neither
  await ui.press({ key: 'row:/proj/src' })
  await ui.press({ key: 'row:/proj/src' })
  expect(await ui.find({ key: 'row:/proj/src/main.ts' })).toBeUndefined()
  await ui.press({ key: 'arrow:/proj/src' })
  expect(await ui.find({ key: 'row:/proj/src/main.ts' })).toBeDefined()
  expect((await ui.find({ key: 'arrow:/proj/src' }))?.props.label).toBe('▾ ')
  await ui.press({ key: 'arrow:/proj/src' })
  expect(await ui.find({ key: 'row:/proj/src/main.ts' })).toBeUndefined()

  // no double-click here: `copy path` copies
  await ui.press({ key: 'copy' })
  expect(copied).toEqual(['src'])
})

// ---------------------------------------------------------------- New file

// A root with `src/x.ts`; mounts the pane with toasts recorded.
const naming = async ($: Engine, on: On, surface: 'terminal' | 'desktop', root: string) => {
  mock.store(on)
  fake(on, [], [], [], () => root)
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  TREE[root] = [entry('src', 'dir')]
  TREE[root + '/src'] = [entry('x.ts', 'file')]
  FILES[root + '/src/x.ts'] = 'x\n'
  await $.session.start({ cwd: root, surface, isInteractive: true })
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface,
    component: 'Pane',
    props: PROPS,
    requestId: 'ide-explorer',
    viewport: VIEWPORT,
  })
  const settle = async () => {
    for (let i = 0; i < 8; i++) await ui.advance(250)
  }

  return { ui, settle, toasts }
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: new opens an empty dirty editor, the first save creates the file`, async ($, on) => {
    const { ui, settle } = await naming($, on, surface, '/nf1-' + surface)
    expect(await ui.find({ key: 'new' })).toBeDefined()
    await ui.press({ key: `row:/nf1-${surface}/src` })
    await ui.press({ key: 'new' })
    const field = await ui.find({ key: 'new-file' })
    expect(field?.props.label).toBe('new file in src/')
    expect(field?.props.submitLabel).toBe('Create')

    await ui.input({ key: 'new-file', text: ' a/b.ts ' })
    await ui.resize({ columns: 60, rows: 10, in: 'editor' })
    await settle()
    expect(await ui.find({ key: 'new-file' })).toBeUndefined()
    expect(await ui.find({ key: 'editor' })).toBeDefined()
    expect(await titleOf(ui)).toBe(' ● Edit ')
    expect(FILES[`/nf1-${surface}/src/a/b.ts`]).toBeUndefined()
    expect(TREE[`/nf1-${surface}/src/a`]).toBeUndefined()

    await ui.key({ key: 'y', in: 'editor' })
    await ui.key({ key: 's', ctrl: true, in: 'editor' })
    await settle()
    expect(FILES[`/nf1-${surface}/src/a/b.ts`]).toBe('y')
    expect(await titleOf(ui)).toBe(' Edit ')
    expect(await ui.find({ key: `row:/nf1-${surface}/src/a` })).toBeDefined()
    expect(await ui.find({ key: `row:/nf1-${surface}/src/a/b.ts` })).toBeDefined()
  })

  test(`${surface}: new refuses a taken name and \`..\`, writing nothing`, async ($, on) => {
    const { ui, toasts } = await naming($, on, surface, '/nf2-' + surface)
    await ui.press({ key: `row:/nf2-${surface}/src` })
    await ui.press({ key: 'new' })
    const before = { ...FILES }

    await ui.input({ key: 'new-file', text: 'x.ts' })
    expect(toasts.at(-1)).toBe('Already exists: src/x.ts')
    await ui.input({ key: 'new-file', text: '../x' })
    expect(toasts.at(-1)).toBe('No \`..\` in a new file name')
    expect(FILES).toEqual(before)
    expect(await ui.find({ key: 'editor' })).toBeUndefined()
    expect(await ui.find({ key: 'new-file' })).toBeDefined()

    await ui.press({ key: 'new:cancel' })
    expect(await ui.find({ key: 'new-file' })).toBeUndefined()
  })

  test(`${surface}: new from a file names in its dir; with no selection, in the root`, async ($, on) => {
    const { ui } = await naming($, on, surface, '/nf3-' + surface)
    await ui.press({ key: 'new' })
    expect((await ui.find({ key: 'new-file' }))?.props.label).toBe('new file in ./')
    await ui.press({ key: `row:/nf3-${surface}/src` })
    await ui.press({ key: `row:/nf3-${surface}/src` })
    await ui.press({ key: `row:/nf3-${surface}/src/x.ts` })
    await ui.press({ key: 'new' })
    expect((await ui.find({ key: 'new-file' }))?.props.label).toBe('new file in src/')
  })

  test(`${surface}: new over unsaved text asks first, discard shows the name field`, async ($, on) => {
    const { ui, settle } = await editing($, on, surface, `/nf4-${surface}`, { 'a.ts': 'one\n' })
    await ui.key({ key: 'x', in: 'editor' })
    await settle()
    await ui.press({ key: 'new' })
    expect(await ui.find({ key: 'ask:save' })).toBeDefined()
    expect(await ui.find({ key: 'new-file' })).toBeUndefined()

    await ui.press({ key: 'ask:discard' })
    expect(await ui.find({ key: 'editor' })).toBeUndefined()
    expect((await ui.find({ key: 'new-file' }))?.props.label).toBe('new file in ./')
    expect(FILES[`/nf4-${surface}/a.ts`]).toBe('one\n')
  })

  test(`${surface}: header lines: title, tabs and actions on one row, then the interactive line only while it asks`, async ($, on) => {
    const { ui, settle } = await editing($, on, surface, `/hl-${surface}`, { 'a.ts': 'one\n' })
    const lines = async () =>
      (await ui.findAll({ type: 'Box' }))
        .map(box => box.key ?? '')
        .filter(key => key === 'header' || key.startsWith('header:'))
    // the controls' keys, without the terminal's chrome Boxes around them
    const controls = (node: unknown) => keysIn(node).filter(key => !key.endsWith(':chrome'))
    const ask = async () => controls((await ui.findAll({ type: 'Box' })).find(box => box.key === 'header:ask'))
    expect(await lines()).toEqual(['header', 'header:tabs', 'header:actions'])
    expect(await ui.find({ type: 'Text', text: ' Explorer' })).toBeDefined()
    const header = await ui.findAll({ type: 'Box' })
    // one title row: the title, a divider, the tabs, a divider, the actions
    expect(controls(header.find(box => box.key === 'header:tabs'))).toEqual(
      expect.arrayContaining(['tab:files', 'tab:unity', 'header:actions', 'refresh']),
    )
    expect((await ui.findAll({ type: 'Text', text: '|' })).length).toBe(2)
    expect(controls(header.find(box => box.key === 'header:actions'))).toEqual(
      expect.arrayContaining(['refresh', 'new', 'delete']),
    )

    // the name field and its cancel
    await ui.press({ key: 'new' })
    expect(await lines()).toEqual(['header', 'header:tabs', 'header:actions', 'header:ask'])
    expect(await ask()).toEqual(['new-file', 'new:cancel'])
    await ui.press({ key: 'new:cancel' })
    expect(await lines()).toEqual(['header', 'header:tabs', 'header:actions'])

    // the delete bar
    await ui.press({ key: 'delete' })
    expect(await ask()).toEqual(['delete:confirm', 'delete:cancel'])
    await ui.press({ key: 'delete:cancel' })
    expect(await lines()).toEqual(['header', 'header:tabs', 'header:actions'])

    // the unsaved-changes bar wins over the name field
    await ui.key({ key: 'x', in: 'editor' })
    await settle()
    await ui.press({ key: 'new' })
    expect(await ask()).toEqual(['ask:save', 'ask:discard', 'ask:cancel'])
    await ui.press({ key: 'ask:cancel' })
    expect(await lines()).toEqual(['header', 'header:tabs', 'header:actions'])
  })
}

// Every element key under a found node, in drawing order.
const keysIn = (node: unknown): string[] => {
  const out: string[] = []
  const walk = (at: unknown, isRoot: boolean): void => {
    if (at === null || typeof at !== 'object') return
    const n = at as { key?: string; props?: { key?: string }; children?: unknown[] }
    const key = n.key ?? n.props?.key
    if (!isRoot && typeof key === 'string') out.push(key)
    for (const child of n.children ?? []) walk(child, false)
  }
  walk(node, true)

  return out
}

// ------------------------------------------------------------------ Delete

// A root with `src/{x.ts,y.ts}`, `a.txt` and `b.txt`; mounts the pane with
// rm calls and toasts recorded.
const deleting = async ($: Engine, on: On, surface: 'terminal' | 'desktop', root: string) => {
  mock.store(on)
  const calls: string[][] = []
  fake(on, calls, [], [], () => root)
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  TREE[root] = [entry('src', 'dir'), entry('a.txt', 'file'), entry('b.txt', 'file')]
  TREE[root + '/src'] = [entry('x.ts', 'file'), entry('y.ts', 'file')]
  FILES[root + '/a.txt'] = 'aaa\n'
  FILES[root + '/b.txt'] = 'bbb\n'
  FILES[root + '/src/x.ts'] = 'x\n'
  FILES[root + '/src/y.ts'] = 'y\n'
  await $.session.start({ cwd: root, surface, isInteractive: true })
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface,
    component: 'Pane',
    props: PROPS,
    requestId: 'ide-explorer',
    viewport: VIEWPORT,
  })
  const bar = async () => (await ui.find({ type: 'Text', text: /^Delete / }))?.text
  const rms = () => calls.filter(argv => argv[0] === 'rm' && argv.includes('--'))

  return { ui, toasts, bar, rms }
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: delete removes a file and selects the next sibling`, async ($, on) => {
    const root = '/del1-' + surface
    const { ui, toasts, bar, rms } = await deleting($, on, surface, root)
    // Nothing selected: no row to delete (the root never is one).
    expect(await ui.find({ key: 'delete' })).toBeUndefined()
    await ui.press({ key: `row:${root}/a.txt` })
    expect(await ui.find({ key: 'delete' })).toBeDefined()

    await ui.press({ key: 'delete' })
    expect(await bar()).toBe('Delete a.txt?')
    expect(rms()).toEqual([])
    await ui.press({ key: 'delete:confirm' })
    expect(rms()).toEqual([['rm', '-rf', '--', `${root}/a.txt`]])
    expect(await ui.find({ key: `row:${root}/a.txt` })).toBeUndefined()
    expect(await bar()).toBeUndefined()
    expect((await ui.find({ type: 'Code' }))?.text).toContain('bbb')
    expect(toasts.at(-1)).toBe('Deleted a.txt')
  })

  test(`${surface}: delete removes a dir with its children`, async ($, on) => {
    const root = '/del2-' + surface
    const { ui, bar, rms } = await deleting($, on, surface, root)
    await ui.press({ key: `row:${root}/src` })
    await ui.press({ key: `row:${root}/src` })
    expect(await ui.find({ key: `row:${root}/src/x.ts` })).toBeDefined()

    await ui.press({ key: 'delete' })
    expect(await bar()).toBe('Delete src/? (2 entries)')
    await ui.press({ key: 'delete:confirm' })
    expect(rms()).toEqual([['rm', '-rf', '--', `${root}/src`]])
    expect(await ui.find({ key: `row:${root}/src` })).toBeUndefined()
    expect(await ui.find({ key: `row:${root}/src/x.ts` })).toBeUndefined()
    expect(FILES[`${root}/src/x.ts`]).toBeUndefined()
    // the next sibling: a.txt, shown in the preview
    expect((await ui.find({ type: 'Code' }))?.text).toContain('aaa')
  })

  test(`${surface}: cancel removes nothing`, async ($, on) => {
    const root = '/del3-' + surface
    const { ui, bar, rms } = await deleting($, on, surface, root)
    await ui.press({ key: `row:${root}/b.txt` })
    await ui.press({ key: 'delete' })
    await ui.press({ key: 'delete:cancel' })
    expect(await bar()).toBeUndefined()
    expect(rms()).toEqual([])
    expect(FILES[`${root}/b.txt`]).toBe('bbb\n')
    expect(await ui.find({ key: `row:${root}/b.txt` })).toBeDefined()
  })

  test(`${surface}: a failing rm toasts and keeps the row`, async ($, on) => {
    const root = '/del4-' + surface
    const { ui, toasts, bar } = await deleting($, on, surface, root)
    FAIL_RM.add(`${root}/b.txt`)
    await ui.press({ key: `row:${root}/b.txt` })
    await ui.press({ key: 'delete' })
    await ui.press({ key: 'delete:confirm' })
    FAIL_RM.delete(`${root}/b.txt`)
    expect(toasts.at(-1)).toBe(`Delete failed: rm: cannot remove '${root}/b.txt': Permission denied`)
    expect(await bar()).toBeUndefined()
    expect(await ui.find({ key: `row:${root}/b.txt` })).toBeDefined()
    expect((await ui.find({ type: 'Code' }))?.text).toContain('bbb')
  })

  test(`${surface}: deleting the file in a dirty editor warns, closes it and drops the draft`, async ($, on) => {
    const root = '/del5-' + surface
    const { ui, settle } = await editing($, on, surface, root, { 'a.ts': 'one\n', 'b.ts': 'two\n' })
    await ui.key({ key: 'x', in: 'editor' })
    await settle()
    const draft = draftFile(HOME, root + '/a.ts')
    expect(FILES[draft]).toBe('xone\n')

    await ui.press({ key: 'delete' })
    expect((await ui.find({ type: 'Text', text: /^Delete / }))?.text).toBe(
      'Delete a.ts? (open in editor, unsaved)',
    )
    // The delete bar is not the unsaved-changes one.
    expect(await ui.find({ key: 'ask:save' })).toBeUndefined()
    await ui.press({ key: 'delete:confirm' })
    await settle()
    expect(await ui.find({ key: 'editor' })).toBeUndefined()
    expect(FILES[root + '/a.ts']).toBeUndefined()
    expect(FILES[draft]).toBeUndefined()
    expect(await ui.find({ key: `row:${root}/a.ts` })).toBeUndefined()
    expect((await ui.find({ type: 'Code' }))?.text).toContain('two')
  })

  test(`${surface}: no delete while the unsaved-changes bar is up`, async ($, on) => {
    const root = '/del6-' + surface
    const { ui, settle } = await editing($, on, surface, root, { 'a.ts': 'one\n', 'b.ts': 'two\n' })
    await ui.key({ key: 'x', in: 'editor' })
    await settle()
    await ui.press({ key: `row:${root}/b.ts` })
    expect(await ui.find({ key: 'ask:save' })).toBeDefined()
    expect(await ui.find({ key: 'delete' })).toBeUndefined()
  })

  test(`${surface}: unity mode deletes the .meta in the same rm`, async ($, on) => {
    const root = '/del7-' + surface
    const calls: string[][] = []
    const store = new Map<string, unknown>([['explorer.mode:' + root, 'unity']])
    on('store.get', (_$, e) => ({ value: store.get(e.key) }))
    on('store.set', (_$, e) => {
      store.set(e.key, e.value)

      return { value: undefined }
    })
    fake(on, calls, [], [], () => root)
    TREE[root] = [entry('Assets', 'dir'), entry('ProjectSettings', 'dir')]
    TREE[root + '/ProjectSettings'] = [entry('ProjectVersion.txt', 'file')]
    TREE[root + '/Assets'] = [entry('a.png', 'file'), entry('a.png.meta', 'file'), entry('b.png', 'file')]
    FILES[root + '/ProjectSettings/ProjectVersion.txt'] = 'm_EditorVersion: 6000.0.0f1\n'
    FILES[root + '/Assets/a.png'] = 'png'
    FILES[root + '/Assets/a.png.meta'] = 'guid: 0123\n'
    FILES[root + '/Assets/b.png'] = 'png'
    await $.session.start({ cwd: root, surface, isInteractive: true })
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'Pane',
      props: PROPS,
      requestId: 'ide-explorer',
      viewport: VIEWPORT,
    })
    await ui.press({ key: `row:${root}/Assets` })
    await ui.press({ key: `row:${root}/Assets` })
    await ui.press({ key: `row:${root}/Assets/a.png` })
    await ui.press({ key: 'delete' })
    expect((await ui.find({ type: 'Text', text: /^Delete / }))?.text).toBe('Delete a.png? + .meta')
    await ui.press({ key: 'delete:confirm' })
    expect(calls.filter(argv => argv[0] === 'rm')).toEqual([
      ['rm', '-rf', '--', `${root}/Assets/a.png`, `${root}/Assets/a.png.meta`],
    ])
    expect(FILES[root + '/Assets/a.png.meta']).toBeUndefined()
    expect(await ui.find({ key: `row:${root}/Assets/b.png` })).toBeDefined()
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: Preview's horizontal bar drags the code sideways, a new file starts at column 0`, async ($, on) => {
    mock.store(on)
    fake(on, [], [], [], () => '/wide')
    on('ui.focus', () => ({}))
    const long = Array.from({ length: 300 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('')
    TREE['/wide'] = [entry('a.txt', 'file'), entry('b.txt', 'file')]
    FILES['/wide/a.txt'] = long + '\nshort\n'
    FILES['/wide/b.txt'] = 'tiny\n'
    await $.session.start({ cwd: '/wide', surface, isInteractive: true })
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'Pane',
      props: PROPS,
      requestId: 'ide-explorer',
      viewport: VIEWPORT,
    })
    const source = async () => String((await ui.find({ type: 'Code' }))?.props.source ?? '')
    const startLine = async () => (await ui.find({ type: 'Code' }))?.props.startLine

    // a short file: everything fits, no bar
    await ui.press({ key: 'row:/wide/b.txt' })
    expect(await source()).toBe('tiny')
    expect(await ui.find({ key: 'hb:preview' })).toBeUndefined()

    // the 300-column line overflows: the bar is drawn, the thumb at the left
    await ui.press({ key: 'row:/wide/a.txt' })
    expect(await ui.find({ key: 'hb:preview' })).toBeDefined()
    expect((await source()).startsWith(long)).toBe(true)
    const bar = async () => (await ui.findAll({ type: 'Text', in: 'hb:preview' })).map(t => t.text).join('')
    expect((await bar()).startsWith('━')).toBe(true)

    // a drag moves the first column shown; the line numbers stay
    const props = (await ui.find({ key: 'hb:preview' }))?.props.props as {
      total: number
      visible: number
      height: number
    }
    expect(props.total).toBe(300)
    const width = props.height
    await ui.resize({ columns: width, rows: 1, in: 'hb:preview' })
    const thumb = Math.round((width * props.visible) / props.total)
    const free = width - thumb
    const span = props.total - props.visible
    await ui.pointer({ type: 'down', x: 0, y: 0, button: 'left', in: 'hb:preview' })
    await ui.pointer({ type: 'move', x: 10, y: 0, button: 'left', in: 'hb:preview' })
    const mid = Math.round((10 / free) * span)
    expect(mid > 0).toBe(true)
    expect((await source()).startsWith(long.slice(mid, mid + 20))).toBe(true)
    expect(await startLine()).toBe(1)
    await ui.pointer({ type: 'up', x: free, y: 0, button: 'left', in: 'hb:preview' })
    expect((await source()).split('\n')[0]).toBe(long.slice(span))
    expect((await bar()).endsWith('━')).toBe(true)
    expect(await startLine()).toBe(1)

    // another file, then back: the slice starts at column 0 again
    await ui.press({ key: 'row:/wide/b.txt' })
    expect(await source()).toBe('tiny')
    await ui.press({ key: 'row:/wide/a.txt' })
    expect((await source()).startsWith(long)).toBe(true)
  })

  test(`${surface}: a text preview scrolled past a line's end keeps that line's row`, async ($, on) => {
    mock.store(on)
    fake(on, [], [], [], () => '/wide2')
    on('ui.focus', () => ({}))
    const long = 'd'.repeat(200)
    TREE['/wide2'] = [entry(long, 'dir')]
    TREE['/wide2/' + long] = [entry('x.txt', 'file')]
    await $.session.start({ cwd: '/wide2', surface, isInteractive: true })
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'Pane',
      props: PROPS,
      requestId: 'ide-explorer',
      viewport: VIEWPORT,
    })
    const lines = async () =>
      (await ui.findAll({ type: 'Text' })).filter(t => t.props.wrap === 'truncate-end').map(t => t.text)
    await ui.press({ key: 'row:/wide2/' + long })
    expect(await lines()).toContain('1 entries')
    const count = (await lines()).length
    const props = (await ui.find({ key: 'hb:preview' }))?.props.props as { height: number }
    const width = props.height
    await ui.resize({ columns: width, rows: 1, in: 'hb:preview' })
    await ui.pointer({ type: 'down', x: 0, y: 0, button: 'left', in: 'hb:preview' })
    await ui.pointer({ type: 'move', x: 1000, y: 0, button: 'left', in: 'hb:preview' })
    await ui.pointer({ type: 'up', x: 1000, y: 0, button: 'left', in: 'hb:preview' })
    // the dir's name is cut to its tail; the short lines are a blank row each
    const after = await lines()
    expect(after).not.toContain('1 entries')
    expect(after.length).toBe(count)
    expect(after.filter(t => t === ' ').length).toBe(2)
  })
}

// ------------------------------------------------------------------ Theme

for (const surface of ['terminal', 'desktop'] as const) {
  const frames = async (ui: Pane) =>
    (await ui.findAll({ type: 'Box' })).filter(box => box.props.borderStyle === 'round')

  test(`${surface}: the theme paints the frames, selection and editor; the page keeps the terminal's background`, async ($, on) => {
    memoryStore(on, new Map<string, unknown>())
    fake(on)
    await $.session.start(start(surface))
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'Pane',
      props: PROPS,
      requestId: 'ide-explorer',
      viewport: VIEWPORT,
    })
    const t = DARK

    expect(await pageBg(ui)).toBeUndefined()
    const framed = await frames(ui)
    expect(framed.length).toBe(2)
    for (const box of framed) expect(box.props.borderColor).toBe(t.border)
    expect((await ui.find({ key: 'title:files:chrome' }))?.props.backgroundColor).toBe(onDefaultFg(t.accent))

    await ui.press({ key: 'row:/proj/notes.txt' })
    expect((await ui.find({ key: 'line:/proj/notes.txt' }))?.props.backgroundColor).toBe(onDefaultFg(t.surfaceHover))
    expect((await ui.find({ key: 'line:/proj/out.log' }))?.props.backgroundColor).toBeUndefined()

    // the editor client gets the theme's colors
    await ui.press({ key: 'row:/proj/src' })
    await ui.press({ key: 'row:/proj/src' })
    await ui.press({ key: 'row:/proj/src/main.ts' })
    await ui.press({ key: 'edit' })
    const props = (await ui.find({ key: 'editor' }))?.props.props as { colors: { text: string; gutter: string } }
    expect(props.colors.text).toBe(t.text)
    expect(props.colors.gutter).toBe(t.muted)
  })

  test(`${surface}: /color tints the frames and the accent`, async ($, on) => {
    mock.store(on)
    fake(on)
    on('command.run', { command: 'color' }, () => ({ text: 'Session color set to: green' }))
    await $.session.start(start(surface))
    await $.command.run({
      command: 'color',
      args: 'green',
      origin: { kind: 'composer' },
      presentation: PRESENTATION,
    })
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'Pane',
      props: PROPS,
      requestId: 'ide-explorer',
      viewport: VIEWPORT,
    })

    const green = sessionHex('green')
    const framed = await frames(ui)
    expect(framed.length).toBe(2)
    for (const box of framed) expect(box.props.borderColor).toBe(green)
    expect((await ui.find({ key: 'title:preview:chrome' }))?.props.backgroundColor).toBe(onDefaultFg(green))
  })

  test(`${surface}: the interactive line is a tinted alert, its Buttons keep their keys`, async ($, on) => {
    mock.store(on)
    fake(on)
    await $.session.start(start(surface))
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'Pane',
      props: PROPS,
      requestId: 'ide-explorer',
      viewport: VIEWPORT,
    })
    const t = DARK

    await ui.press({ key: 'row:/proj/notes.txt' })
    expect(await ui.find({ key: 'delete' })).toBeDefined()
    await ui.press({ key: 'delete' })
    expect((await ui.find({ key: 'header:ask' }))?.props.backgroundColor).toBe(t.surface)
    expect((await ui.find({ type: 'Text', text: /^Delete / }))?.props.color).toBe(t.danger)
    if (surface === 'terminal') {
      expect((await ui.find({ key: 'delete:confirm:chrome' }))?.props.backgroundColor).toBe(onDefaultFg(t.danger))
    }
    await ui.press({ key: 'delete:cancel' })
    expect(await ui.find({ key: 'header:ask' })).toBeUndefined()
  })
}

// ------------------------------------------------------------ Settings

// A store in memory that also deletes, and what it holds.
const settingsStore = (on: On, entries: [string, unknown][] = []) => {
  const store = new Map<string, unknown>(entries)
  memoryStore(on, store)
  on('store.delete', (_$, e) => {
    store.delete(e.key)

    return { value: undefined }
  })

  return store
}

for (const surface of ['terminal', 'desktop'] as const) {
  const mountPane = ($: Engine, requestId: 'ide-explorer' | 'ide-git') =>
    $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', props: PROPS, requestId, viewport: VIEWPORT })

  test(`${surface}: the ⚙ opens Settings; a change applies at once, cancel puts it back, done saves`, async ($, on) => {
    const store = settingsStore(on)
    fake(on)
    on('command.run', { command: 'color' }, () => ({ text: 'Session color set to: green' }))
    await $.session.start(start(surface))
    await $.command.run({ command: 'color', args: 'green', origin: { kind: 'composer' }, presentation: PRESENTATION })
    const ui = await mountPane($, 'ide-explorer')
    const git = await mountPane($, 'ide-git')
    // the /color accent tints the frames while Accent from /color is on
    const green = sessionHex('green')
    const tinted = async () => (await ui.findAll({ type: 'Box' })).some(box => box.props.borderColor === green)
    expect(await tinted()).toBe(true)

    expect(await ui.find({ key: 'settings' })).toBeDefined()
    expect(await ui.find({ key: 'settings:sheet' })).toBeUndefined()
    await ui.press({ key: 'settings' })
    expect(await ui.find({ key: 'settings:sheet' })).toBeDefined()
    // only the pane whose ⚙ was pressed draws the sheet
    expect(await git.find({ key: 'settings:sheet' })).toBeUndefined()
    // no blank labels: every sheet Button has one
    for (const b of await ui.findAll({ type: 'Button' })) {
      if ((b.key ?? '').startsWith('settings:')) expect(String(b.props.label).trim().length > 0).toBe(true)
    }

    await ui.press({ key: 'settings:accent' })
    expect(await tinted()).toBe(false)
    // live, not saved yet
    expect(store.get('settings')).toBeUndefined()

    await ui.press({ key: 'settings:cancel' })
    expect(await ui.find({ key: 'settings:sheet' })).toBeUndefined()
    expect(await tinted()).toBe(true)
    expect(store.get('settings')).toBeUndefined()

    // done saves; the next session starts with it
    await ui.press({ key: 'settings' })
    await ui.press({ key: 'settings:accent' })
    await ui.press({ key: 'settings:done' })
    expect(store.get('settings')).toEqual({ accentFromSession: false })
    expect(await ui.find({ key: 'settings:sheet' })).toBeUndefined()
    expect(await tinted()).toBe(false)
  })

  test(`${surface}: while the sheet is up the panel's Buttons sleep: a press does nothing`, async ($, on) => {
    settingsStore(on)
    fake(on)
    await $.session.start(start(surface))
    const ui = await mountPane($, 'ide-explorer')
    expect(await isActiveTab(ui, surface, 'files')).toBe(true)

    await ui.press({ key: 'settings' })
    await ui.press({ key: 'tab:unity' })
    await ui.press({ key: 'new' })
    expect(await isActiveTab(ui, surface, 'files')).toBe(true)
    expect(await ui.find({ key: 'new-file' })).toBeUndefined()
    expect(await ui.find({ key: 'settings:sheet' })).toBeDefined()

    // the ⚙ closes it, and the Buttons wake
    await ui.press({ key: 'settings' })
    expect(await ui.find({ key: 'settings:sheet' })).toBeUndefined()
    await ui.press({ key: 'tab:unity' })
    expect(await isActiveTab(ui, surface, 'unity')).toBe(true)
  })

  test(`${surface}: bad key overrides show the error and save nothing; good ones are saved`, async ($, on) => {
    const store = settingsStore(on)
    fake(on)
    await $.session.start(start(surface))
    const ui = await mountPane($, 'ide-explorer')
    await ui.press({ key: 'settings' })

    await ui.input({ key: 'settings:keys', text: '{"duplicateLines": ', kind: 'change' })
    expect(await ui.find({ type: 'Text', text: /^✕ invalid JSON/ })).toBeDefined()
    await ui.input({ key: 'settings:keys', text: '{"nope":"ctrl+k"}', kind: 'change' })
    expect(await ui.find({ type: 'Text', text: /unknown action "nope"/ })).toBeDefined()
    await ui.press({ key: 'settings:done' })
    expect(store.get('settings')).toEqual({})

    await ui.press({ key: 'settings' })
    const good = '{"duplicateLines":"ctrl+shift+d"}'
    await ui.input({ key: 'settings:keys', text: good, kind: 'change' })
    expect(await ui.find({ type: 'Text', text: /^✕ / })).toBeUndefined()
    await ui.press({ key: 'settings:done' })
    expect(store.get('settings')).toEqual({ keys: good })
  })

  test(`${surface}: reset layout clears the stored layouts and both panels' splits`, async ($, on) => {
    const store = settingsStore(on, [
      ['layout:explorer', { tree: 0.6 }],
      ['layout:git', { side: 0.5 }],
    ])
    fake(on)
    await $.session.start(start(surface))
    const ui = await mountPane($, 'ide-explorer')
    const cells = async () => ((await ui.find({ key: 'split:tree' }))?.props.props as { cells?: number } | undefined)?.cells
    // 60% of 118 body columns, rounded down
    expect(await cells()).toBe(70)

    await ui.press({ key: 'settings' })
    await ui.press({ key: 'settings:reset' })
    expect(store.has('layout:explorer')).toBe(false)
    expect(store.has('layout:git')).toBe(false)
    // the default 35%
    expect(await cells()).toBe(41)
  })

  test(`${surface}: Settings opens over a dirty editor, which keeps its text; the keymap follows live`, async ($, on) => {
    const { ui, settle } = await editing($, on, surface, '/ed9', { 'a.ts': 'one\n' })
    const keymapOf = async () => ((await ui.find({ key: 'editor' }))?.props.props as { keymap: unknown }).keymap
    await ui.key({ key: 'x', in: 'editor' })
    await settle()
    expect(await keymapOf()).toEqual(KEYMAPS.jetbrains)

    await ui.press({ key: 'settings' })
    // no unsaved-changes bar: the sheet selects nothing
    expect(await ui.find({ key: 'ask:save' })).toBeUndefined()
    expect(await ui.find({ key: 'settings:sheet' })).toBeDefined()
    expect(await ui.find({ key: 'editor' })).toBeDefined()
    await ui.press({ key: 'settings:keymap:vscode' })
    expect(await keymapOf()).toEqual(KEYMAPS.vscode)

    await ui.press({ key: 'settings:cancel' })
    expect(await keymapOf()).toEqual(KEYMAPS.jetbrains)
    expect(await titleOf(ui)).toContain('●')
    // closed: no sheet Button is left to take a key
    expect((await ui.findAll({ type: 'Button' })).some(b => (b.key ?? '').startsWith('settings:'))).toBe(false)
  })

  test(`${surface}: the default mode applies to a root with no mode saved`, async ($, on) => {
    settingsStore(on, [['settings', { explorerMode: 'unity' }]])
    fake(on)
    await $.session.start(start(surface))
    const ui = await mountPane($, 'ide-explorer')
    expect(await isActiveTab(ui, surface, 'unity')).toBe(true)
  })
}

// ------------------------------------------------- A new session (/clear)

// `$.state` as the plugin writes it, and a new session's empty state on
// demand: the kit keeps `$.state` across `$.session.end`, the engine does not.
// After `empty()` a key reads as never written until the plugin writes it;
// `held` answers for keys the plugin has not written yet.
const sessionState = (on: On, held: Record<string, unknown> = {}) => {
  const written = new Map<string, unknown>()
  const fresh = new Set<string>()
  on('state.set', (_$, e, next) => {
    if (e.plugin === PLUGIN) {
      written.set(e.key, e.value)
      fresh.delete(e.key)
    }

    return next(e)
  })
  on('state.get', (_$, e, next) => {
    if (e.plugin !== PLUGIN || written.has(e.key)) return next(e)
    if (fresh.has(e.key)) return { value: { value: undefined, version: 0 } }

    return e.key in held ? { value: { value: held[e.key], version: 1 } } : next(e)
  })
  // Nothing beneath the plugins answers these here.
  on('session.end', () => ({ sessionId: 's' }))
  on('classic.SessionStart', () => ({}))

  return {
    value: (key: 'explorer' | 'git' | 'settings') => written.get(key) as Record<string, any> | undefined,
    empty: () => {
      for (const key of ['explorer', 'git', 'settings', 'sessionColor', 'settingsUi']) fresh.add(key)
      written.clear()
    },
  }
}


for (const surface of ['terminal', 'desktop'] as const) {
  const mountPane = ($: Engine, requestId: 'ide-explorer' | 'ide-git') =>
    $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', props: PROPS, requestId, viewport: VIEWPORT })
  const PRESETS = { settings: { accentFromSession: false, explorerMode: 'unity' }, 'layout:explorer': { tree: 0.5 } }

  test(`${surface}: a /clear with nothing carried takes the presets from the store`, async ($, on) => {
    const state = sessionState(on)
    mock.store(on, PRESETS)
    fake(on)
    await $.classic.SessionStart({ source: 'clear' })

    expect(state.value('settings')).toEqual(PRESETS.settings)
    expect(state.value('explorer')?.mode).toBe('unity')
    expect(state.value('explorer')?.split).toEqual({ tree: 0.5 })
  })

  test(`${surface}: a compact seeds nothing`, async ($, on) => {
    const state = sessionState(on)
    mock.store(on, PRESETS)
    fake(on)
    await $.classic.SessionStart({ source: 'compact' })

    expect(state.value('settings')).toBeUndefined()
    expect(state.value('explorer')).toBeUndefined()
  })

  for (const [source, reason] of [['clear', 'clear'], ['resume', 'resume'], ['fork', 'other']] as const) {
    test(`${surface}: a ${source} keeps the view: dirs, selection, editor, git tab and Settings`, async ($, on) => {
      // git on its Graph tab (no git beneath this kit to press it there)
      const state = sessionState(on, { git: { ref: 'all', offset: 0, branchOffset: 0, detailOffset: 0, tab: 'graph' } })
      mock.store(on)
      fake(on)
      await $.session.start(start(surface))
      const ui = await mountPane($, 'ide-explorer')
      await ui.press({ key: 'row:/proj/src' })
      await ui.press({ key: 'row:/proj/src' })
      await ui.press({ key: 'row:/proj/src/main.ts' })
      await ui.press({ key: 'edit' })
      // a setting changed, not saved: kept too
      await ui.press({ key: 'settings' })
      await ui.press({ key: 'settings:accent' })
      const before = state.value('explorer')!
      expect(before.expanded).toEqual(['/proj/src'])
      expect(before.edit?.path).toBe('/proj/src/main.ts')

      await $.session.end({ reason, sessionId: 's1', resume: { id: 's1' } })
      state.empty()
      await $.classic.SessionStart({ source })

      const after = state.value('explorer')!
      expect(after.expanded).toEqual(['/proj/src'])
      expect(after.selected).toBe('/proj/src/main.ts')
      expect(after.mode).toBe('files')
      // the editor asks for its text again
      expect(after.edit?.path).toBe('/proj/src/main.ts')
      expect(after.edit?.version).toBe(before.edit.version + 1)
      expect(state.value('git')?.tab).toBe('graph')
      expect(state.value('settings')?.accentFromSession).toBe(false)
      expect(await ui.find({ key: 'editor' })).toBeDefined()
      // the sheet is session only
      expect(await ui.find({ key: 'settings:sheet' })).toBeUndefined()
    })
  }
}

// ---------------------------------------------------------- Multi-selection

// Mounts `/proj` with copies and toasts recorded.
const marking = async <S extends 'terminal' | 'desktop' | 'vscode'>($: Engine, on: On, surface: S) => {
  mock.store(on)
  const clock = mock.clock(on)
  fake(on)
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
  await $.session.start({ cwd: CWD, surface, isInteractive: true })
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface,
    component: 'Pane',
    props: PROPS,
    requestId: 'ide-explorer',
    viewport: VIEWPORT,
  })

  return { ui, copied, toasts, clock }
}

for (const surface of ['terminal', 'desktop'] as const) {
  const click = async (ui: Pane, path: string, x: number, flags: { ctrl?: true; shift?: true } = {}) => {
    await ui.pointer({ type: 'down', x, y: 0, button: 'left', in: 'item:' + path, ...flags })
    await ui.pointer({ type: 'up', x, y: 0, button: 'left', in: 'item:' + path, ...flags })
  }
  const rowOf = async (ui: Pane, path: string) =>
    (await ui.find({ key: 'item:' + path }))?.props.props as { isSelected?: boolean; isMarked?: boolean }
  const lit = async (ui: Pane, path: string) => {
    const row = await rowOf(ui, path)

    return row.isSelected === true || row.isMarked === true
  }

  test(`${surface}: ctrl-click and the mark cell mark rows; Preview lists them; a plain click clears`, async ($, on) => {
    const { ui } = await marking($, on, surface)
    await ui.press({ key: 'row:/proj/notes.txt' })
    expect(await ui.find({ key: 'edit' })).toBeDefined()

    // ctrl-click adds to the selection
    await click(ui, '/proj/out.log', 4, { ctrl: true })
    expect((await rowOf(ui, '/proj/notes.txt')).isMarked).toBe(true)
    expect((await rowOf(ui, '/proj/out.log')).isMarked).toBe(true)
    expect(await ui.find({ type: 'Text', text: 'notes.txt' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'out.log' })).toBeDefined()
    expect(await ui.find({ type: 'Code' })).toBeUndefined()
    expect((await ui.find({ key: 'title:preview:chrome' }))?.text).toBe(' Preview ')
    expect(await ui.find({ key: 'edit' })).toBeUndefined()
    expect(await ui.find({ key: 'new' })).toBeUndefined()

    // the mark cell toggles a row in and out
    await ui.advance(500)
    await click(ui, '/proj/app.bin', 0)
    expect((await rowOf(ui, '/proj/app.bin')).isMarked).toBe(true)
    await ui.advance(500)
    await click(ui, '/proj/notes.txt', 0)
    expect(await lit(ui, '/proj/notes.txt')).toBe(false)
    expect(await ui.find({ type: 'Text', text: 'notes.txt' })).toBeUndefined()
    // the message the Client posts does the same
    await ui.post({ hit: 'name', ctrl: true }, { in: 'item:/proj/out.log' })
    // one left: the marks go, that row is the selection
    expect((await rowOf(ui, '/proj/app.bin')).isMarked).toBe(false)
    expect((await rowOf(ui, '/proj/app.bin')).isSelected).toBe(true)

    // a plain click on an unmarked row ends a multi-selection
    await ui.post({ hit: 'mark' }, { in: 'item:/proj/notes.txt' })
    expect((await rowOf(ui, '/proj/notes.txt')).isMarked).toBe(true)
    await ui.advance(500)
    await click(ui, '/proj/src', 4)
    expect(await lit(ui, '/proj/notes.txt')).toBe(false)
    expect(await lit(ui, '/proj/app.bin')).toBe(false)
    expect((await rowOf(ui, '/proj/src')).isSelected).toBe(true)
    expect(await ui.find({ type: 'Text', text: /1 entries/ })).toBeDefined()
  })

  test(`${surface}: shift-click marks a range; a plain click on a marked row collapses after the double-click window`, async ($, on) => {
    const { ui, clock } = await marking($, on, surface)
    await ui.press({ key: 'row:/proj/src' })
    // files sort app.bin, notes.txt, out.log
    await ui.press({ key: 'row:/proj/app.bin' })
    await click(ui, '/proj/out.log', 4, { shift: true })
    for (const path of ['/proj/app.bin', '/proj/notes.txt', '/proj/out.log']) {
      expect((await rowOf(ui, path)).isMarked).toBe(true)
    }
    expect(await lit(ui, '/proj/src')).toBe(false)

    await ui.advance(500)
    await click(ui, '/proj/notes.txt', 4)
    expect((await rowOf(ui, '/proj/app.bin')).isMarked).toBe(true)
    await clock.advance(500)
    expect(await lit(ui, '/proj/app.bin')).toBe(false)
    expect((await rowOf(ui, '/proj/notes.txt')).isSelected).toBe(true)
  })

  test(`${surface}: y and a double-click on a marked row copy every marked path`, async ($, on) => {
    const { ui, copied, toasts, clock } = await marking($, on, surface)
    await ui.post({ hit: 'arrow' }, { in: 'item:/proj/src' })
    await ui.press({ key: 'row:/proj/src/main.ts' })
    await ui.post({ hit: 'name', ctrl: true }, { in: 'item:/proj/out.log' })
    await ui.post({ hit: 'mark' }, { in: 'item:/proj/notes.txt' })
    expect(await ui.find({ key: 'copy' })).toBeDefined()
    await ui.press({ key: 'copy' })
    // tree order, named from the repo toplevel
    expect(copied).toEqual(['src/main.ts\nnotes.txt\nout.log'])
    expect(toasts.at(-1)).toBe('Copied 3 paths')

    await ui.advance(500)
    await click(ui, '/proj/notes.txt', 4)
    await ui.advance(100)
    await click(ui, '/proj/notes.txt', 4)
    expect(copied).toHaveLength(2)
    expect(copied.at(-1)).toBe('src/main.ts\nnotes.txt\nout.log')
    // the double-click kept the marks
    await ui.advance(500)
    await clock.advance(500)
    expect((await rowOf(ui, '/proj/out.log')).isMarked).toBe(true)
  })

  test(`${surface}: refresh and a mode switch clear the marks; closing a dir unmarks what it hides`, async ($, on) => {
    const { ui } = await marking($, on, surface)
    await ui.press({ key: 'row:/proj/notes.txt' })
    await ui.post({ hit: 'mark' }, { in: 'item:/proj/out.log' })
    expect((await rowOf(ui, '/proj/out.log')).isMarked).toBe(true)
    await ui.press({ key: 'refresh' })
    expect(await lit(ui, '/proj/out.log')).toBe(false)

    await ui.post({ hit: 'mark' }, { in: 'item:/proj/out.log' })
    expect((await rowOf(ui, '/proj/out.log')).isMarked).toBe(true)
    await ui.press({ key: 'tab:unity' })
    await ui.press({ key: 'tab:files' })
    expect(await lit(ui, '/proj/out.log')).toBe(false)

    await ui.post({ hit: 'arrow' }, { in: 'item:/proj/src' })
    await ui.post({ hit: 'mark' }, { in: 'item:/proj/src/main.ts' })
    await ui.post({ hit: 'mark' }, { in: 'item:/proj/out.log' })
    expect(await ui.find({ type: 'Text', text: 'src/main.ts' })).toBeDefined()
    await ui.post({ hit: 'arrow' }, { in: 'item:/proj/src' })
    expect(await ui.find({ type: 'Text', text: 'src/main.ts' })).toBeUndefined()
    expect((await rowOf(ui, '/proj/out.log')).isMarked).toBe(true)
  })

  test(`${surface}: a Bash call that removes a marked file unmarks it`, async ($, on) => {
    on('tool.call', () => ({ result: {}, text: '' }) as never)
    TREE['/proj'] = [...(TREE['/proj'] ?? []), entry('gone.txt', 'file')]
    FILES['/proj/gone.txt'] = 'g\n'
    const { ui } = await marking($, on, surface)
    await ui.press({ key: 'row:/proj/notes.txt' })
    await ui.post({ hit: 'mark' }, { in: 'item:/proj/gone.txt' })
    expect((await rowOf(ui, '/proj/notes.txt')).isMarked).toBe(true)
    removePath('/proj/gone.txt')
    await $.tool.call({ tool: 'Bash', command: 'rm gone.txt' })
    expect(await ui.find({ key: 'item:/proj/gone.txt' })).toBeUndefined()
    expect((await rowOf(ui, '/proj/notes.txt')).isMarked).toBe(false)
    expect((await ui.find({ type: 'Code' }))?.text).toContain('hello notes')
  })

  test(`${surface}: delete with 2+ marked asks once and removes them in one rm`, async ($, on) => {
    const root = '/delm-' + surface
    const { ui, toasts, bar, rms } = await deleting($, on, surface, root)
    await ui.post({ hit: 'arrow' }, { in: `item:${root}/src` })
    await ui.press({ key: `row:${root}/src` })
    // x.ts goes with its marked dir; it is not an operand of its own
    await click(ui, `${root}/src/x.ts`, 6, { ctrl: true })
    await ui.advance(500)
    await click(ui, `${root}/a.txt`, 4, { ctrl: true })
    expect((await rowOf(ui, `${root}/a.txt`)).isMarked).toBe(true)

    await ui.press({ key: 'delete' })
    expect(await bar()).toBe('Delete 2 items? (4 entries)')
    await ui.press({ key: 'delete:cancel' })
    expect(rms()).toEqual([])
    expect(await bar()).toBeUndefined()

    await ui.press({ key: 'delete' })
    await ui.press({ key: 'delete:confirm' })
    expect(rms()).toEqual([['rm', '-rf', '--', `${root}/src`, `${root}/a.txt`]])
    expect(await bar()).toBeUndefined()
    for (const path of ['src', 'src/x.ts', 'a.txt']) expect(await ui.find({ key: `row:${root}/${path}` })).toBeUndefined()
    expect(FILES[`${root}/src/y.ts`]).toBeUndefined()
    // the row after the first target among those that stay
    expect((await rowOf(ui, `${root}/b.txt`)).isSelected).toBe(true)
    expect((await ui.find({ type: 'Code' }))?.text).toContain('bbb')
    expect(toasts.at(-1)).toBe('Deleted 2 items')
    expect((await ui.find({ key: 'copy' }))?.props.label).not.toBe('Copy Paths')
  })

  test(`${surface}: two marked files: no entry count`, async ($, on) => {
    const root = '/delm2-' + surface
    const { ui, bar } = await deleting($, on, surface, root)
    await ui.press({ key: `row:${root}/a.txt` })
    await ui.post({ hit: 'mark' }, { in: `item:${root}/b.txt` })
    await ui.press({ key: 'delete' })
    expect(await bar()).toBe('Delete 2 items?')
  })
}

for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
  test(`${surface}: mark (m) toggles the cursor's row`, async ($, on) => {
    const { ui } = await marking($, on, surface)
    expect(await ui.find({ key: 'mark' })).toBeUndefined()
    await ui.press({ key: 'row:/proj/notes.txt' })
    expect(await ui.find({ key: 'mark' })).toBeDefined()
    // the arrow moves the cursor to src
    if (surface === 'vscode') await ui.press({ key: 'arrow:/proj/src' })
    else await (ui as unknown as Pane).post({ hit: 'arrow' }, { in: 'item:/proj/src' })
    await ui.press({ key: 'mark' })
    expect(await ui.find({ type: 'Text', text: 'src' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'notes.txt' })).toBeDefined()
    expect((await ui.find({ key: 'copy' }))?.props.label).toBe('Copy Paths')
    if (surface === 'vscode') {
      expect((await ui.find({ key: 'line:/proj/src' }))?.props.backgroundColor).toBeDefined()
    }
    await ui.press({ key: 'mark' })
    expect((await ui.find({ key: 'copy' }))?.props.label).toBe('Copy Path')
    expect((await ui.find({ type: 'Code' }))?.text).toContain('hello notes')
  })
}

// ------------------------------------------------------------------ Images

const IMG = '/img'
const MTIME = 1_700_000_000_000
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32"><rect width="64" height="32"/></svg>'

// A root of pictures: a PNG, a JPG and an SVG; no converter until a test adds one.
const images = async (
  $: Engine,
  on: On,
  surface: 'terminal' | 'desktop',
  tools: readonly string[] = [],
) => {
  TREE[IMG] = [entry('pic.png', 'file', 300), entry('photo.jpg', 'file', 300), entry('logo.svg', 'file', SVG.length)]
  TREE['/dev/shm'] = []
  FILES['/img/pic.png'] = 'P'.repeat(300)
  BYTES['/img/pic.png'] = PNG_200x100
  FILES['/img/photo.jpg'] = 'J'.repeat(300)
  FILES['/img/logo.svg'] = SVG
  TOOLS.clear()
  for (const tool of tools) TOOLS.add(tool)
  const calls: string[][] = []
  mock.store(on)
  const clock = mock.clock(on)
  fake(on, calls, [], [], () => IMG)
  await $.session.start({ cwd: IMG, surface, isInteractive: true })
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface,
    component: 'Pane',
    props: PROPS,
    requestId: 'ide-explorer',
    viewport: VIEWPORT,
  })

  return { ui, calls, clock }
}

const converts = (calls: string[][]) => calls.filter(argv => argv.some(arg => arg.startsWith('png:')))

test('terminal: a PNG draws as an Image of the file itself, fitted to Preview, with its info row', async ($, on) => {
  const { ui, calls, clock } = await images($, on, 'terminal', ['magick'])
  await ui.press({ key: 'row:/img/pic.png' })
  const image = await ui.find({ type: 'Image' })
  expect(image?.props.key).toBe('preview:image')
  expect(image?.props.source).toEqual({ file: '/img/pic.png', format: 'png', generation: MTIME })
  // 200x100 px (aspect 2) in Preview's 75x16 room left under the info row
  expect(image?.props.columns).toBe(64)
  expect(image?.props.rows).toBe(16)
  expect(await ui.find({ type: 'Text', text: /200×100 px · 300 B/ })).toBeDefined()
  expect(converts(calls)).toEqual([])
  // no scrollbars, no source toggle, no edit for a raster image
  expect(await ui.find({ key: 'sb:preview' })).toBeUndefined()
  expect(await ui.find({ key: 'hb:preview' })).toBeUndefined()
  expect(await ui.find({ key: 'preview:view' })).toBeUndefined()
  expect(await ui.find({ key: 'edit' })).toBeUndefined()
  // the probe's blit is taken: the picture stays
  await clock.advance(300)
  expect(await ui.find({ type: 'Image' })).toBeDefined()
})

test('terminal: a JPG is converted once to /dev/shm, then drawn from there', async ($, on) => {
  const { ui, calls } = await images($, on, 'terminal', ['magick'])
  const out = convertedPath('/dev/shm', '/img/photo.jpg', MTIME)
  await ui.press({ key: 'row:/img/photo.jpg' })
  expect(converts(calls)).toEqual([['magick', 'jpeg:/img/photo.jpg[0]', '-thumbnail', '2048x2048>', 'png:' + out]])
  const image = await ui.find({ type: 'Image' })
  expect(image?.props.source).toEqual({ file: out, format: 'png', generation: MTIME })
  expect(await ui.find({ type: 'Text', text: /200×100 px · 300 B/ })).toBeDefined()
  // drawn again (another file and back): the cache answers
  await ui.press({ key: 'row:/img/pic.png' })
  await ui.press({ key: 'row:/img/photo.jpg' })
  expect(converts(calls)).toHaveLength(1)
  expect(calls.filter(argv => argv[0] === 'magick' && argv[1] === '-version')).toHaveLength(1)
})

test('terminal: an SVG is converted by rsvg-convert when present', async ($, on) => {
  const { ui, calls } = await images($, on, 'terminal', ['magick', 'rsvg-convert'])
  await ui.press({ key: 'row:/img/logo.svg' })
  const out = convertedPath('/dev/shm', '/img/logo.svg', MTIME)
  expect(converts(calls)).toEqual([])
  expect(calls).toContainEqual(['rsvg-convert', '-f', 'png', '-o', out, '/img/logo.svg'])
  expect((await ui.find({ type: 'Image' }))?.props.source).toEqual({ file: out, format: 'png', generation: MTIME })
})

test('terminal: no converter: metadata and an install hint', async ($, on) => {
  const { ui } = await images($, on, 'terminal')
  await ui.press({ key: 'row:/img/photo.jpg' })
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'photo.jpg' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'install ImageMagick to preview jpg' })).toBeDefined()
})

test('desktop: an SVG draws as Svg, a PNG as metadata', async ($, on) => {
  const { ui, calls } = await images($, on, 'desktop', ['magick'])
  await ui.press({ key: 'row:/img/logo.svg' })
  const svg = await ui.find({ type: 'Svg' })
  expect(svg?.props.source).toBe(SVG)
  expect(await ui.find({ type: 'Text', text: /64×32 px/ })).toBeDefined()
  await ui.press({ key: 'row:/img/pic.png' })
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /200×100 px · 300 B/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'image preview needs a kitty-graphics terminal' })).toBeDefined()
  expect(converts(calls)).toEqual([])
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: the view chip flips an SVG to its source in the code preview and back`, async ($, on) => {
    const { ui } = await images($, on, surface, ['magick'])
    await ui.press({ key: 'row:/img/logo.svg' })
    const view = await ui.find({ key: 'preview:view' })
    expect(view?.props.label).toBe(' Source ')
    expect(await ui.find({ type: 'Code' })).toBeUndefined()
    expect(await ui.find({ key: 'edit' })).toBeUndefined()

    await ui.press({ key: 'preview:view' })
    expect((await ui.find({ type: 'Code' }))?.text).toContain('<svg')
    expect(await ui.find({ type: surface === 'terminal' ? 'Image' : 'Svg' })).toBeUndefined()
    expect((await ui.find({ key: 'preview:view' }))?.props.label).toBe(' Rendered ')
    // raw svg is code: it can be edited
    expect(await ui.find({ key: 'edit' })).toBeDefined()

    await ui.press({ key: 'preview:view' })
    expect(await ui.find({ type: 'Code' })).toBeUndefined()
    expect(await ui.find({ type: surface === 'terminal' ? 'Image' : 'Svg' })).toBeDefined()

    // another file starts rendered
    await ui.press({ key: 'preview:view' })
    await ui.press({ key: 'row:/img/pic.png' })
    await ui.press({ key: 'row:/img/logo.svg' })
    expect((await ui.find({ key: 'preview:view' }))?.props.label).toBe(' Source ')
  })
}

const imageCloser = {
  name: 'closer',
  register: (on: On) => {
    on('command.run', { command: 'close-explorer' }, async $ => {
      await $.ui.close({ id: 'ide-explorer' })

      return { text: '' }
    })
  },
}

test('terminal: closing the pane removes converted pictures', { plugins: [imageCloser] }, async ($, on) => {
  on('ui.panes', () => ({ value: [{ id: 'ide-explorer', isFocused: true }] as never }))
  on('ui.close', () => ({ value: undefined }))
  const { ui, calls } = await images($, on, 'terminal', ['magick'])
  await ui.press({ key: 'row:/img/photo.jpg' })
  const out = convertedPath('/dev/shm', '/img/photo.jpg', MTIME)
  await $.command.run({ command: 'close-explorer', args: '', origin: { kind: 'composer' }, presentation: PRESENTATION })
  expect(calls).toContainEqual(['rm', '-f', '--', out])
})

// ---------------------------------------------------------- Custom engines

const CUST = '/cust'
const ENGINES_JSON = JSON.stringify({
  pdf: { cmd: ['pdftotext', '{path}', '-'], as: 'text' },
  js: { cmd: ['prettier', '{path}'], as: 'code' },
  rst: { cmd: ['pandoc', '{path}', '-t', 'gfm'], as: 'markdown' },
  psd: { cmd: ['magick-psd', '{path}[0]', '{out}'], as: 'png' },
  bad: { cmd: ['failer', '{path}'], as: 'text' },
  slow: { cmd: ['sleeper', '{path}'], as: 'text' },
})

// A root with one file per custom engine; the fake commands answer each.
const customs = async ($: Engine, on: On, surface: 'terminal' | 'desktop' = 'terminal') => {
  const names = ['doc.pdf', 'app.js', 'guide.rst', 'art.psd', 'x.bad', 'y.slow']
  TREE[CUST] = names.map(name => entry(name, 'file', 4))
  TREE['/dev/shm'] = []
  for (const name of names) FILES[`${CUST}/${name}`] = 'data'
  const timeouts: (number | undefined)[] = []
  COMMANDS.pdftotext = (argv, timeoutMs) => (timeouts.push(timeoutMs), ran(0, `text of ${argv[1]}\npage 2\n`))
  COMMANDS.prettier = () => ran(0, 'const a = 1\n')
  COMMANDS.pandoc = () => ran(0, '# Guide\n\nbody\n')
  COMMANDS['magick-psd'] = argv => {
    const out = argv.at(-1)!
    FILES[out] = 'P'.repeat(300)
    BYTES[out] = PNG_200x100

    return ran(0)
  }
  COMMANDS.failer = () => ran(1, '', '\nfailer: Syntax Error: no pages\nmore\n')
  COMMANDS.sleeper = () => {
    throw new Error('process timed out after 10000 ms')
  }
  const calls: string[][] = []
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  mock.store(on)
  mock.clock(on)
  fake(on, calls, [], [], () => CUST)
  await $.session.start({ cwd: CUST, surface, isInteractive: true })
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface,
    component: 'Pane',
    props: PROPS,
    requestId: 'ide-explorer',
    viewport: VIEWPORT,
  })
  const ranOf = (tool: string) => calls.filter(argv => argv[0] === tool)

  return { ui, calls, toasts, timeouts, ranOf }
}

const engineOptions = { options: { previewEngines: ENGINES_JSON } }

test('custom engine as text: stdout in the plain code preview, run once per path + mtime, no edit or v', engineOptions, async ($, on) => {
  const { ui, ranOf, timeouts, toasts } = await customs($, on)
  await ui.press({ key: 'row:/cust/doc.pdf' })
  expect(ranOf('pdftotext')).toEqual([['pdftotext', '/cust/doc.pdf', '-']])
  expect(timeouts).toEqual([10000])
  const code = await ui.find({ type: 'Code' })
  expect(code?.text).toContain('text of /cust/doc.pdf')
  expect(code?.text).toContain('page 2')
  expect(code?.props.language).toBeUndefined()
  expect(await ui.find({ key: 'edit' })).toBeUndefined()
  expect(await ui.find({ key: 'preview:view' })).toBeUndefined()
  // drawn again (another file and back): the cache answers
  await ui.press({ key: 'row:/cust/app.js' })
  await ui.press({ key: 'row:/cust/doc.pdf' })
  expect(ranOf('pdftotext')).toHaveLength(1)
  // a good config toasts nothing
  expect(toasts.filter(text => text.includes('previewEngines'))).toEqual([])
})

test('custom engine as code: stdout highlighted by the file name', engineOptions, async ($, on) => {
  const { ui } = await customs($, on)
  await ui.press({ key: 'row:/cust/app.js' })
  const code = await ui.find({ type: 'Code' })
  expect(code?.text).toContain('const a = 1')
  expect(code?.props.language).toBe(languageOf('app.js'))
  expect(await ui.find({ key: 'edit' })).toBeUndefined()
})

test('custom engine as markdown: stdout rendered, no edit or v', engineOptions, async ($, on) => {
  const { ui } = await customs($, on)
  await ui.press({ key: 'row:/cust/guide.rst' })
  expect(await ui.find({ type: 'Code' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Guide' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^═+$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '# Guide' })).toBeUndefined()
  expect(await ui.find({ key: 'edit' })).toBeUndefined()
  expect(await ui.find({ key: 'preview:view' })).toBeUndefined()
})

test('terminal: custom engine as png: the PNG it wrote at {out} draws as an Image', engineOptions, async ($, on) => {
  const { ui, ranOf } = await customs($, on)
  const out = convertedPath('/dev/shm', '/cust/art.psd', MTIME)
  await ui.press({ key: 'row:/cust/art.psd' })
  expect(ranOf('magick-psd')).toEqual([['magick-psd', '/cust/art.psd[0]', out]])
  const image = await ui.find({ type: 'Image' })
  expect(image?.props.source).toEqual({ file: out, format: 'png', generation: MTIME })
  expect(await ui.find({ type: 'Text', text: /200×100 px · 4 B/ })).toBeDefined()
  expect(await ui.find({ key: 'preview:view' })).toBeUndefined()
})

test('desktop: custom engine as png: metadata and a note, the command not run', engineOptions, async ($, on) => {
  const { ui, ranOf } = await customs($, on, 'desktop')
  await ui.press({ key: 'row:/cust/art.psd' })
  expect(ranOf('magick-psd')).toEqual([])
  expect(await ui.find({ type: 'Text', text: 'image preview needs a kitty-graphics terminal' })).toBeDefined()
})

test('custom engine exiting non-zero: metadata and stderr first line', engineOptions, async ($, on) => {
  const { ui } = await customs($, on)
  await ui.press({ key: 'row:/cust/x.bad' })
  expect(await ui.find({ type: 'Code' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'x.bad' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'failer: failer: Syntax Error: no pages' })).toBeDefined()
})

// A test hook can't make the run reject with the engine's timeout (a throwing
// hook is skipped, the bottom hook rejects instead), so this covers the
// rejected path; runFailure (preview.test.ts) maps the timeout's message.
test('custom engine whose run rejects (timeout, missing binary): metadata and why', engineOptions, async ($, on) => {
  const { ui, ranOf } = await customs($, on)
  await ui.press({ key: 'row:/cust/y.slow' })
  expect(ranOf('sleeper')).toHaveLength(1)
  expect(await ui.find({ type: 'Code' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'y.slow' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^sleeper: \S/ })).toBeDefined()
})

test(
  'a bad previewEngines config toasts once per load; good entries still apply',
  { options: { previewEngines: '{"pdf":{"cmd":["pdftotext","{path}","-"],"as":"text"},"psd":{"cmd":[],"as":"png"}}' } },
  async ($, on) => {
    const { ui, toasts } = await customs($, on)
    await ui.press({ key: 'row:/cust/doc.pdf' })
    await ui.press({ key: 'row:/cust/art.psd' })
    await ui.press({ key: 'row:/cust/doc.pdf' })
    expect(toasts.filter(text => text.includes('previewEngines'))).toEqual([
      'previewEngines.psd: cmd must be a non-empty array of strings',
    ])
    expect((await ui.find({ type: 'Code' }))?.text).toContain('text of /cust/doc.pdf')
  },
)

test('custom engine as text: ANSI escapes and form feeds in stdout are cleaned, so Code draws it', engineOptions, async ($, on) => {
  const { ui } = await customs($, on)
  COMMANDS.pdftotext = () => ran(0, '\x1b[31mred\x1b[0m page 1\r\n\fpage 2\n')
  await ui.press({ key: 'row:/cust/doc.pdf' })
  const code = await ui.find({ type: 'Code' })
  expect(code?.props.source).toBe('red page 1\n page 2')
})

test('terminal: a Bash call keeps converted pictures (keyed by version); refresh converts again', async ($, on) => {
  const done = () => ({ result: {}, text: '' }) as never
  on('tool.call', done)
  const { ui, calls } = await images($, on, 'terminal', ['magick'])
  await ui.press({ key: 'row:/img/photo.jpg' })
  expect(converts(calls)).toHaveLength(1)
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await ui.press({ key: 'row:/img/pic.png' })
  await ui.press({ key: 'row:/img/photo.jpg' })
  expect(converts(calls)).toHaveLength(1)
  expect((await ui.find({ type: 'Image' }))?.props.source).toMatchObject({ file: convertedPath('/dev/shm', '/img/photo.jpg', MTIME) })
  // nothing removed: a cached markdown view may still draw it
  expect(calls.filter(argv => argv[0] === 'rm')).toEqual([])
  await ui.press({ key: 'refresh' })
  expect(converts(calls)).toHaveLength(2)
})

test('terminal: a changed picture is converted again, the older PNG kept until the session ends', async ($, on) => {
  on('session.end', () => ({ sessionId: 's' }))
  const { ui, calls } = await images($, on, 'terminal', ['magick'])
  await ui.press({ key: 'row:/img/photo.jpg' })
  const first = convertedPath('/dev/shm', '/img/photo.jpg', MTIME)
  MTIMES['/img/photo.jpg'] = MTIME + 5000
  await ui.press({ key: 'row:/img/pic.png' })
  await ui.press({ key: 'row:/img/photo.jpg' })
  const second = convertedPath('/dev/shm', '/img/photo.jpg', MTIME + 5000)
  expect(converts(calls).map(argv => argv.at(-1))).toEqual(['png:' + first, 'png:' + second])
  expect(calls.filter(argv => argv[0] === 'rm')).toEqual([])
  await $.session.end({ reason: 'other', sessionId: 's', resume: { id: 's' } })
  const rm = calls.find(argv => argv[0] === 'rm')
  expect(rm?.slice(0, 3)).toEqual(['rm', '-f', '--'])
  expect(new Set(rm?.slice(3))).toEqual(new Set([first, second]))
  delete MTIMES['/img/photo.jpg']
})

test('session.start sweeps day-old converted PNGs once per load', async ($, on) => {
  const { calls } = await images($, on, 'terminal', ['magick'])
  const sweep = [
    'find',
    '/dev/shm',
    HOME + '/.claude/ide-panes/previews',
    '-maxdepth',
    '1',
    '-name',
    'ide-panes-preview-*.png',
    '-mmin',
    '+1440',
    '-delete',
  ]
  expect(calls.filter(argv => argv[0] === 'find')).toEqual([sweep])
  await $.session.start({ cwd: IMG, surface: 'terminal', isInteractive: true })
  expect(calls.filter(argv => argv[0] === 'find')).toHaveLength(1)
})

test('terminal: a PNG past the read cap is sized from its header through od', async ($, on) => {
  COMMANDS.od = argv =>
    argv.at(-1) === '/img/pic.png' ? ran(0, ' 89 50 4e 47 0d 0a 1a 0a 00 00 00 0d 49 48 44 52\n 00 00 00 c8 00 00 00 64\n') : ran(1)
  try {
    const { ui, calls } = await images($, on, 'terminal', ['magick'])
    FILES['/img/pic.png'] = 'P'.repeat(5 * 1024 * 1024)
    delete BYTES['/img/pic.png']
    await ui.press({ key: 'row:/img/pic.png' })
    expect(calls).toContainEqual(['od', '-An', '-tx1', '-N24', '--', '/img/pic.png'])
    expect((await ui.find({ type: 'Image' }))?.props.source).toMatchObject({ file: '/img/pic.png' })
    expect(await ui.find({ type: 'Text', text: /^200×100 px · / })).toBeDefined()
    expect(converts(calls)).toEqual([])
  } finally {
    delete COMMANDS.od
  }
})

test('desktop: an Svg is no taller than the room under its info row', async ($, on) => {
  const { ui } = await images($, on, 'desktop', ['magick'])
  await ui.press({ key: 'row:/img/logo.svg' })
  // its own 32 px fits
  expect((await ui.find({ type: 'Svg' }))?.props.height).toBe(32)
  FILES['/img/tall.svg'] = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="4000"><rect width="40" height="4000"/></svg>'
  TREE[IMG] = [...TREE[IMG]!, entry('tall.svg', 'file', FILES['/img/tall.svg'].length)]
  await ui.press({ key: 'refresh' })
  await ui.press({ key: 'row:/img/tall.svg' })
  const height = (await ui.find({ type: 'Svg' }))?.props.height as number
  expect(height).toBeLessThan(4000)
  expect(height % 18).toBe(0)
})

test('terminal: new starts the new file rendered (previewRaw reset as on any selection change)', async ($, on) => {
  const { ui } = await images($, on, 'terminal', ['magick'])
  await ui.press({ key: 'row:/img/logo.svg' })
  await ui.press({ key: 'preview:view' })
  expect((await ui.find({ key: 'preview:view' }))?.props.label).toBe(' Rendered ')
  await ui.press({ key: 'new' })
  await ui.input({ key: 'new-file', text: 'x.svg' })
  expect(await ui.find({ key: 'editor' })).toBeDefined()
  // discarded unsaved: x.svg stays selected, never written, so metadata;
  // a kept previewRaw would still offer ` rendered ` over it
  await ui.press({ key: 'edit:close' })
  await ui.press({ key: 'ask:discard' })
  expect(await ui.find({ key: 'editor' })).toBeUndefined()
  expect(await ui.find({ key: 'preview:view' })).toBeUndefined()
})
// Last: the probe's answer holds for the rest of the load.
test('terminal: a blit probe answering with the alt draws metadata and a note instead', async ($, on) => {
  let blits = 0
  on('ui.blit', () => (blits++, { value: { deny: 'the Image draws its alt here: the terminal draws no placeholder images (env: inside tmux or screen)' } }))
  const { ui, clock } = await images($, on, 'terminal', ['magick'])
  await ui.press({ key: 'row:/img/pic.png' })
  expect(await ui.find({ type: 'Image' })).toBeDefined()
  await clock.advance(300)
  expect(blits).toBe(1)
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: "terminal can't draw images" })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /200×100 px/ })).toBeUndefined()
})


// ---------------------------------------------------------------- Markdown

const MD = '/md'
const filler = (word: string) => Array.from({ length: 20 }, (_, i) => `${word} ${i + 1}`).join('\n\n')
const README = [
  '# Title',
  '',
  'See [guide](docs/guide.md) and [jump](#details) and [site](https://example.com).',
  '',
  '| A | B |',
  '|---|---|',
  '| [x](https://t.example) | 2 |',
  '',
  filler('para'),
  '',
  '## Details',
  '',
  filler('more'),
  '',
].join('\n')
// Preview's rendered width at PROPS: 75 inner columns less the vertical bar.
const MD_WIDTH = 74
const MD_ROWS = 17 // Preview's rows at bodyRows 20
const readmeRows = () => layout(parse(README), MD_WIDTH)

const markdowns = async <S extends 'terminal' | 'desktop' | 'vscode'>(
  $: Engine,
  on: On,
  surface: S,
  readme = README,
  size: { bodyColumns: number; bodyRows: number } = { bodyColumns: PROPS.bodyColumns, bodyRows: PROPS.scroll.bodyRows },
  calls: string[][] = [],
) => {
  TREE[MD] = [entry('docs', 'dir'), entry('README.md', 'file', readme.length), entry('pic.png', 'file', 300)]
  TREE[MD + '/docs'] = [entry('guide.md', 'file', 20)]
  TREE['/dev/shm'] = []
  FILES[MD + '/README.md'] = readme
  FILES[MD + '/docs/guide.md'] = '# Guide\n\nbody\n'
  FILES[MD + '/pic.png'] = 'P'.repeat(300)
  BYTES[MD + '/pic.png'] = PNG_200x100
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.focus', () => ({}))
  mock.store(on)
  mock.clock(on)
  fake(on, calls, [], [], () => MD)
  await $.session.start({ cwd: MD, surface, isInteractive: true })
  const ui = (await $.ui.mount({
    plugin: PLUGIN,
    surface,
    component: 'Pane',
    props: { ...PROPS, bodyColumns: size.bodyColumns, scroll: { offset: 0, bodyRows: size.bodyRows } },
    requestId: 'ide-explorer',
    viewport: { columns: size.bodyColumns + 2, rows: size.bodyRows + 10 },
  })) as Mounted<S, 'Pane'>
  await ui.press({ key: 'row:/md/README.md' })

  return { ui, toasts }
}

// Rows are Texts with no key, so a row is told by its text: the rows whose
// text is not blank and appears once in the document (and holds no link: a
// Link's text there carries its href).
const uniqueRows = (rows: readonly MdRow[]): (string | undefined)[] => {
  const texts = rows.map(row => plainRow(row))

  const hasLink = (row: MdRow) => row.kind === 'text' && row.spans.some(span => span.style?.href !== undefined)

  return texts.map((text, i) =>
    text.trim() !== '' && texts.indexOf(text) === texts.lastIndexOf(text) && !hasLink(rows[i]!) ? text : undefined,
  )
}
// The indexes of the document's unique rows drawn now.
const shownRows = async (ui: { findAll: Mounted['findAll'] }, rows: readonly MdRow[]): Promise<number[]> => {
  const drawn = new Set((await ui.findAll({ type: 'Text' })).map(text => text.text))

  return uniqueRows(rows).flatMap((text, i) => (text !== undefined && drawn.has(text) ? [i] : []))
}
// The indexes of the unique rows in the window from `offset`.
const windowRows = (rows: readonly MdRow[], offset: number): number[] =>
  uniqueRows(rows).flatMap((text, i) => (text !== undefined && i >= offset && i < offset + MD_ROWS ? [i] : []))

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: a .md previews rendered: heading, rule, table borders, links`, async ($, on) => {
    const { ui } = await markdowns($, on, surface)
    const rows = readmeRows().rows
    expect(await ui.find({ type: 'Code' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Title' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '═'.repeat(MD_WIDTH) })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^┌─+┬─+┐$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^└─+┴─+┘$/ })).toBeDefined()
    // only the first page of rows is drawn
    expect(await shownRows(ui, rows)).toEqual(windowRows(rows, 0))
    // an https link outside a table is a Link; the table's is not
    expect((await ui.findAll({ type: 'Link' })).map(link => link.props.href)).toEqual(['https://example.com'])
    // the relative, #anchor and table links are pressable through Clients
    expect((await ui.find({ key: 'md:link:0' }))?.props.props).toMatchObject({ i: 0, segments: [{ text: 'guide' }] })
    expect((await ui.find({ key: 'md:link:1' }))?.props.props).toMatchObject({ segments: [{ text: 'jump' }] })
    expect((await ui.find({ key: 'md:link:2' }))?.props.props).toMatchObject({ segments: [{ text: 'x' }] })
    expect(await ui.find({ key: 'md:link:3' })).toBeUndefined()
    const drawnLink = (await ui.findAll({ type: 'Text', text: 'guide', in: 'md:link:0' })).find(text => text.text === 'guide' && text.props.underline !== undefined)
    expect(drawnLink?.props).toMatchObject({ underline: true, color: DARK.accent })
    // edit is the raw text; no horizontal bar for wrapped rows
    expect(await ui.find({ key: 'edit' })).toBeDefined()
    expect(await ui.find({ key: 'hb:preview' })).toBeUndefined()
  })

  test(`${surface}: rendered rows scroll by pages and the wheel; the total drives sb:preview`, async ($, on) => {
    const { ui } = await markdowns($, on, surface)
    const rows = readmeRows().rows
    expect((await ui.find({ key: 'sb:preview' }))?.props.props).toMatchObject({ total: rows.length, visible: MD_ROWS, offset: 0 })
    // a page key
    await scroll($, 'ide-explorer', 20)
    expect(await shownRows(ui, rows)).toEqual(windowRows(rows, MD_ROWS))
    expect((await ui.find({ key: 'sb:preview' }))?.props.props).toMatchObject({ offset: MD_ROWS })
    // the wheel over Preview moves by rows
    await scroll($, 'ide-explorer', 3, { column: 80, row: 3 })
    expect(await shownRows(ui, rows)).toEqual(windowRows(rows, MD_ROWS + 3))
    // the end clamps to the last page
    await scroll($, 'ide-explorer', 1000, { column: 80, row: 3 })
    expect(await shownRows(ui, rows)).toEqual(windowRows(rows, rows.length - MD_ROWS))
  })

  test(`${surface}: the view chip flips rendered markdown to its source as Code and back`, async ($, on) => {
    const { ui } = await markdowns($, on, surface)
    const view = await ui.find({ key: 'preview:view' })
    expect(view?.props.label).toBe(' Source ')
    await ui.press({ key: 'preview:view' })
    const code = await ui.find({ type: 'Code' })
    expect(code?.text).toContain('# Title')
    expect(code?.props.language).toBe(languageOf('README.md'))
    expect(await ui.find({ type: 'Text', text: 'Title' })).toBeUndefined()
    expect(await ui.find({ key: 'md:link:0' })).toBeUndefined()
    await ui.press({ key: 'preview:view' })
    expect(await ui.find({ type: 'Code' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Title' })).toBeDefined()
  })

  test(`${surface}: a relative link pressed selects the file it names`, async ($, on) => {
    const { ui } = await markdowns($, on, surface)
    await ui.pointer({ type: 'down', x: 1, y: 0, button: 'left', in: 'md:link:0' })
    await ui.pointer({ type: 'up', x: 1, y: 0, button: 'left', in: 'md:link:0' })
    expect(await ui.find({ key: 'row:/md/docs/guide.md' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Guide' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Title' })).toBeUndefined()
  })

  test(`${surface}: an #anchor link scrolls Preview to its heading; a table URL toasts; a stale press is ignored`, async ($, on) => {
    const { ui, toasts } = await markdowns($, on, surface)
    const L = readmeRows()
    const at = L.anchors.get('details')!
    expect(at).toBeGreaterThan(MD_ROWS)
    expect((await ui.find({ key: 'md:link:1' }))?.props.props).toMatchObject({ i: 1, path: '/md/README.md', offset: 0 })
    await ui.post({ link: 1, path: '/md/README.md', offset: 0 }, { in: 'md:link:1' })
    expect(await shownRows(ui, L.rows)).toEqual(windowRows(L.rows, at))
    expect((await ui.find({ key: 'sb:preview' }))?.props.props).toMatchObject({ offset: at })
    await scroll($, 'ide-explorer', -1000, { column: 80, row: 3 })
    // a press without the drawing's names, or naming another file, does nothing
    await ui.post({ link: 2 }, { in: 'md:link:2' })
    await ui.post({ link: 2, path: '/md/docs/guide.md', offset: 0 }, { in: 'md:link:2' })
    expect(toasts).not.toContain('Link: https://t.example')
    // nor one from the drawing before a scroll (its run i is another link now)
    await scroll($, 'ide-explorer', 1, { column: 80, row: 3 })
    expect((await ui.find({ key: 'md:link:2' }))?.props.props).toMatchObject({ offset: 1 })
    await ui.post({ link: 2, path: '/md/README.md', offset: 0 }, { in: 'md:link:2' })
    expect(toasts).not.toContain('Link: https://t.example')
    await ui.post({ link: 2, path: '/md/README.md', offset: 1 }, { in: 'md:link:2' })
    expect(toasts).toContain('Link: https://t.example')
  })
}

test('vscode: our renderer draws the rows; links underlined, no Clients', async ($, on) => {
  const { ui } = await markdowns($, on, 'vscode')
  expect(await ui.find({ type: 'Text', text: 'Title' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^┌─+┬─+┐$/ })).toBeDefined()
  expect(await ui.find({ key: 'md:link:0' })).toBeUndefined()
  const guide = (await ui.findAll({ type: 'Text', text: 'guide' })).find(text => text.text === 'guide')
  expect(guide?.props).toMatchObject({ underline: true, color: DARK.accent })
  expect((await ui.findAll({ type: 'Link' })).map(link => link.props.href)).toEqual(['https://example.com'])
})

const PICTURED = '![logo](pic.png)\n\n' + filler('para')

test('terminal: a local image in markdown draws as an Image over the rows it reserves', async ($, on) => {
  const { ui } = await markdowns($, on, 'terminal', PICTURED)
  const image = await ui.find({ type: 'Image' })
  expect(image?.props.key).toBe('md:image:0')
  expect(image?.props.source).toEqual({ file: '/md/pic.png', format: 'png', generation: MTIME })
  // 200x100 px fitted into 74 columns and at most 12 rows
  expect(image?.props.columns).toBe(48)
  expect(image?.props.rows).toBe(12)
  // the image row became 12: the total grows by 11 and the text starts after them
  const laid = layout(parse(PICTURED), MD_WIDTH).rows
  expect((await ui.find({ key: 'sb:preview' }))?.props.props).toMatchObject({ total: laid.length + 11 })
  expect(await ui.find({ type: 'Text', text: 'para 2' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'para 3' })).toBeUndefined()
  // scrolled into the picture: its placeholder row, the text below moves up
  await scroll($, 'ide-explorer', 2, { column: 80, row: 3 })
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '🖼 logo' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'para 3' })).toBeDefined()
})

test('desktop: a markdown image is its placeholder row', async ($, on) => {
  const { ui } = await markdowns($, on, 'desktop', PICTURED)
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '🖼 logo' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'para 8' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'para 9' })).toBeUndefined()
})

test('terminal: a wide code block in a tall Preview draws as several Codes, each under 10000 chars, one row per line', async ($, on) => {
  const body = Array.from({ length: 120 }, (_, i) => String(i % 10).repeat(180)).join('\n')
  const readme = '```\n' + body + '\n```\n'
  const { ui } = await markdowns($, on, 'terminal', readme, { bodyColumns: 300, bodyRows: 100 })
  const codes = await ui.findAll({ type: 'Code' })
  expect(codes.length).toBeGreaterThan(1)
  for (const code of codes) expect(String(code.props.source).length).toBeLessThan(10000)
  const rows = codes.reduce((sum, code) => sum + String(code.props.source).split('\n').length, 0)
  const shown = (await ui.find({ key: 'sb:preview' }))?.props.props as { total: number; visible: number }
  // the window's code rows, every one drawn once
  expect(rows).toBe(Math.min(shown.visible, 120))
})

test('terminal: a markdown image is converted only for a picture type, through its coder', async ($, on) => {
  TOOLS.clear()
  TOOLS.add('magick')
  FILES[MD + '/doc.pdf'] = '%PDF-1.4'
  FILES[MD + '/photo.jpg'] = 'J'.repeat(300)
  FILES[MD + '/evil.png.txt'] = 'push graphic-context'
  const calls: string[][] = []
  const readme = '![p](doc.pdf)\n\n![e](evil.png.txt)\n\n![j](photo.jpg)\n\n' + filler('para')
  const { ui } = await markdowns($, on, 'terminal', readme, undefined, calls)
  const magick = calls.filter(argv => argv[0] === 'magick' && argv[1] !== '-version')
  expect(magick).toEqual([
    ['magick', 'jpeg:/md/photo.jpg[0]', '-thumbnail', '2048x2048>', 'png:' + convertedPath('/dev/shm', '/md/photo.jpg', MTIME)],
  ])
  expect(await ui.find({ type: 'Text', text: '🖼 p' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '🖼 e' })).toBeDefined()
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: a binary .md is metadata, with no v`, async ($, on) => {
    const { ui } = await markdowns($, on, surface, '# x\0\0binary')
    expect(await ui.find({ type: 'Text', text: 'README.md' })).toBeDefined()
    expect(await ui.find({ key: 'preview:view' })).toBeUndefined()
  })
}

// ------------------------------------------------------------ Split layout

test('/ide-panels opens the split pane, a fifth of the window wide', async ($, on) => {
  settingsStore(on, [['settings', { autoOpen: false }]])
  const opened: unknown[] = []
  fake(on, [], opened)
  on('ui.panes', () => ({ value: [] as never }))
  await $.session.start(start('terminal'))
  const ran = await $.command.run({
    command: 'ide-panels',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 200 },
  })

  expect(ran.text).toContain('Explorer over Git')
  expect(opened).toEqual([{ id: 'ide-split', focus: true, columns: 40 }])
})

for (const surface of ['terminal', 'desktop'] as const) {
  // 41 body rows: the seam's one, then 28 (70%) for the Explorer, 12 for Git.
  const mountSplit = async ($: Engine, on: On, store = new Map<string, unknown>(), calls: string[][] = []) => {
    memoryStore(on, store)
    fake(on, calls, [], [], () => '/many3')
    on('ui.focus', () => ({}))
    on('ui.scroll', () => ({}))
    const names = Array.from({ length: 40 }, (_, i) => `s${String(i).padStart(2, '0')}.txt`)
    TREE['/many3'] = names.map(name => entry(name, 'file'))
    TOPLEVELS['/many3'] = '/many3'
    for (const name of names) FILES['/many3/' + name] = 'x\n'
    await $.session.start({ cwd: '/many3', surface, isInteractive: true })

    return $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'Pane',
      props: { ...PROPS, title: 'IDE', scroll: { offset: 0, bodyRows: 41 } },
      requestId: 'ide-split',
      viewport: VIEWPORT,
    })
  }
  const firstRow = async (ui: Pane) =>
    (await ui.findAll({ type: 'Button' })).map(b => b.key ?? '').find(key => key.startsWith('row:'))

  test(`${surface}: the split pane draws the Explorer over Git, 70/30, Git's keys prefixed`, async ($, on) => {
    const ui = await mountSplit($, on)

    expect((await ui.find({ key: 'split:explorer' }))?.props.height).toBe(28)
    expect((await ui.find({ key: 'split:git' }))?.props.height).toBe(12)
    expect(await ui.find({ key: 'split:panels' })).toBeDefined()
    expect(await ui.find({ key: 'tab:files' })).toBeDefined()
    expect(await ui.find({ key: 'refresh' })).toBeDefined()
    expect(await ui.find({ key: 'git/fetch' })).toBeDefined()
    // the root, branch and counts: only Git's footer
    expect(await ui.find({ key: 'git/footer:counts' })).toBeDefined()
    expect(await ui.find({ key: 'footer:counts' })).toBeUndefined()
    // one ⚙, the Explorer's
    expect(await ui.find({ key: 'settings' })).toBeDefined()
    expect(await ui.find({ key: 'git/settings' })).toBeUndefined()
    // no Button key drawn twice
    const keys = (await ui.findAll({ type: 'Button' })).map(b => b.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  test(`${surface}: a press in Git's half runs Git's handler`, async ($, on) => {
    const ui = await mountSplit($, on)
    const isActive = async (id: string) =>
      surface === 'terminal'
        ? (await ui.find({ key: 'git/tab:' + id + ':chrome' }))?.props.backgroundColor === onDefaultFg(DARK.accent)
        : (await ui.find({ key: 'git/tab:' + id }))?.props.variant === 'primary'
    expect(await isActive('overview')).toBe(true)
    await ui.press({ key: 'git/tab:graph' })
    expect(await isActive('graph')).toBe(true)
    expect(await isActive('overview')).toBe(false)
  })

  test(`${surface}: dragging the split pane's seam resizes both halves; the release saves it`, async ($, on) => {
    const store = new Map<string, unknown>()
    const ui = await mountSplit($, on, store)
    await ui.pointer({ type: 'down', button: 'left', x: 5, y: 0, in: 'split:panels' })
    await ui.pointer({ type: 'move', button: 'left', x: 5, y: 4, in: 'split:panels' })
    expect((await ui.find({ key: 'split:explorer' }))?.props.height).toBe(32)
    expect(store.has('layout:explorer')).toBe(false)
    await ui.pointer({ type: 'up', button: 'left', x: 5, y: 0, in: 'split:panels' })
    // Git keeps its 8-row minimum
    expect((await ui.find({ key: 'split:git' }))?.props.height).toBe(8)
    expect((store.get('layout:explorer') as { panels?: number }).panels).toBe(0.8)
  })

  test(`${surface}: the wheel above the seam scrolls the Explorer, below it not`, async ($, on) => {
    const ui = await mountSplit($, on)
    const top = await firstRow(ui)
    // over Git's half (row 29 is its first)
    await scroll($, 'ide-split', 3, { column: 10, row: 33 })
    expect(await firstRow(ui)).toBe(top)
    // over the tree
    await scroll($, 'ide-split', 3, { column: 10, row: 6 })
    expect(await firstRow(ui)).not.toBe(top)
  })


}

// ------------------------------------------------------------ Repo or none

for (const surface of ['terminal', 'desktop'] as const) {
  // The split pane (41 body rows) at `root`, a dir of one file.
  const mountSplitAt = async ($: Engine, on: On, root: string, store = new Map<string, unknown>()) => {
    memoryStore(on, store)
    const clock = mock.clock(on)
    fake(on, [], [], [], () => root)
    on('ui.focus', () => ({}))
    on('ui.scroll', () => ({}))
    TREE[root] = [entry('a.txt', 'file')]
    FILES[root + '/a.txt'] = 'x\n'
    await $.session.start({ cwd: root, surface, isInteractive: true })

    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'Pane',
      props: { ...PROPS, title: 'IDE', scroll: { offset: 0, bodyRows: 41 } },
      requestId: 'ide-split',
      viewport: VIEWPORT,
    })

    return { ui, clock }
  }

  test(`${surface}: before the first commit Git's footer still names the branch and counts`, async ($, on) => {
    UNBORN.add('/unborn')
    TOPLEVELS['/unborn'] = '/unborn'
    const { ui } = await mountSplitAt($, on, '/unborn')
    expect(await ui.find({ type: 'Text', text: 'trunk' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '+1' })).toBeDefined()
    // a repo: Git keeps its 30%
    expect((await ui.find({ key: 'split:git' }))?.props.height).toBe(12)
  })

  test(`${surface}: outside a repo Git's half keeps 2 rows, the Explorer the rest, no seam to drag`, async ($, on) => {
    NOT_REPOS.add('/norepo')
    const { ui } = await mountSplitAt($, on, '/norepo')
    expect((await ui.find({ key: 'split:explorer' }))?.props.height).toBe(38)
    expect((await ui.find({ key: 'split:git' }))?.props.height).toBe(2)
    expect(await ui.find({ key: 'split:panels' })).toBeUndefined()
    // a plain rule instead
    expect(await ui.find({ type: 'Text', text: '─'.repeat(PROPS.bodyColumns) })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Not a git repository' })).toBeDefined()
  })

  test(`${surface}: a repo appearing redraws both panels, Git's half back at 30% over a dragged size`, async ($, on) => {
    const root = '/later-' + surface
    NOT_REPOS.add(root)
    on('ui.panes', () => ({ value: [{ id: 'ide-split', isFocused: true }] as never }))
    const { ui, clock } = await mountSplitAt($, on, root, new Map<string, unknown>([['layout:explorer', { panels: 0.5 }]]))
    expect((await ui.find({ key: 'split:git' }))?.props.height).toBe(2)
    // still none on the first look
    await clock.advance(2000)
    expect((await ui.find({ key: 'split:git' }))?.props.height).toBe(2)

    // `git init`
    NOT_REPOS.delete(root)
    TOPLEVELS[root] = root
    await clock.advance(2000)
    await clock.advance(10)
    expect((await ui.find({ key: 'split:git' }))?.props.height).toBe(12)
    expect((await ui.find({ key: 'split:explorer' }))?.props.height).toBe(28)
    expect(await ui.find({ key: 'split:panels' })).toBeDefined()
    // Git's half draws the repo, its footer too
    expect(await ui.find({ type: 'Text', text: 'Not a git repository' })).toBeUndefined()
    expect(await ui.find({ key: 'git/footer:counts' })).toBeDefined()
  })
}

// ------------------------------------------------------------ One window

// The panes the engine holds open: `ui.panes` lists them, `ui.close` drops one.
const panesFake = (on: On, initial: string[]) => {
  const open = new Set(initial)
  const closed: string[] = []
  on('ui.panes', () => ({ value: [...open].map(id => ({ id, isFocused: true })) as never }))
  on('ui.close', (_$, e) => {
    closed.push(e.id)
    open.delete(e.id)

    return { value: undefined }
  })

  return { open, closed }
}
const runPanels = ($: Engine) =>
  $.command.run({ command: 'ide-panels', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })
const SPLIT_OPENED = [{ id: 'ide-split', focus: true, columns: 40 }]

test('/ide-panels with the split pane open only raises it', async ($, on) => {
  settingsStore(on)
  const opened: unknown[] = []
  fake(on, [], opened)
  const panes = panesFake(on, ['ide-split'])
  await $.session.start(start('terminal'))
  await runPanels($)
  expect(panes.closed).toEqual([])
  expect(opened).toEqual(SPLIT_OPENED)
})

// Another plugin that closes the split pane.
const splitCloser = {
  name: 'split-closer',
  register: (on: On) => {
    on('command.run', { command: 'close-split' }, async $ => {
      await $.ui.close({ id: 'ide-split' })

      return { text: '' }
    })
  },
}
for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: closing the split pane over unsaved text puts up the bar instead`, { plugins: [splitCloser] }, async ($, on) => {
    const panes = panesFake(on, ['ide-split'])
    const { ui, settle } = await editing($, on, surface, '/ed-split', { 'a.ts': 'one\n' })
    await ui.key({ key: 'x', in: 'editor' })
    await settle()
    await $.command.run({ command: 'close-split', args: '', origin: { kind: 'composer' }, presentation: PRESENTATION })
    expect(panes.closed).toEqual([])
    expect(await ui.find({ key: 'ask:save' })).toBeDefined()
  })
}

// ------------------------------------------------------------ Session's own opening

test('a new session opens the split pane by itself, leaving the keyboard, at the width /ide-panels saw', async ($, on) => {
  settingsStore(on, [['window:columns', 200]])
  const opened: unknown[] = []
  fake(on, [], opened)
  panesFake(on, [])
  await $.session.start(start('terminal'))
  expect(opened).toEqual([{ id: 'ide-split', focus: undefined, columns: 40 }])
})

test('with no width seen yet it asks for the dock\'s own share', async ($, on) => {
  settingsStore(on)
  const opened: unknown[] = []
  fake(on, [], opened)
  panesFake(on, [])
  await $.session.start(start('terminal'))
  expect(opened).toEqual([{ id: 'ide-split', focus: undefined, columns: undefined }])
})

for (const [name, entries, isInteractive, initial] of [
  ['with autoOpen off', [['settings', { autoOpen: false }]], true, []],
  ['for a -p run', [], false, []],
  ['while a pane of ours is open already', [], true, ['ide-split']],
] as const) {
  test(`a new session opens nothing ${name}`, async ($, on) => {
    settingsStore(on, entries.map(([k, v]) => [k, v] as [string, unknown]))
    const opened: unknown[] = []
    fake(on, [], opened)
    panesFake(on, [...initial])
    await $.session.start({ ...start('terminal'), isInteractive })
    expect(opened).toEqual([])
  })
}

test('a reload (session.start again, the same session) opens nothing more', async ($, on) => {
  settingsStore(on)
  const opened: unknown[] = []
  fake(on, [], opened)
  panesFake(on, [])
  await $.session.start(start('terminal'))
  await $.session.start(start('terminal'))
  expect(opened).toHaveLength(1)
})

test('/ide-panels keeps the window width for the next session', async ($, on) => {
  const store = settingsStore(on)
  fake(on)
  panesFake(on, ['ide-split'])
  await $.session.start(start('terminal'))
  await runPanels($)
  expect(store.get('window:columns')).toBe(200)
})

for (const reason of ['prompt_input_exit', 'logout', 'other', 'clear', 'resume'] as const) {
  const isExit = reason !== 'clear' && reason !== 'resume'
  test(`a session ending by ${reason} ${isExit ? 'closes' : 'leaves'} the panels`, async ($, on) => {
    settingsStore(on)
    fake(on)
    const panes = panesFake(on, ['ide-split'])
    on('session.end', () => ({ sessionId: 's1' }))
    await $.session.start(start('terminal'))
    await $.session.end({ reason, sessionId: 's1', resume: { id: 's1' } })
    expect(panes.closed).toEqual(isExit ? ['ide-split'] : [])
  })
}

test('with autoOpen off an exit leaves the panels', async ($, on) => {
  settingsStore(on, [['settings', { autoOpen: false }]])
  fake(on)
  const panes = panesFake(on, ['ide-split'])
  on('session.end', () => ({ sessionId: 's1' }))
  await $.session.start(start('terminal'))
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })
  expect(panes.closed).toEqual([])
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: the Session switch turns autoOpen off; done saves it`, async ($, on) => {
    const store = settingsStore(on)
    fake(on)
    panesFake(on, ['ide-split'])
    on('ui.focus', () => ({}))
    await $.session.start(start(surface))
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', props: PROPS, requestId: 'ide-explorer', viewport: VIEWPORT })
    await ui.press({ key: 'settings' })
    await ui.press({ key: 'settings:autoOpen' })
    await ui.press({ key: 'settings:done' })
    expect((store.get('settings') as { autoOpen?: boolean }).autoOpen).toBe(false)
  })
}

// ------------------------------------------------------------ Theme sources

const TABBY_YAML = (name: string, bg: string, fg = '#efefef') =>
  [
    'terminal:',
    '  colorScheme:',
    `    name: ${name}`,
    `    foreground: '${fg}'`,
    `    background: '${bg}'`,
    "    cursor: '#bbbbbb'",
    '    colors:',
    ...['#242424', '#d71c15', '#5aa513', '#fdb40c', '#063b8c', '#e40038', '#2595e1', '#efefef',
      '#4b4b4b', '#fc1c18', '#6bc219', '#fec80e', '#0955ff', '#fb0050', '#3ea8fc', '#8c00ec'].map(c => `      - '${c}'`),
  ].join('\n')
// The terminal's variables as the fake answers them (`vars`; the rest unset).
const envOf = (vars: Record<string, string>) => {
  for (const name of ['TERM_PROGRAM', 'TABBY_CONFIG_DIRECTORY']) ENV[name] = vars[name]
}
const pageBg = async (ui: Pane) => (await ui.findAll({ type: 'Box' })).find(box => box.props.minHeight === PROPS.scroll.bodyRows)?.props.backgroundColor

for (const surface of ['terminal', 'desktop'] as const) {
  const mountWith = async ($: Engine, on: On, settingsValue: Record<string, unknown>) => {
    const clock = mock.clock(on)
    settingsStore(on, [['settings', settingsValue]])
    fake(on)
    on('ui.panes', () => ({ value: [{ id: 'ide-explorer', isFocused: true }] as never }))
    on('ui.focus', () => ({}))
    await $.session.start(start(surface))
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', props: PROPS, requestId: 'ide-explorer', viewport: VIEWPORT })

    return { ui, clock }
  }

  test(`${surface}: in Tabby the theme paints Tabby's background and follows a change of it`, async ($, on) => {
    envOf({ TERM_PROGRAM: 'Tabby', TABBY_CONFIG_DIRECTORY: '/tabby-cfg' })
    FILES['/tabby-cfg/config.yaml'] = TABBY_YAML('Elementary', '#181818')
    MTIMES['/tabby-cfg/config.yaml'] = 1
    const { ui, clock } = await mountWith($, on, {})
    expect(await pageBg(ui)).toBe('#181818')

    // Tabby saves another scheme: the panel follows without a press
    FILES['/tabby-cfg/config.yaml'] = TABBY_YAML('Paper', '#fafafa', '#202020')
    MTIMES['/tabby-cfg/config.yaml'] = 2
    await clock.advance(2000)
    expect(await pageBg(ui)).toBe('#fafafa')
  })

  test(`${surface}: outside Tabby the background is left to the terminal`, async ($, on) => {
    envOf({ TERM_PROGRAM: 'iTerm.app' })
    const { ui } = await mountWith($, on, {})
    expect(await pageBg(ui)).toBeUndefined()
  })

  test(`${surface}: the theme follows /config, its background left to the terminal`, async ($, on) => {
    envOf({})
    on('config.list', () => ({ value: [{ key: 'theme', value: 'light' }] as never }))
    on('config.set', (_$, e) => ({ value: e.value }))
    const { ui } = await mountWith($, on, {})
    expect(await pageBg(ui)).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: ' Explorer' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: ' Explorer' }))?.props.color).toBe('#000000')

    // /theme picks dark: the panel follows
    await $.config.set({ key: 'theme', value: 'dark' } as never)
    expect((await ui.find({ type: 'Text', text: ' Explorer' }))?.props.color).toBe('#ffffff')
  })

  test(`${surface}: Settings has no Theme choice`, async ($, on) => {
    envOf({})
    const { ui } = await mountWith($, on, {})
    await ui.press({ key: 'settings' })
    expect(await ui.find({ key: 'settings:accent' })).toBeDefined()
    expect(await ui.find({ key: 'settings:theme:claude-code' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Theme' })).toBeUndefined()
  })
}
