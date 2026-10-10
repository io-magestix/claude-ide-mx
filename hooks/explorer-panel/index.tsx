import { atom, read, update } from 'claude-code'
import type { EngineInterface, PaneOpenArgs, PluginOptions, Register, RenderChildren } from 'claude-code'

import type { ExplorerState, GitState, SettingsState, SettingsUi } from '../../types'
import { TRANSFER_CHUNK, accept, draftFile, editorColors, parseChunk, parseHView } from './edit'
import type { EditorProps, HView, Incoming } from './edit'
import { KEYMAPS, chunks } from './editor'
import type { Action, Keymap } from './editor'
import {
  MAX_PREVIEW_BYTES,
  clip,
  dirsAbove,
  fitLabel,
  flatten,
  formatSize,
  isBinary,
  join,
  languageOf,
  parentOf,
  relativePath,
  window as windowOf,
  changeMarks,
  changedEntries,
  changedMarks,
  markOf,
} from './tree'
import type { ChangeMarks, Entry, Mode, Row } from './tree'
import { iconChoice, iconOf, iconsFor } from './icons'
import {
  convertArgv,
  CELL_H,
  CELL_W,
  convertedPath,
  engineArgv,
  engineOf,
  firstLine,
  fitCells,
  hasSourceView,
  imageInfo,
  parseEngines,
  runFailure,
  pngSize,
  pngSizeFromHex,
  cleanOutput,
  cleanText,
  codeChunks,
  isPictureFile,
  SVG_ROW_PX,
  svgSize,
} from './preview'
import type { ConvertTool, CustomEngine } from './preview'
import { parse as parseMarkdown } from './markdown/parse'
import type { ParseResult } from './markdown/parse'
import { MIN_WIDTH, layout as layoutMarkdown } from './markdown/layout'
import type { MdRow, Role, Span } from './markdown/rows'
import { spansWidth } from './markdown/wrap'
import { anchorRow, expandPictures, isLinkable, linkHits, linkTarget, localPath } from './markdown/view'
import type { LinkHit, MdView, Picture, ViewRow } from './markdown/view'
import { headNameArgv, parseStatus, statusArgv } from '../git-panel/git'
import { lastAgentColor, parseColorAnswer } from '../shared/color'
import { H_THUMB, H_TRACK, THUMB, clamp, scrollbar } from '../shared/scrollbar'
import { sliceCols, widest } from '../shared/hscroll'
import { dragTo, layoutOf, splitAt } from '../shared/split'
import { MIN_HALF_ROWS, SPLIT_PANE, SPLIT_TITLE, WINDOW_KEY, gitKeyOf, seat, splitColumns, splitRows } from '../shared/layout'
import { DEFAULTS, SETTINGS_KEY, keymapNameOf, keysError, mergeKeys, resolveTheme, settingsOf } from '../shared/settings'
import { PaneButtons, SettingsSheet } from '../shared/settings-sheet'
import { THEME_POLL_MS, parseTabbyFonts, parseTabbyScheme, resetThemeEnv, tabbyConfigPaths, themeEnv } from '../shared/term-theme'
import type { Theme } from '../shared/theme'
import { Btn, Tabs, onDefaultFg } from '../shared/ui'
import {
  classify,
  hasRefs,
  isIndexCommand,
  metaGuid,
  parseGrep,
  refsOf,
} from './unity'
import type { GuidIndex, Ref } from './unity'

type On = Parameters<Register>[0]

// The `/color` of this session; the explorer's hooks keep it current.
const sessionColor = atom<'ide-panes', 'sessionColor'>(
  { plugin: 'ide-panes', key: 'sessionColor' } as const,
  '',
)
// The Settings values (accent, keymap, panel defaults, session); $.store `settings` seeds it.
const settings = atom<'ide-panes', 'settings'>(
  { plugin: 'ide-panes', key: 'settings' } as const,
  {} satisfies SettingsState,
)
// The Settings sheet while it is up (which pane draws it, the values to put
// back on cancel, the keys field as typed); session only.
const settingsUi = atom<'ide-panes', 'settingsUi'>(
  { plugin: 'ide-panes', key: 'settingsUi' } as const,
  {} satisfies SettingsUi,
)
const PANE = 'ide-explorer'

// Where the Explorer is drawn: the split pane's top half, or its own pane
// (which nothing opens now but the tests). Set by each drawing; a reload draws
// again before any press.
let host: typeof PANE | typeof SPLIT_PANE = PANE
// The split pane's half the keyboard was last in: the scroll keys go there.
let splitFocus: 'explorer' | 'git' = 'explorer'

const paneIsOpen = async ($: EngineInterface, ...ids: string[]): Promise<boolean> =>
  (await $.ui.panes()).some(pane => ids.includes(pane.id))

// The `$.ui.open` arguments of the pane the Explorer is drawn in: the split
// pane asks for its share of the window (docked; the person's own drag of the
// dock wins), or the dock's own share while no width is known.
const openArgs = (id: string): PaneOpenArgs =>
  id === SPLIT_PANE
    ? { id, title: SPLIT_TITLE, ...(seat.windowColumns > 0 ? { columns: splitColumns(seat.windowColumns) } : {}) }
    : { id, title: 'Explorer' }

// Opens the split pane (an open one is only raised). Without `focus` the
// keyboard stays where it is (a session's own opening).
const openPanels = async ($: EngineInterface, focus = true): Promise<void> => {
  await $.ui.open(focus ? { ...openArgs(SPLIT_PANE), focus: true } : openArgs(SPLIT_PANE))
}
// Settings `autoOpen` (on by default). A new interactive session opens the
// split pane, unless a pane is open already, leaving the keyboard with the
// prompt; the width is the window `/ide-panels` last measured. An
// opening the session made unasked waits undrawn on a narrow terminal (the
// engine's floor) until it widens or `/ide-panels` runs.
const openOnStart = async ($: EngineInterface): Promise<void> => {
  const now = await read($, settings)
  if (!(now.autoOpen ?? DEFAULTS.autoOpen)) return
  try {
    const width = await $.store.get(WINDOW_KEY)
    if (seat.windowColumns === 0 && typeof width === 'number' && width > 0) seat.windowColumns = width
    if ((await $.ui.panes()).length > 0) return
    await openPanels($, false)
  } catch {
    // nothing to open panes on
  }
}

// The session's exit (/exit, ctrl+c, ctrl+d, logout, a signal; not a /clear or
// a resume, which go on) closes the split pane when `autoOpen` is on.
const EXIT_REASONS: readonly string[] = ['prompt_input_exit', 'logout', 'other']
const closeOnExit = async ($: EngineInterface, reason: string): Promise<void> => {
  if (!EXIT_REASONS.includes(reason) || !((await read($, settings)).autoOpen ?? DEFAULTS.autoOpen)) return
  try {
    if (await paneIsOpen($, SPLIT_PANE)) await $.ui.close({ id: SPLIT_PANE })
  } catch {
    // no panes to ask about
  }
}

const MODES: readonly Mode[] = ['files', 'unity']

const explorer = atom<'ide-panes', 'explorer'>(
  { plugin: 'ide-panes', key: 'explorer' } as const,
  { root: '', mode: 'files', expanded: [], offset: 0, previewOffset: 0 } satisfies ExplorerState,
)

// Listings and git-ignore results are cached here, not in $.state: they are
// cheap to rebuild (render re-lists every expanded dir after a reload) and
// $.state should stay small. The tool.call hooks and the disk watch
// invalidate them.
const listings = new Map<string, Entry[]>()
// Each listed dir's mtime when it was listed (undefined: no stat), for the
// disk watch.
const dirStamps = new Map<string, number | undefined>()
const ignored = new Set<string>()
// Whether a root holds `ProjectSettings/ProjectVersion.txt`; checked in Unity
// mode only.
const unityRoots = new Map<string, boolean>()
// The branch and the tree's change marks per root; undefined `branch`: not a
// repo. Cleared with the listings.
const footers = new Map<string, { branch?: string; marks: ChangeMarks }>()
// Rows the tree window shows; set by render, read by the focus hook.
let treeRows = 20
// Each side of the splitter keeps at least this many columns.
const MIN_COLS = 12
// The last drawing's geometry, set by render and read by the scroll hook: the
// column where the preview starts, each section's furthest offset and the
// rows the preview shows; the Edit region and whether it was drawn (read by
// the scroll and editor message hooks too).
const view = {
  columns: 0, // the total the splitter divides: the body's columns
  treeEnd: 0,
  treeMax: 0,
  previewMax: 0,
  previewLeftMax: 0, // the preview's furthest first column (horizontal bar)
  previewRows: 1,
  editRows: 1,
  editColumns: 1,
  isEditDrawn: false,
  splitRoom: 0, // the split pane: its rows less the seam's, which the seam divides
}

type Edit = NonNullable<ExplorerState['edit']>

// The Edit section's side of the editor client's protocol (editor-client.tsx).
// Module-level: a reload bumps `edit.version` (session.start), so the client
// asks for the text again and nothing here has to survive one.
const editing = {
  version: -1, // the `edit.version` the parts below were read for
  parts: [] as string[], // the text in chunks; emptied once all were delivered
  total: 0,
  index: -1, // the chunk in the props; `total`: all delivered
  isDraft: false,
  ack: '', // id of the client's last message taken
  saved: 0, // seq of the last save written
  isDirty: false, // as the client last said
  command: '',
  commandSeq: 0,
  by: 0,
  incoming: undefined as Incoming | undefined,
  hview: undefined as HView | undefined, // the client's horizontal view, for the bar
}
// The merged keymap (register's options, then the Settings keys) and what was wrong with the overrides.
let keymap: Keymap = KEYMAPS.jetbrains
let keymapErrors: string[] = []
// register's options (userConfig): the keymap is merged again over each
// drawing's Settings, so a change from either panel's sheet reaches the editor.
let pluginOptions: PluginOptions | undefined
// Columns of the widest line of the last previewed file, keyed by path, mtime
// and line count: the horizontal bar measures every line, not just the shown
// ones (its thumb must not jump on a vertical scroll), and a 4 MiB file is too
// many to walk on each drawing. One entry: only the shown file is measured.
let widthCache: { key: string; cols: number } | undefined

// The Edit section bar's total columns: the widest line plus the caret cell
// past its end, which the client's follow logic scrolls to (End on that line).
const editTotal = (hview: HView): number => hview.widest + 1

// Columns of the widest of `lines`, through `widthCache`.
const widestCached = (key: string, lines: readonly string[]): number => {
  if (widthCache?.key !== key) widthCache = { key, cols: widest(lines) }

  return widthCache.cols
}

const isMode = (value: unknown): value is Mode =>
  MODES.includes(value as Mode)

// What the theme draws from: Claude Code's `/config` theme (read once, then
// kept current by the `config.set` hook; `force` reads it again) and the
// terminal's scheme from Tabby's config.yaml, looked at again at most every
// THEME_POLL_MS and read again when it changed. The cache is shared with Git
// (term-theme.ts `themeEnv`).
const explorerThemeEnv = async ($: EngineInterface, force = false): Promise<void> => {
  const env = themeEnv
  try {
    if (env.configPaths === undefined) {
      env.configPaths = tabbyConfigPaths(
        await $.env.get('TERM_PROGRAM'),
        await $.env.get('TABBY_CONFIG_DIRECTORY'),
        await $.env.get('HOME'),
      )
    }
    if (env.configPaths.length > 0 && (force || Date.now() - env.checkedAt >= THEME_POLL_MS)) {
      env.checkedAt = Date.now()
      for (const path of env.configPaths) {
        const stat = await statOf($, path)
        if (stat === undefined) continue
        if (stat.mtimeMs !== env.mtime) {
          const text = await $.fs.read(path)
          env.scheme = parseTabbyScheme(text)
          env.fonts = parseTabbyFonts(text)
          env.mtime = stat.mtimeMs
        }
        break
      }
    }
    if (force || env.ccTheme === undefined) {
      const row = (await $.config.list()).find(r => r.key === 'theme')
      env.ccTheme = typeof row?.value === 'string' ? row.value : 'dark'
    }
  } catch {
    // not readable now: the theme draws from what is known (else as `dark`)
  }
}

// While a panel is up, the theme's sources are looked at every
// THEME_POLL_MS: a Tabby scheme or a `/theme` changed redraws both.
let themeWatch: { cancel: () => void } | undefined
const watchTheme = ($: EngineInterface): void => {
  if (themeWatch !== undefined) return
  try {
    themeWatch = $.clock.after(THEME_POLL_MS, async () => {
      themeWatch = undefined
      try {
        if (!(await paneIsOpen($, PANE, SPLIT_PANE))) return
        const before = [themeEnv.mtime, themeEnv.ccTheme].join('\0')
        await explorerThemeEnv($, true)
        if ([themeEnv.mtime, themeEnv.ccTheme].join('\0') !== before) $.ui.invalidate('ui.render')
        watchTheme($)
      } catch {
        // no surface to ask: the next drawing watches again
      }
    })
  } catch {
    // no clock here
  }
}

// Claude Code's theme, its accent taken from the `/color` session color while
// one is set (and `accentFromSession` is on, the default); that accent frames
// the sections too (`accentBorder`), as git's.
const themeNow = async ($: EngineInterface): Promise<{ t: Theme; accentBorder: boolean }> => {
  const now = await read($, settings)
  const color = await read($, sessionColor)
  await explorerThemeEnv($)

  return { t: resolveTheme(now, color, themeEnv), accentBorder: color !== '' && (now.accentFromSession ?? true) }
}

// The session's `/color` as the transcript last recorded it (`agent-color`
// entries); nothing recorded leaves the current value.
const syncColor = async ($: EngineInterface): Promise<void> => {
  try {
    const id = await $.session.id()
    const ran = await $.process.run(
      ['sh', '-c', 'grep -h \'"agentColor"\' "$HOME"/.claude/projects/*/"$1".jsonl', 'sh', id],
      { timeoutMs: 5000 },
    )
    const name = lastAgentColor(ran.stdout)
    if (name !== undefined) await update($, sessionColor, () => name)
  } catch {
    // no transcript yet
  }
}

// Calls of gitOut that threw (a drawing superseded mid-call aborts its
// `$.process.run`): such an answer says nothing, so it is not cached.
let gitThrew = 0

// Read-only git call in `cwd`; undefined on a non-zero exit or any failure.
const gitOut = async (
  $: EngineInterface,
  cwd: string,
  argv: string[],
): Promise<string | undefined> => {
  try {
    // Read-only: a status refreshing the index takes no lock from the person's
    // own git commands (the disk watch runs one every 2 s).
    const ran = await $.process.run(argv, { cwd, env: { GIT_OPTIONAL_LOCKS: '0' }, timeoutMs: 15000 })

    return ran.exitCode === 0 ? ran.stdout : undefined
  } catch {
    gitThrew += 1

    return undefined
  }
}

// The branch (a short sha when detached) and the working tree's change marks
// (`+` added, `*` edited) for the tree; no branch outside a repo.
const footerOf = async ($: EngineInterface, root: string) => {
  let footer = footers.get(root)
  if (footer === undefined) {
    const before = gitThrew
    let branch = (await gitOut($, root, ['git', 'rev-parse', '--abbrev-ref', 'HEAD']))?.trim()
    if (branch === 'HEAD') {
      branch = (await gitOut($, root, ['git', 'rev-parse', '--short', 'HEAD']))?.trim()
    } else if (branch === undefined) {
      // A repo before its first commit still names its branch.
      branch = (await gitOut($, root, headNameArgv()))?.trim()
    }
    const status = branch === undefined ? undefined : await gitOut($, root, statusArgv('normal'))
    footer = {
      branch: branch === '' ? undefined : branch,
      marks: changeMarks(parseStatus(status ?? ''), status === undefined ? root : await toplevelOf($, root)),
    }
    // An aborted call (a superseded drawing) left it blank: the next asks again.
    if (gitThrew === before) footers.set(root, footer)
  }

  return footer
}

// Roots drawn outside a repo, and the timer looking for one to appear there
// (`git init` or a clone, by Claude or by hand) while a panel is up.
const repoLess = new Set<string>()
let repoWatch: { cancel: () => void } | undefined
const REPO_POLL_MS = 2000

const watchRepo = ($: EngineInterface, root: string): void => {
  repoLess.add(root)
  if (repoWatch !== undefined) return
  try {
    repoWatch = $.clock.after(REPO_POLL_MS, async () => {
      repoWatch = undefined
      try {
        // Both panes closed: the next drawing watches again.
        if (!(await paneIsOpen($, PANE, SPLIT_PANE))) return
        if ((await gitOut($, root, ['git', '-C', root, 'rev-parse', '--show-toplevel'])) === undefined) {
          watchRepo($, root)

          return
        }
        // Found: the footer asks again, and both panels redraw (Git does not
        // cache "not a repo").
        footers.delete(root)
        toplevels.clear()
        $.ui.invalidate('ui.render')
      } catch {
        // no surface to ask: the next drawing watches again
      }
    })
  } catch {
    // no clock here: the drawing goes on without the watch
  }
}

// A repo has appeared where there was none: the split pane's Git half is
// back at its 30%. After the drawing, which may not write `$.state`.
const resetPanels = ($: EngineInterface): void => {
  $.clock.after(1, () => update($, explorer, s => ({ ...s, split: { ...s.split, panels: undefined } })))
}

// Changes made outside Claude (another editor, a shell, Unity, git by hand)
// show without a press: while a panel is up the disk is looked at every
// DISK_POLL_MS. Claude's own tool calls clear the caches at once (the
// tool.call hooks).
let diskWatch: { cancel: () => void } | undefined
const DISK_POLL_MS = 2000
// A converter missing when a picture asked for one is looked for again every
// this many looks (30 s), until one is found.
const TOOL_LOOKS = 15
let diskLooks = 0
// A picture found no converter: the watch looks for one again.
let wantsTool = false
// The previewed file and its mtime as the last drawing read it.
let previewStamp: { path: string; mtime: number } | undefined
// A save in flight: the file is written before `baseMtime` moves along.
let saving = false

const watchDisk = ($: EngineInterface): void => {
  if (diskWatch !== undefined) return
  try {
    diskWatch = $.clock.after(DISK_POLL_MS, async () => {
      diskWatch = undefined
      try {
        // Both panes closed: the next drawing watches again.
        if (!(await paneIsOpen($, PANE, SPLIT_PANE))) return
        if (await diskChanged($)) $.ui.invalidate('ui.render')
        watchDisk($)
      } catch {
        // no surface to ask: the next drawing watches again
      }
    })
  } catch {
    // no clock here: the drawing goes on without the watch
  }
}

// One look; true when a drawing would change. A listed dir whose mtime moved
// is listed again, the previewed file's mtime moving redraws Preview, the
// open editor checks its file (`checkDisk` writes the state itself), and a
// changed branch or `git status` redraws the change marks.
const diskChanged = async ($: EngineInterface): Promise<boolean> => {
  let isChanged = false
  const looked = await Promise.all(
    [...listings.keys()].map(async dir => ({ dir, mtime: (await statOf($, dir))?.mtimeMs })),
  )
  for (const { dir, mtime } of looked) {
    const before = listings.get(dir)
    if (before === undefined || mtime === dirStamps.get(dir)) continue
    listings.delete(dir)
    for (const path of [...ignored]) if (parentOf(path) === dir) ignored.delete(path)
    await ensureListed($, dir)
    const names = changedEntries(before, listings.get(dir) ?? [])
    if (names.length === 0) continue
    isChanged = true
    if (names.some(name => name.endsWith('.meta'))) indexes.clear()
  }
  if (isChanged) {
    unityRoots.clear()
    // an embedded image may have come or gone
    mdCache.clear()
  }
  const state = await read($, explorer)
  const shown = previewStamp
  if (shown !== undefined && shown.path === state.selected) {
    const mtime = (await statOf($, shown.path))?.mtimeMs
    if (mtime !== shown.mtime) {
      previewStamp = undefined
      isChanged = true
    }
  }
  if (state.edit !== undefined && !saving) await checkDisk($)
  const root = await rootOf($, state)
  const known = footers.get(root)
  if (known?.branch !== undefined) {
    footers.delete(root)
    const now = await footerOf($, root)
    // An aborted call left it blank: kept as it was.
    if (!footers.has(root)) {
      footers.set(root, known)
    } else {
      const paths = changedMarks(known.marks, now.marks)
      if (now.branch !== known.branch || paths.length > 0) isChanged = true
      // New ignore rules: every listed dir is checked again.
      if (paths.some(path => nameOf(path) === '.gitignore')) {
        listings.clear()
        ignored.clear()
      }
      if (paths.some(path => path.endsWith('.meta'))) indexes.clear()
    }
  }
  diskLooks += 1
  if (wantsTool && diskLooks % TOOL_LOOKS === 0) {
    const had = await toolsOf($)
    const found = await detectTools($)
    if (found.raster !== had.raster || found.svg !== had.svg) {
      imageTool = Promise.resolve(found)
      wantsTool = false
      dropPictures()
      isChanged = true
    }
  }

  return isChanged
}

const modeKey = (root: string): string => 'explorer.mode:' + root
// The section sizes, global (every root): the whole `split` object, written
// when a splitter drag ends and read by session.start while `split` is unset.
const LAYOUT_KEY = 'layout:explorer'

const ensureListed = async ($: EngineInterface, dir: string): Promise<void> => {
  if (listings.has(dir)) return
  // Taken first: a change while listing moves it past this.
  dirStamps.set(dir, (await statOf($, dir))?.mtimeMs)
  let entries: Entry[] = []
  try {
    const found = await $.fs.list(dir)
    entries = found.map(({ name, kind, size }) => ({ name, kind, size }))
  } catch {
    entries = []
  }
  listings.set(dir, entries)
  await markIgnored($, dir, entries)
}

// One `git check-ignore` per listed dir; a non-zero exit (1: none ignored,
// 128: not a repo) or any failure leaves nothing dimmed.
const markIgnored = async (
  $: EngineInterface,
  dir: string,
  entries: readonly Entry[],
): Promise<void> => {
  if (entries.length === 0) return
  try {
    const ran = await $.process.run(['git', 'check-ignore', '--stdin', '-z'], {
      cwd: dir,
      stdin: entries.map(entry => entry.name).join('\0'),
      timeoutMs: 5000,
    })
    if (ran.exitCode !== 0) return
    for (const name of ran.stdout.split('\0')) {
      if (name !== '') ignored.add(join(dir, name))
    }
  } catch {
    // not a git repo, or git is missing
  }
}

const isUnityProject = async (
  $: EngineInterface,
  root: string,
): Promise<boolean> => {
  const known = unityRoots.get(root)
  if (known !== undefined) return known
  let found = false
  try {
    found = await $.fs.exists(join(root, 'ProjectSettings/ProjectVersion.txt'))
  } catch {
    found = false
  }
  unityRoots.set(root, found)

  return found
}

const TOP = ['Assets', 'Packages']

const walk = async (
  $: EngineInterface,
  dir: string,
  index: Map<string, string>,
): Promise<void> => {
  let entries: Awaited<ReturnType<EngineInterface['fs']['list']>> = []
  try {
    entries = await $.fs.list(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.kind === 'dir') {
      await walk($, path, index)
    } else if (entry.kind === 'file' && entry.name.endsWith('.meta')) {
      try {
        const text = await $.fs.read(path)
        const guid = typeof text === 'string' ? metaGuid(text) : undefined
        if (guid !== undefined && !index.has(guid)) {
          index.set(guid, path.slice(0, -'.meta'.length))
        }
      } catch {
        // unreadable .meta: skip
      }
    }
  }
}

const buildIndex = async (
  $: EngineInterface,
  root: string,
): Promise<Map<string, string>> => {
  const dirs: string[] = []
  for (const name of TOP) {
    try {
      if (await $.fs.exists(join(root, name))) dirs.push(name)
    } catch {
      // treat as missing
    }
  }
  if (dirs.length === 0) return new Map()
  try {
    const ran = await $.process.run(
      ['grep', '-r', '--include=*.meta', '-m1', '^guid:', ...dirs],
      { cwd: root, timeoutMs: 20000 },
    )
    // exit 1: no matches; 0: matches. Anything else is not trusted: walk the
    // tree instead.
    if (ran.exitCode <= 1) {
      return parseGrep(ran.stdout, root)
    }
  } catch {
    // grep missing or timed out
  }
  const index = new Map<string, string>()
  for (const name of dirs) await walk($, join(root, name), index)

  return index
}

// Module cache (not $.state): rebuilt lazily after a reload or a `.meta` change.
const indexes = new Map<string, Promise<Map<string, string>>>()

const guidIndex = (
  $: EngineInterface,
  root: string,
): Promise<GuidIndex> => {
  let built = indexes.get(root)
  if (built === undefined) {
    built = buildIndex($, root)
    indexes.set(root, built)
  }

  return built
}


const rootOf = async (
  $: EngineInterface,
  state: ExplorerState,
): Promise<string> => (state.root === '' ? await $.session.root() : state.root)

// Leaving the editor for another file or mode: a dirty buffer asks first
// (true: wait for the bar), a clean one just closes.
const leaveEdit = async (
  $: EngineInterface,
  confirm: 'select' | 'mode',
  pending: string,
): Promise<boolean> => {
  if ((await read($, explorer)).edit === undefined) return false
  if (await guarded($, confirm, pending)) return true
  await clearEdit($)

  return false
}

const setMode = async ($: EngineInterface, mode: Mode): Promise<void> => {
  if (await leaveEdit($, 'mode', mode)) return
  const state = await read($, explorer)
  const root = await rootOf($, state)
  await update($, explorer, s => ({ ...s, root, mode, offset: 0 }))
  await $.store.set(modeKey(root), mode)
}

// A dir's arrow (a Client hit, or the `arrow:` Button): opens or closes it,
// moving the cursor there; the selection stays.
const toggle = async ($: EngineInterface, path: string): Promise<void> => {
  await update($, explorer, s => {
    const isOpen = s.expanded.includes(path)

    return { ...s, cursor: path, expanded: isOpen ? s.expanded.filter(at => at !== path) : [...s.expanded, path] }
  })
}

// A click on the name (or Enter): the row becomes the selection (shown in
// the preview); only the arrow opens or closes a dir. `isKey`: the press came
// through the keyboard ring (the blank `row:` Button), where Enter on the
// selected dir still opens or closes it, as there is no arrow to reach.
const press = async ($: EngineInterface, row: Row, isKey = false): Promise<void> => {
  const state = await read($, explorer)
  const edit = state.edit
  if (edit !== undefined && (row.kind === 'dir' || row.path === edit.path)) {
    // While editing, a dir press only moves the cursor (Enter opens or closes
    // it); the selection stays on the edited file.
    if (isKey && row.kind === 'dir') await toggle($, row.path)
    else await update($, explorer, s => ({ ...s, cursor: row.path }))

    return
  }
  if (isKey && row.kind === 'dir' && state.selected === row.path) {
    await toggle($, row.path)

    return
  }
  if (await leaveEdit($, 'select', row.path)) return
  await update($, explorer, s => ({
    ...s,
    cursor: row.path,
    selected: row.path,
    previewOffset: s.selected === row.path ? s.previewOffset : 0,
    previewLeft: s.selected === row.path ? s.previewLeft : 0,
    previewRaw: s.selected === row.path ? s.previewRaw : undefined,
  }))
}

type Preview =
  | {
      type: 'code'
      path: string
      mtime: number
      language?: string
      lines: string[]
      refs: Ref[]
      generated?: boolean // a custom engine's output, not the file's text: no `edit`
    }
  | { type: 'text'; lines: string[] }
  | {
      type: 'image'
      path: string
      mtime: number // whole ms: the Image source's generation
      bytes: number
      png?: string // the PNG file the terminal draws: the file itself or a converted copy
      width?: number // pixels, when known
      height?: number
      svg?: string // the SVG text, drawn by `Svg` on remote surfaces
      note?: string // why there is no picture
    }

  | {
      type: 'markdown'
      path: string
      mtime: number
      text: string
      generated?: boolean // a custom engine's output (`as: markdown`): no `edit`
    }

type ImagePreview = Extract<Preview, { type: 'image' }>
type MarkdownPreview = Extract<Preview, { type: 'markdown' }>

// ------------------------------------------------------------------ Images

// The Image's key: the blit probe names it.
const IMAGE_KEY = 'preview:image'
// `Svg` takes at most this many characters.
const MAX_SVG_CHARS = 131072

// Converters found on this machine and where converted PNGs go; looked up
// once per load (the first image that needs one).
type ImageTools = { raster?: ConvertTool; svg?: ConvertTool; dir: string }
let imageTool: Promise<ImageTools> | undefined
// Image previews per surface kind, path and mtime (the load's promise, so
// drawings while a conversion runs share it). Keys name the version, so
// only a converter found later, the pane's close and the session's end clear it.
const pictures = new Map<string, Promise<ImagePreview>>()
// Every PNG converted (or written at `{out}`) this load: removed when the
// pane closes or the session ends, never when a newer version replaces one
// (a cached markdown view may still draw it); older loads' files are swept
// by session.start.
const converted = new Set<string>()
// Custom engines (userConfig `previewEngines`), parsed once per load, and
// what was wrong with the config (toasted once per load by session.start).
let customEngines: Record<string, CustomEngine> = {}
let engineErrors: string[] = []
// Custom engine previews per surface kind, path and mtime (the run's promise,
// so drawings while it runs share it); cleared like the pictures.
const customCache = new Map<string, Promise<Preview>>()
// Rendered markdown, the latest version per file only: the parse per path,
// and the rows per surface kind and path, for one mtime, width, room and
// probe answer (the layout holds theme roles, not colors). The rows are
// cleared by every listing clear (an embedded image may have changed).
const mdParsed = new Map<string, { mtime: number; parsed: ParseResult }>()
const mdCache = new Map<string, { sig: string; view: MdView }>()
// What the last drawing of rendered markdown showed, read by the link
// message: the file, the window's first row, its heading rows and the link
// runs pressable through a `Client` (`md:link:<i>`, posting `{ link: i,
// path, offset }`; a press from another drawing is ignored).
const mdShown = {
  path: '',
  offset: 0,
  anchors: new Map<string, number>() as ReadonlyMap<string, number>,
  links: [] as LinkHit[],
}
// The blit probe: `alt` once a keyed Image answered that it draws its alt here
// (no kitty graphics, or inside tmux); then images draw metadata only.
let imageProbe: 'unknown' | 'pending' | 'probing' | 'ok' | 'alt' = 'unknown'

const isRemote = (surface: string): boolean => surface !== 'terminal'

// The Files rows as the state shows them.
const treeRowsOf = (state: ExplorerState, root: string): Row[] =>
  flatten(listings, new Set(state.expanded), root, { mode: state.mode })

// The cache key of one file version as a surface kind previews it.
const versionKey = (surface: string, path: string, mtimeMs: number): string =>
  (isRemote(surface) ? 'remote' : 'terminal') + '\0' + path + '\0' + Math.trunc(mtimeMs)

// Why a picture is not drawn: a remote surface, or a terminal whose blit
// probe answered `alt`.
const NOTE_REMOTE = 'image preview needs a kitty-graphics terminal'
const NOTE_ALT = "terminal can't draw images"

// The surface a `$.ui.copy` goes to.
type CopySurface = Parameters<EngineInterface['ui']['copy']>[0]['surface']

// Exit 0 of `argv`; a missing binary throws, which is a no.
const runs = async ($: EngineInterface, argv: string[]): Promise<boolean> => {
  try {
    return (await $.process.run(argv, { timeoutMs: 5000 })).exitCode === 0
  } catch {
    return false
  }
}

const detectTools = async ($: EngineInterface): Promise<ImageTools> => {
  const raster = (await runs($, ['magick', '-version']))
    ? 'magick'
    : (await runs($, ['convert', '-version']))
      ? 'convert'
      : undefined
  const svg = (await runs($, ['rsvg-convert', '--version'])) ? 'rsvg-convert' : raster
  let dir = '/dev/shm'
  let hasShm = false
  try {
    hasShm = await $.fs.exists(dir)
  } catch {
    hasShm = false
  }
  if (!hasShm) {
    dir = (await convertDirs($))[1]!
    await runs($, ['mkdir', '-p', dir])
  }

  return { raster, svg, dir }
}

const toolsOf = ($: EngineInterface): Promise<ImageTools> => {
  imageTool ??= detectTools($)

  return imageTool
}

// Removes converted PNGs; there is no `$.fs` delete.
const removeConverted = async ($: EngineInterface, files: readonly string[], timeoutMs = 5000): Promise<void> => {
  if (files.length === 0) return
  try {
    await $.process.run(['rm', '-f', '--', ...files], { timeoutMs })
  } catch {
    // left for session.start's sweep (or /dev/shm's next boot)
  }
}

// Every preview cache: a converter found later, the blit probe's answer, the
// pane's close.
const dropPictures = (): void => {
  pictures.clear()
  customCache.clear()
  mdParsed.clear()
  mdCache.clear()
}

// Removes this load's converted PNGs and forgets the previews drawing them.
const removeAllConverted = async ($: EngineInterface, timeoutMs?: number): Promise<void> => {
  const files = [...converted]
  converted.clear()
  dropPictures()
  await removeConverted($, files, timeoutMs)
}

// Where converted PNGs may be: /dev/shm, else the HOME fallback (detectTools).
const convertDirs = async ($: EngineInterface): Promise<string[]> => [
  '/dev/shm',
  ((await $.env.get('HOME')) ?? '/tmp') + '/.claude/ide-panes/previews',
]

// Once per load (session.start): converted PNGs a day old, left by a load
// that never closed its pane, are removed.
let isSwept = false
const sweepConverted = async ($: EngineInterface): Promise<void> => {
  if (isSwept) return
  isSwept = true
  try {
    const dirs = await convertDirs($)
    await $.process.run(
      ['find', ...dirs, '-maxdepth', '1', '-name', 'ide-panes-preview-*.png', '-mmin', '+1440', '-delete'],
      { timeoutMs: 5000 },
    )
  } catch {
    // tried again next load
  }
}

// A PNG's pixel size from its header: its first 24 bytes through `od`, else
// (no `od`) the bytes read whole, only up to the preview cap.
const pngSizeOf = async ($: EngineInterface, file: string, bytes: number) => {
  try {
    const ran = await $.process.run(['od', '-An', '-tx1', '-N24', '--', file], { timeoutMs: 5000 })
    if (ran.exitCode === 0) return pngSizeFromHex(ran.stdout)
  } catch {
    // no od: the read below
  }
  if (bytes > MAX_PREVIEW_BYTES) return undefined
  try {
    return pngSize((await $.fs.read(file, { as: 'bytes' })).base64)
  } catch {
    return undefined
  }
}

const ext = (name: string): string => name.slice(name.lastIndexOf('.') + 1).toLowerCase()

// The image preview of a file: on the terminal a PNG to draw (the file, or
// converted once to `/dev/shm`), on remote surfaces the SVG text; else a note
// saying why there is none. Cached per path and mtime, the promise itself,
// so drawings while a conversion runs share it (a rejected one is dropped).
const loadImage = (
  $: EngineInterface,
  row: Row,
  stat: { size: number; mtimeMs: number },
  surface: string,
): Promise<ImagePreview> => {
  const key = versionKey(surface, row.path, stat.mtimeMs)
  const known = pictures.get(key)
  if (known !== undefined) return known
  const made = makeImage($, row, stat, surface)
  pictures.set(key, made)
  made.catch(() => {
    if (pictures.get(key) === made) pictures.delete(key)
  })

  return made
}

const makeImage = async (
  $: EngineInterface,
  row: Row,
  stat: { size: number; mtimeMs: number },
  surface: string,
): Promise<ImagePreview> => {
  const mtime = Math.trunc(stat.mtimeMs)
  const base: ImagePreview = { type: 'image', path: row.path, mtime, bytes: stat.size }
  const isSvg = engineOf(row.name, customEngines) === 'svg'
  let made: ImagePreview
  if (isRemote(surface)) {
    if (isSvg) {
      let text: string | undefined
      try {
        text = stat.size <= MAX_PREVIEW_BYTES ? await $.fs.read(row.path) : undefined
      } catch {
        text = undefined
      }
      made =
        text !== undefined && text.length <= MAX_SVG_CHARS
          ? { ...base, svg: text, ...svgSize(text) }
          : { ...base, note: text === undefined ? 'cannot read' : 'too large to draw' }
    } else {
      const size = ext(row.name) === 'png' ? await pngSizeOf($, row.path, stat.size) : undefined
      made = { ...base, ...size, note: NOTE_REMOTE }
    }
  } else if (imageProbe === 'alt') {
    made = { ...base, note: NOTE_ALT }
  } else {
    // A PNG draws from the file itself; a `.png` that isn't one is converted.
    const own = ext(row.name) === 'png' ? await pngSizeOf($, row.path, stat.size) : undefined
    if (own !== undefined || (ext(row.name) === 'png' && stat.size > MAX_PREVIEW_BYTES)) {
      made = { ...base, png: row.path, ...own }
    } else {
      const tools = await toolsOf($)
      const tool = isSvg ? tools.svg : tools.raster
      if (tool === undefined) {
        wantsTool = true
        made = { ...base, note: `install ImageMagick to preview ${ext(row.name)}` }
      } else {
        const out = convertedPath(tools.dir, row.path, mtime)
        const argv = convertArgv(tool, row.path, out)
        let failure: string | undefined
        try {
          if (argv === undefined) throw new Error(`${ext(row.name)} is not a picture`)
          converted.add(out)
          const ran = await $.process.run(argv, { timeoutMs: 30000 })
          if (ran.exitCode !== 0) {
            failure = cleanOutput(ran.stderr).split('\n').find(line => line.trim() !== '') ?? `${tool} exited ${ran.exitCode}`
          }
        } catch (err) {
          failure = err instanceof Error ? err.message : String(err)
        }
        if (failure !== undefined) {
          made = { ...base, note: 'cannot convert: ' + failure }
        } else {
          const outBytes = (await statOf($, out))?.size ?? 0
          const size = await pngSizeOf($, out, outBytes)
          made = { ...base, png: out, ...size }
        }
      }
    }
  }

  return made
}

// Once per load, after the first Image is drawn: a blit of the keyed Image
// answers a deny naming its alt where the terminal draws no pictures. Other
// denies (not mounted yet, the selection moved on) try again a few times.
// The probe's retries so far (a redraw starts the next one) and its timer:
// each drawing re-arms it, so the last drawing's Image is the one blitted.
let probeTries = 0
let probeTimer: { cancel: () => void } | undefined

const probeImage = ($: EngineInterface, source: { file: string; format: 'png'; generation: number }, key = IMAGE_KEY): void => {
  if (imageProbe !== 'unknown' && imageProbe !== 'pending') return
  const tries = probeTries
  imageProbe = 'pending'
  probeTimer?.cancel()
  probeTimer = $.clock.after(250, async () => {
    probeTimer = undefined
    imageProbe = 'probing'
    let deny: string | undefined
    try {
      deny = (await $.ui.blit({ requestId: host, key, source })).deny
    } catch (err) {
      deny = err instanceof Error ? err.message : String(err)
    }
    if (deny === undefined) {
      imageProbe = 'ok'
    } else if (deny.includes('alt')) {
      imageProbe = 'alt'
      dropPictures()
      $.ui.invalidate('ui.render')
    } else if (tries < 3) {
      probeTries = tries + 1
      imageProbe = 'unknown'
      $.ui.invalidate('ui.render')
    } else {
      // Unanswerable here: keep drawing pictures.
      imageProbe = 'ok'
    }
  })
}

// ---------------------------------------------------------------- Markdown

// A picture of a markdown image row takes at most this many Preview rows.
const MD_PICTURE_ROWS = 12

// The rows of a markdown preview at `width` columns. On the terminal (while
// it can draw pictures) an image row whose src is a file inside the root
// grows into the rows its picture takes, fitted into the width and at most
// MD_PICTURE_ROWS (or the room): totals stay exact, so scrolling needs no
// measuring. Elsewhere, and where no picture comes, the `🖼 alt` row.
const markdownView = async (
  $: EngineInterface,
  preview: MarkdownPreview,
  width: number,
  room: number,
  surface: string,
  root: string,
): Promise<MdView> => {
  const kind = isRemote(surface) ? 'remote' : 'terminal'
  const mtime = Math.trunc(preview.mtime)
  const file = preview.path + (preview.generated === true ? '\0custom' : '')
  const key = kind + '\0' + file
  const sig = mtime + '\0' + width + '\0' + room + '\0' + (imageProbe === 'alt' ? 'alt' : '')
  const known = mdCache.get(key)
  if (known !== undefined && known.sig === sig) return known.view
  let held = mdParsed.get(file)
  if (held === undefined || held.mtime !== mtime) {
    held = { mtime, parsed: parseMarkdown(preview.text) }
    mdParsed.set(file, held)
  }
  const laid = layoutMarkdown(held.parsed, width)
  const sized = new Map<number, Picture>()
  if (kind === 'terminal' && imageProbe !== 'alt') {
    for (const [i, row] of laid.rows.entries()) {
      if (row.kind !== 'image') continue
      const path = localPath(row.src, preview.path, root)
      // Only a built-in picture type reaches the converter.
      if (path === undefined || !isPictureFile(nameOf(path), customEngines)) continue
      const stat = await statOf($, path)
      if (stat === undefined || stat.kind !== 'file') continue
      const name = nameOf(path)
      const pic = await loadImage($, { path, name, depth: 0, kind: 'file', isExpanded: false }, stat, surface)
      if (pic.png === undefined || pic.note !== undefined) continue
      const roomCols = Math.max(1, width - spansWidth(row.prefix))
      const roomRows = Math.max(1, Math.min(MD_PICTURE_ROWS, room))
      const cells = fitCells(
        roomCols,
        roomRows,
        pic.width !== undefined && pic.height !== undefined && pic.height > 0
          ? pic.width / pic.height
          : (roomCols * CELL_W) / (roomRows * CELL_H),
      )
      sized.set(i, { png: pic.png, mtime: pic.mtime, ...cells })
    }
  }
  const made = expandPictures(laid, sized)
  mdCache.set(key, { sig, view: made })

  return made
}

// A link run pressed through its `Client`: a heading of this file scrolls
// Preview to it, a file or dir inside the root is selected (`jump`), a URL
// (a table's, or one the surface draws no `Link` for) is toasted.
const followLink = async ($: EngineInterface, href: string): Promise<void> => {
  const state = await read($, explorer)
  const root = await rootOf($, state)
  const target = linkTarget(href, mdShown.path, root)
  const scrollTo = async (slug: string): Promise<boolean> => {
    const row = anchorRow(mdShown.anchors, slug)
    if (row === undefined) return false
    const previewOffset = clamp(row, view.previewMax)
    await update($, explorer, s => ({ ...s, previewOffset }))

    return true
  }
  if (target.kind === 'anchor') {
    if (!(await scrollTo(target.slug))) await $.ui.toast('No heading #' + target.slug)
  } else if (target.kind === 'file') {
    if (target.path === mdShown.path) {
      if (target.slug !== undefined) await scrollTo(target.slug)

      return
    }
    let isThere = false
    try {
      isThere = await $.fs.exists(target.path)
    } catch {
      isThere = false
    }
    if (!isThere) await $.ui.toast('Not found: ' + relativePath(target.path, root))
    else if (target.path !== root) await jump($, target.path)
  } else if (target.kind === 'url') {
    await $.ui.toast('Link: ' + target.url)
  } else {
    await $.ui.toast('Outside the root: ' + target.written)
  }
}

// The repo toplevel a root's paths are named from (the root itself outside
// a repo); `footerOf` fills it, `watchRepo` clears it.
const toplevels = new Map<string, string>()

const toplevelOf = async ($: EngineInterface, root: string): Promise<string> => {
  const known = toplevels.get(root)
  if (known !== undefined) return known
  let base = root
  try {
    const ran = await $.process.run(['git', '-C', root, 'rev-parse', '--show-toplevel'], { timeoutMs: 5000 })
    const out = ran.stdout.trim()
    if (ran.exitCode === 0 && out.startsWith('/')) base = out
  } catch {
    // no git: the root names the paths
  }
  toplevels.set(root, base)

  return base
}

// `copy name` (the row's name) and `copy full path` (its absolute path):
// the text goes to the clipboard.
const copyText = async ($: EngineInterface, text: string, surface: CopySurface): Promise<void> => {
  const copied = await $.ui.copy({ text, surface })
  await $.ui.toast(copied.isCopied ? `Copied: ${text}` : `Copy failed: ${copied.reason}`)
}

// The visible row at `path`, as the tree draws it now.
const rowAt = async ($: EngineInterface, path: string): Promise<Row | undefined> => {
  const state = await read($, explorer)
  const root = await rootOf($, state)
  const rows = treeRowsOf(state, root)

  return rows.find(row => row.path === path)
}

// Select `path` and expand every dir between the root and it; the window
// offset is recomputed so the row is visible.
const jump = async ($: EngineInterface, path: string): Promise<void> => {
  if ((await read($, explorer)).edit?.path !== path && (await leaveEdit($, 'select', path))) return
  const state = await read($, explorer)
  const root = await rootOf($, state)
  const dirs = dirsAbove(path, root)
  const expanded = [...state.expanded, ...dirs.filter(d => !state.expanded.includes(d))]
  await Promise.all([root, ...expanded].map(dir => ensureListed($, dir)))
  const rows = flatten(listings, new Set(expanded), root, { mode: state.mode })
  const win = windowOf(
    rows,
    rows.findIndex(row => row.path === path),
    treeRows,
    state.offset,
  )
  await update($, explorer, s => ({
    ...s,
    selected: path,
    cursor: path,
    previewOffset: s.selected === path ? s.previewOffset : 0,
    previewLeft: s.selected === path ? s.previewLeft : 0,
    previewRaw: s.selected === path ? s.previewRaw : undefined,
    expanded,
    offset: win.offset,
  }))
}

const metadata = (name: string, size: number, mtimeMs: number): string[] => [
  name,
  formatSize(size),
  'modified ' + new Date(mtimeMs).toISOString(),
]

const RANK = { resolved: 0, unresolved: 1, builtin: 2 } as const

// ---------------------------------------------------------- Custom engines

// How long a custom engine's command may run.
const CUSTOM_TIMEOUT_MS = 10000

// A custom engine's markdown output (`as: markdown`), rendered.
// A custom engine's preview of a file: its command's stdout as text, code or
// markdown, or the PNG it wrote at `{out}` through the image path. Cached per
// surface kind, path and mtime; a failure is metadata and why.
const loadCustom = (
  $: EngineInterface,
  row: Row,
  stat: { size: number; mtimeMs: number },
  engine: CustomEngine,
  surface: string,
): Promise<Preview> => {
  const key = versionKey(surface, row.path, stat.mtimeMs)
  const known = customCache.get(key)
  if (known !== undefined) return known
  const made = runCustom($, row, stat, engine, surface)
  customCache.set(key, made)

  return made
}

const runCustom = async (
  $: EngineInterface,
  row: Row,
  stat: { size: number; mtimeMs: number },
  engine: CustomEngine,
  surface: string,
): Promise<Preview> => {
  const mtime = Math.trunc(stat.mtimeMs)
  const tool = engine.cmd[0]!
  const failed = (why: string): Preview => ({
    type: 'text',
    lines: [...metadata(row.name, stat.size, stat.mtimeMs), `${tool}: ${why}`],
  })
  const base: ImagePreview = { type: 'image', path: row.path, mtime, bytes: stat.size }
  // Where no picture can draw, the command is not run.
  if (engine.as === 'png' && isRemote(surface)) return { ...base, note: NOTE_REMOTE }
  if (engine.as === 'png' && imageProbe === 'alt') return { ...base, note: NOTE_ALT }
  // `{out}`: one file per path and mtime beside the converted pictures,
  // removed like them (with the pane, or at the session's end).
  const usesOut = engine.cmd.some(arg => arg.includes('{out}'))
  const out = usesOut ? convertedPath((await toolsOf($)).dir, row.path, mtime) : ''
  if (usesOut) converted.add(out)
  let stdout: string
  try {
    const ran = await $.process.run(engineArgv(engine, row.path, out), { timeoutMs: CUSTOM_TIMEOUT_MS })
    if (ran.exitCode !== 0) return failed(firstLine(cleanOutput(ran.stderr)) ?? `exited ${ran.exitCode}`)
    // Drawable text: no escape sequences or control characters (pdftotext's
    // form feed, a colored tool's ANSI), which Code and Text refuse.
    stdout = cleanOutput(ran.stdout)
  } catch (err) {
    return failed(runFailure(err instanceof Error ? err.message : String(err)))
  }
  const lines = stdout.replace(/\n$/, '').split('\n')
  switch (engine.as) {
    case 'text':
      // The code preview with no language: plain text that scrolls.
      return { type: 'code', path: row.path, mtime: stat.mtimeMs, lines, refs: [], generated: true }
    case 'code':
      return {
        type: 'code',
        path: row.path,
        mtime: stat.mtimeMs,
        language: languageOf(row.name),
        lines,
        refs: [],
        generated: true,
      }
    case 'markdown':
      return { type: 'markdown', path: row.path, mtime: stat.mtimeMs, text: stdout, generated: true }
    case 'png': {
      const outStat = await statOf($, out)
      if (outStat === undefined) return failed('wrote no picture')
      const outBytes = outStat.size
      const size = await pngSizeOf($, out, outBytes)
      if (size === undefined && outBytes <= MAX_PREVIEW_BYTES) return failed('wrote no PNG')

      return { ...base, png: out, ...size }
    }
  }
}

const loadPreview = async (
  $: EngineInterface,
  row: Row,
  isUnity: boolean,
  root: string,
  surface: string,
  isRaw: boolean,
): Promise<Preview> => {
  if (row.kind === 'dir') {
    await ensureListed($, row.path)
    const entries = listings.get(row.path) ?? []
    const files = entries.filter(entry => entry.kind === 'file')
    const total = files.reduce((sum, entry) => sum + entry.size, 0)

    return {
      type: 'text',
      lines: [
        row.name + '/',
        `${entries.length} entries`,
        `${formatSize(total)} in ${files.length} files`,
      ],
    }
  }
  try {
    const stat = await $.fs.stat(row.path)
    previewStamp = { path: row.path, mtime: stat.mtimeMs }
    // The engine picks the renderer; `isRaw` shows a rendered one's source.
    const engine = engineOf(row.name, customEngines)
    // A custom engine reads the file itself: no size cap here.
    if (stat.kind === 'file' && typeof engine === 'object') {
      return await loadCustom($, row, stat, engine.custom, surface)
    }
    if (stat.kind === 'file' && (engine === 'image' || (engine === 'svg' && !isRaw))) {
      return await loadImage($, row, stat, surface)
    }
    if (stat.kind !== 'file' || stat.size > MAX_PREVIEW_BYTES) {
      return { type: 'text', lines: metadata(row.name, stat.size, stat.mtimeMs) }
    }
    const text = await $.fs.read(row.path)
    if (typeof text !== 'string' || isBinary(text)) {
      return { type: 'text', lines: metadata(row.name, stat.size, stat.mtimeMs) }
    }
    // Markdown renders (laid out by the drawing, which knows the width);
    // the view chip shows its source as code below.
    if (engine === 'markdown' && !isRaw) {
      return { type: 'markdown', path: row.path, mtime: stat.mtimeMs, text }
    }

    const refs =
      isUnity && hasRefs(row.name)
        ? classify(refsOf(text), await guidIndex($, root))
        : []
    refs.sort((a, b) => RANK[a.kind] - RANK[b.kind])

    return {
      type: 'code',
      path: row.path,
      mtime: stat.mtimeMs,
      language: languageOf(row.name),
      lines: text.replace(/\n$/, '').split('\n'),
      refs,
    }
  } catch {
    return { type: 'text', lines: [row.name, 'cannot read'] }
  }
}

// Drops the cached listing of the file's dir and of the file itself.
const dropFile = (file: string): void => {
  for (const path of [file, parentOf(file)]) {
    listings.delete(path)
    ignored.delete(path)
  }
  footers.clear()
  if (file.endsWith('.meta')) indexes.clear()
  // Previews are keyed by version; only layouts may hold an image this changed.
  mdCache.clear()
}

// ------------------------------------------------------------ Edit section

// Unsaved: the client said so, or a draft holds text the file does not.
const isEditDirty = (edit: Edit | undefined): boolean =>
  edit !== undefined && (editing.isDirty || edit.hasDraft === true)

const resetEditing = (): void => {
  editing.version = -1
  editing.parts = []
  editing.total = 0
  editing.index = -1
  editing.isDraft = false
  editing.isDirty = false
  editing.incoming = undefined
  editing.hview = undefined
}

const statOf = async ($: EngineInterface, path: string) => {
  try {
    return await $.fs.stat(path)
  } catch {
    return undefined
  }
}

const draftOf = async ($: EngineInterface, path: string): Promise<string | undefined> => {
  const home = await $.env.get('HOME')

  return home === undefined || home === '' ? undefined : draftFile(home, path)
}

// There is no `$.fs` delete.
const removeDraft = async ($: EngineInterface, path: string): Promise<void> => {
  const draft = await draftOf($, path)
  if (draft === undefined) return
  try {
    await $.process.run(['rm', '-f', draft], { timeoutMs: 5000 })
  } catch {
    // left behind: an older draft is never restored over a newer file
  }
}

// Merges into `edit` while it is still the given version.
const patchEdit = ($: EngineInterface, version: number, patch: Partial<Edit>) =>
  update($, explorer, s =>
    s.edit === undefined || s.edit.version !== version ? s : { ...s, edit: { ...s.edit, ...patch } },
  )

const clearEdit = async ($: EngineInterface): Promise<void> => {
  resetEditing()
  await update($, explorer, s => ({ ...s, edit: undefined }))
}

// A border or bar Button's action for the client, through its props.
const sendCommand = ($: EngineInterface, command: string, by = 0): void => {
  editing.command = command
  editing.by = by
  editing.commandSeq += 1
  $.ui.invalidate('ui.render')
}

const toast = async ($: EngineInterface, text: string): Promise<void> => {
  try {
    await $.ui.toast(text)
  } catch {
    // no surface to show it
  }
}

// The Settings sheet (shared/settings-sheet.tsx). Git keeps the same handlers
// in its own file: the validator follows `$` only within one file.

// The Settings Button: opens the sheet here (from either pane's sheet it moves, keeping
// what was changed); on the open sheet it is `done`.
const toggleSettings = async ($: EngineInterface): Promise<void> => {
  const ui = await read($, settingsUi)
  if (ui.open === host) return settingsDone($)
  const now = await read($, settings)
  await update($, settingsUi, (u): SettingsUi => (u.open === undefined ? { open: host, before: now } : { ...u, open: host }))
  // The sheet takes the keyboard, its ring on the editor keymap in effect
  // (Enter there changes nothing; Tab walks on to the keys field): see focusOn.
  focusOn($, 'settings:keymap:' + keymapNameOf(pluginOptions, now))
}

// A change applies at once (both panels redraw); `done` saves it. A new page
// size drops the commits git has paged to.
const changeSettings = async ($: EngineInterface, patch: Partial<SettingsState>): Promise<void> => {
  await update($, settings, s => ({ ...s, ...patch }))
  if (patch.gitLimit !== undefined) {
    const gitRef = { plugin: 'ide-panes', key: 'git' } as const
    const held = await $.state.get(gitRef)
    if (held.value !== undefined) await $.state.set(gitRef, { ...held.value, limit: undefined })
  }
}

// The key overrides field: good text (empty is none) is applied; bad text is
// kept in the field with its error, the settings keep the last good text.
const settingsKeys = async ($: EngineInterface, text: string): Promise<void> => {
  const error = keysError(text)
  await update($, settingsUi, u => ({ ...u, keys: text, keysError: error }))
  if (error === undefined) await update($, settings, s => ({ ...s, keys: text.trim() === '' ? undefined : text }))
}

// Both panels' section sizes back to their defaults, here and for later
// sessions. `{}`, not undefined: git's draw would fall back to the layout it
// read from the store once per load.
const resetLayout = async ($: EngineInterface): Promise<void> => {
  await $.store.delete(LAYOUT_KEY)
  await $.store.delete('layout:git')
  await update($, explorer, s => ({ ...s, split: {} }))
  const gitRef = { plugin: 'ide-panes', key: 'git' } as const
  const held = await $.state.get(gitRef)
  if (held.value !== undefined) await $.state.set(gitRef, { ...held.value, split: {} })
  await toast($, 'Layout reset')
}

const settingsDone = async ($: EngineInterface): Promise<void> => {
  await $.store.set(SETTINGS_KEY, await read($, settings))
  await update($, settingsUi, () => ({}))
}

const settingsCancel = async ($: EngineInterface): Promise<void> => {
  const before = (await read($, settingsUi)).before
  if (before !== undefined) await update($, settings, () => before)
  await update($, settingsUi, () => ({}))
}

const startEdit = async ($: EngineInterface, path: string): Promise<void> => {
  const stat = await statOf($, path)
  resetEditing()
  await update($, explorer, s => ({
    ...s,
    selected: path,
    // As every selection change: another file starts rendered.
    previewRaw: s.selected === path ? s.previewRaw : undefined,
    edit: {
      path,
      // Unique across edits, so a chunk of an earlier one is never taken.
      version: Math.max(Date.now(), (s.edit?.version ?? 0) + 1),
      baseMtime: stat?.mtimeMs,
    },
  }))
}

// Reads the text of `edit.version`: the draft when it is newer than the file
// (how a reload or a restart restores unsaved text), else the file; a file
// not there yet is empty. A file that cannot be read closes the editor
// rather than offer an empty buffer to save over it.
const loadEdit = async ($: EngineInterface, edit: Edit): Promise<boolean> => {
  const draft = await draftOf($, edit.path)
  const file = await statOf($, edit.path)
  const kept = draft === undefined ? undefined : await statOf($, draft)
  const isDraft =
    draft !== undefined && kept !== undefined && (file === undefined || kept.mtimeMs > file.mtimeMs)
  let text = ''
  try {
    if (isDraft || file !== undefined) {
      const got = await $.fs.read(isDraft ? draft : edit.path)
      if (typeof got !== 'string') throw new Error('not text')
      text = got
    }
  } catch {
    await clearEdit($)
    await toast($, `Cannot edit ${edit.path}`)

    return false
  }
  editing.version = edit.version
  editing.parts = chunks(text, TRANSFER_CHUNK)
  editing.total = editing.parts.length
  editing.index = 0
  editing.isDraft = isDraft
  editing.isDirty = isDraft
  editing.incoming = undefined
  await patchEdit($, edit.version, {
    // A draft keeps the mtime it was based on, so a save still sees a change.
    baseMtime: isDraft ? (edit.baseMtime ?? file?.mtimeMs) : file?.mtimeMs,
    hasDraft: isDraft ? true : undefined,
  })

  return true
}

const editorProps = (edit: Edit, t: Theme): EditorProps => {
  const isLoaded = editing.version === edit.version

  return {
    path: edit.path,
    language: languageOf(nameOf(edit.path)) ?? '',
    colors: editorColors(t),
    keymap,
    rows: view.editRows,
    columns: view.editColumns,
    version: edit.version,
    chunk: isLoaded ? (editing.parts[editing.index] ?? '') : '',
    index: isLoaded ? editing.index : -1,
    total: isLoaded ? editing.total : 0,
    isDraft: isLoaded && editing.isDraft,
    ack: editing.ack,
    saved: editing.saved,
    command: editing.command,
    commandSeq: editing.commandSeq,
    by: editing.by,
  }
}

// The one dirty check: true when the action waits for the unsaved-changes
// bar (save / discard / cancel), which then runs it through `finish`.
const guarded = async (
  $: EngineInterface,
  confirm: NonNullable<Edit['confirm']>,
  pending?: string,
): Promise<boolean> => {
  const edit = (await read($, explorer)).edit
  if (!isEditDirty(edit)) return false
  await patchEdit($, edit!.version, { confirm, pending })
  $.ui.invalidate('ui.render')

  return true
}

// What the unsaved-changes bar held back, once saved or discarded.
const finish = async (
  $: EngineInterface,
  confirm: Edit['confirm'],
  pending: string | undefined,
): Promise<void> => {
  await clearEdit($)
  if (confirm === 'select' && pending !== undefined) await jump($, pending)
  else if (confirm === 'mode' && isMode(pending)) await setMode($, pending)
  else if (confirm === 'pane') await $.ui.close({ id: host })
  $.ui.invalidate('ui.render')
}

// The Edit border's `close`: back to Preview, asking first when unsaved.
const closeEdit = async ($: EngineInterface): Promise<void> => {
  if (await guarded($, 'close')) return
  await clearEdit($)
}

// ------------------------------------------------------------------- Focus

// Moves the ring onto `key` once the press that drew it has returned: awaited
// inside the press, the focus waits on a drawing that cannot come until the
// press ends, and is denied. A click leaves the keyboard with the prompt, and
// `$.ui.focus` moves only a ring the pane holds, so the pane asks for the keys
// first (re-opening it with `focus`; the surface grants that only over an empty
// composer). A deny (not drawn yet, a row's autoFocus first) retries a few
// times; after that the person clicks into it.
const focusOn = ($: EngineInterface, key: string, tries = 4): void => {
  $.clock.after(50, async () => {
    try {
      const pane = (await $.ui.panes()).find(p => p.id === host)
      if (pane !== undefined && !pane.isFocused) {
        await $.ui.open({ ...openArgs(host), focus: true })
      }
      const moved = await $.ui.focus({ requestId: host, key })
      if (moved.deny !== undefined && tries > 1) focusOn($, key, tries - 1)
    } catch {
      // the person clicks into it
    }
  })
}

const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

// The Edit border's line Buttons: label and the editor action they send.
const EDIT_COMMANDS: readonly (readonly [string, Action])[] = [
  ['↑Line', 'moveLinesUp'],
  ['↓Line', 'moveLinesDown'],
  ['Dup', 'duplicateLines'],
  ['Del', 'deleteLines'],
]

const discard = async ($: EngineInterface): Promise<void> => {
  const edit = (await read($, explorer)).edit
  if (edit === undefined) return
  await removeDraft($, edit.path)
  await finish($, edit.confirm, edit.pending)
}

// Drops the buffer and reads the file again (the conflict bar's `reload`, or
// Claude changed a clean buffer's file).
const reloadEdit = async ($: EngineInterface): Promise<void> => {
  const edit = (await read($, explorer)).edit
  if (edit === undefined) return
  await removeDraft($, edit.path)
  resetEditing()
  await patchEdit($, edit.version, {
    version: edit.version + 1,
    conflict: undefined,
    confirm: undefined,
    pending: undefined,
    hasDraft: undefined,
  })
  $.ui.invalidate('ui.render')
}

// A save checks the file against the mtime it was loaded at: changed asks
// overwrite / reload / cancel first.
const saveText = async (
  $: EngineInterface,
  seq: number,
  text: string,
  force: boolean,
): Promise<void> => {
  const edit = (await read($, explorer)).edit
  if (edit === undefined) return
  const stat = await statOf($, edit.path)
  const isChanged = stat !== undefined && edit.baseMtime !== undefined && stat.mtimeMs !== edit.baseMtime
  if (isChanged && !force) {
    await patchEdit($, edit.version, { conflict: 'disk', confirm: undefined, pending: undefined })

    return
  }
  saving = true
  try {
    try {
      await $.fs.write(edit.path, text)
    } catch (err) {
      await toast($, `Save failed: ${err instanceof Error ? err.message : String(err)}`)

      return
    }
    const after = await statOf($, edit.path)
    editing.saved = seq
    editing.isDirty = false
    await removeDraft($, edit.path)
    dropFile(edit.path)
    await patchEdit($, edit.version, {
      baseMtime: after?.mtimeMs,
      hasDraft: undefined,
      conflict: undefined,
    })
  } finally {
    saving = false
  }
  if (edit.confirm !== undefined) await finish($, edit.confirm, edit.pending)
}

const writeDraft = async ($: EngineInterface, text: string): Promise<void> => {
  const edit = (await read($, explorer)).edit
  if (edit === undefined || !editing.isDirty) return
  const draft = await draftOf($, edit.path)
  if (draft === undefined) return
  try {
    await $.fs.write(draft, text)
  } catch {
    return
  }
  if (edit.hasDraft !== true) await patchEdit($, edit.version, { hasDraft: true })
}

// A message of the editor client: `need` a chunk, `dirty`, `hview`, `copy`, or a
// draft or save chunk. Every answer is the client's next props, acking it.
const editorMessage = async (
  $: EngineInterface,
  data: unknown,
  surface: CopySurface,
): Promise<{ props?: unknown }> => {
  const edit = (await read($, explorer)).edit
  const d = data as Record<string, unknown> | null
  if (edit === undefined || d === null || typeof d !== 'object') return {}
  if (typeof d.id === 'string') editing.ack = d.id
  const isCurrent = d.version === edit.version
  if (typeof d.need === 'number' && isCurrent) {
    // `need: 0` is a client starting over (new, or drawn again): read afresh.
    if (d.need === 0 || editing.version !== edit.version) {
      if (!(await loadEdit($, edit))) return {}
    }
    editing.index = clamp(d.need, editing.total)
    if (editing.index >= editing.total) editing.parts = []
  } else if (typeof d.dirty === 'boolean' && isCurrent) {
    editing.isDirty = d.dirty
    if (!d.dirty && edit.hasDraft === true) {
      await removeDraft($, edit.path)
      await patchEdit($, edit.version, { hasDraft: undefined })
    }
    $.ui.invalidate('ui.render')
  } else if ('hview' in d) {
    const hview = parseHView(d.hview)
    if (hview !== undefined && isCurrent) {
      editing.hview = hview
      $.ui.invalidate('ui.render')
    }
  } else if (typeof d.copy === 'string') {
    try {
      const copied = await $.ui.copy({ text: d.copy, surface })
      if (!copied.isCopied) await toast($, `Copy failed: ${copied.reason}`)
    } catch {
      // the editor's own clipboard still has it
    }
  } else {
    const msg = parseChunk(d)
    if (msg !== undefined && msg.version === edit.version) {
      const got = accept(editing.incoming, msg)
      editing.incoming = got.incoming
      if (got.text !== undefined) {
        if (msg.kind === 'draft') await writeDraft($, got.text)
        else await saveText($, msg.seq, got.text, msg.force === true)
        $.ui.invalidate('ui.render')
      }
    }
  }
  const after = (await read($, explorer)).edit
  if (after === undefined) return {}

  return { props: editorProps(after, (await themeNow($)).t) }
}

// After Claude touched files, or the disk watch looked: a clean buffer
// reloads, a dirty one gets the changed-on-disk bar. Our own saves move `baseMtime` along, so they pass.
const checkDisk = async ($: EngineInterface): Promise<void> => {
  const edit = (await read($, explorer)).edit
  if (edit === undefined || edit.baseMtime === undefined) return
  const stat = await statOf($, edit.path)
  if (stat === undefined || stat.mtimeMs === edit.baseMtime) return
  if (isEditDirty(edit)) {
    await patchEdit($, edit.version, { conflict: 'changed' })
  } else {
    resetEditing()
    await patchEdit($, edit.version, { version: edit.version + 1, baseMtime: undefined })
  }
}

// What session.end left for the process's next session (a `/clear`, a
// resume, a fork): the IDE's atoms as they were, all but the Settings sheet.
// Module-level: a reload in between drops it, and the store seeds instead.
type Stash = {
  explorer?: ExplorerState
  git?: GitState
  settings?: SettingsState
  sessionColor?: string
}
let stash: Stash | undefined

const takeStash = async ($: EngineInterface): Promise<Stash> => ({
  explorer: (await $.state.get({ plugin: 'ide-panes', key: 'explorer' } as const)).value,
  git: (await $.state.get({ plugin: 'ide-panes', key: 'git' } as const)).value,
  settings: (await $.state.get({ plugin: 'ide-panes', key: 'settings' } as const)).value,
  sessionColor: (await $.state.get({ plugin: 'ide-panes', key: 'sessionColor' } as const)).value,
})

// The session's atoms: on session.start (a start or a reload) from the
// session's own state, else the store's presets; on classic.SessionStart (a
// new session of this process, its state empty) `carried`, the last one's,
// wins over the store. Every get of one dispatch reads the same moment, so a
// read after a write here would not see it: each write is computed from what
// was read before it and from `carried`.
const seedSession = async ($: EngineInterface, carried?: Stash): Promise<void> => {
  if (carried?.git !== undefined) await $.state.set({ plugin: 'ide-panes', key: 'git' } as const, carried.git)
  const color = carried?.sessionColor
  if (color !== undefined) await update($, sessionColor, () => color)
  // Settings from an earlier session; a reload keeps the session's own.
  const held = await $.state.get({ plugin: 'ide-panes', key: 'settings' } as const)
  let settingsNow: SettingsState = carried?.settings ?? held.value ?? {}
  if (carried?.settings !== undefined) {
    await update($, settings, () => settingsNow)
  } else if (held.version === 0) {
    const stored = settingsOf(await $.store.get(SETTINGS_KEY))
    if (stored !== undefined) {
      await update($, settings, () => stored)
      settingsNow = stored
    }
  }
  // The keymap again, now over the Settings keys.
  const withSettings = mergeKeys(pluginOptions, settingsNow)
  keymap = withSettings.keymap
  keymapErrors = withSettings.errors
  const root = await $.session.root()
  const kept = carried?.explorer
  const saved = kept === undefined ? await $.store.get(modeKey(root)) : undefined
  // Sizes from an earlier session; a reload keeps the session's own.
  const layout = layoutOf(await $.store.get(LAYOUT_KEY), ['tree', 'panels']) as { tree?: number; panels?: number } | undefined
  await update($, explorer, now => {
    const s = kept ?? now
    const isSame = s.root === '' || s.root === root

    return {
      ...s,
      root,
      split: s.split ?? layout,
      // A carried view keeps its mode; a root with no mode saved takes the
      // Settings default.
      mode: kept !== undefined ? s.mode : isMode(saved) ? saved : (settingsNow.explorerMode ?? 'files'),
      expanded: isSame ? s.expanded : [],
      selected: isSame ? s.selected : undefined,
      cursor: isSame ? s.cursor : undefined,
      offset: isSame ? s.offset : 0,
      previewOffset: isSame ? (s.previewOffset ?? 0) : 0,
      previewLeft: isSame ? (s.previewLeft ?? 0) : 0,
      previewRaw: isSame ? s.previewRaw : undefined,
      // A reload, restart or new session: the editor asks for its text
      // again, and a draft newer than the file comes back with it (loadEdit).
      edit:
        s.edit === undefined
          ? undefined
          : { ...s.edit, version: s.edit.version + 1, confirm: undefined, pending: undefined },
    }
  })
  resetEditing()
  // A resumed session keeps its `/color`.
  await syncColor($)
}

// After Claude wrote `path`: its listing goes, an open editor on it checks
// the disk, and the panels redraw.
const afterFileTool = async ($: EngineInterface, path: string): Promise<void> => {
  dropFile(path)
  if (path === (await read($, explorer)).edit?.path) await checkDisk($)
  $.ui.invalidate('ui.render')
}

export const register = (on: On, options?: PluginOptions): void => {
  pluginOptions = options
  // The theme's sources are read again after a reload.
  resetThemeEnv()
  const merged = mergeKeys(options, undefined)
  keymap = merged.keymap
  keymapErrors = merged.errors
  const engines = parseEngines(typeof options?.previewEngines === 'string' ? options.previewEngines : '')
  customEngines = engines.engines
  engineErrors = engines.errors
  // A new config may change what a path previews as.
  customCache.clear()

  on('session.start', async ($, e, next) => {
    // A new session's state is unwritten; a reload (the same session) has it.
    const isNewSession = (await $.state.get({ plugin: 'ide-panes', key: 'explorer' } as const)).version === 0
    // The plugin's one command (one session.start hook per plugin).
    await $.command.register({
      name: 'ide-panels',
      description: 'Open every ide-panes pane (explorer and git)',
    })
    await seedSession($)
    // Bad `editorKeys` overrides are named once per load.
    if (keymapErrors.length > 0) await toast($, keymapErrors.join('; '))
    // So are bad `previewEngines` entries.
    if (engineErrors.length > 0) await toast($, engineErrors.join('; '))
    // Converted pictures older loads left behind (once per load).
    await sweepConverted($)
    const started = await next(e)
    if (isNewSession && e.isInteractive) await openOnStart($)

    return started
  })

  // A `/clear`, a resume or a fork goes on under a new session id, its
  // `$.state` empty, with no session.start: the IDE comes back as the last
  // session left it (session.end's stash), else from the store's presets.
  // `startup` is session.start's; `compact` keeps the session and its state.
  on('classic.SessionStart', async ($, e, next) => {
    if (e.source !== 'startup' && e.source !== 'compact') {
      const carried = stash
      stash = undefined
      await seedSession($, carried)
    }

    return next(e)
  })

  // The session's converted pictures go with it (a /clear ends the session
  // and no session.start follows, so the caches drawing them go too). The
  // whole chain shares one short bound: the rm gets what is left of it, so
  // the view is stashed first for the next session (classic.SessionStart).
  on('session.end', async ($, e, next) => {
    stash = await takeStash($)
    const left = next.budget.remainingMs
    await removeAllConverted($, Number.isFinite(left) ? Math.max(100, Math.min(2000, left - 200)) : 2000)
    // After the pictures: the closes find none left to remove.
    await closeOnExit($, e.reason)

    return next(e)
  })

  // Claude Code's `/config` theme changed: the panels follow it.
  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const done = await next(e)
    if ('value' in done && typeof done.value === 'string' && done.value !== themeEnv.ccTheme) {
      themeEnv.ccTheme = done.value
      $.ui.invalidate('ui.render')
    }

    return done
  })

  // Follow `/color` so the section frames match the prompt bar.
  on('command.run', { command: 'color' }, async ($, e, next) => {
    const ran = await next(e)
    // The answer names the color when the command prints it; otherwise (a
    // random pick, a panel) the transcript has it by now.
    const name = parseColorAnswer(ran.text ?? '')
    if (name !== undefined) await update($, sessionColor, () => name)
    else await syncColor($)
    $.ui.invalidate('ui.render')

    return ran
  })

  // Clear the caches after Claude changes files; never denies or rewrites the call.
  // One hook per tool: the validator refuses two unmatched tool.call hooks.
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    await afterFileTool($, e.file_path)

    return ran
  })

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)
    await afterFileTool($, e.file_path)

    return ran
  })

  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => {
    const ran = await next(e)
    await afterFileTool($, e.notebook_path)

    return ran
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    listings.clear()
    mdCache.clear()
    footers.clear()
    ignored.clear()
    unityRoots.clear()
    if (isIndexCommand(e.command)) indexes.clear()
    await checkDisk($)
    $.ui.invalidate('ui.render')

    return ran
  })

  // Opens the split pane, its width a share of the window's, measured here.
  on('command.run', { command: 'ide-panels' }, async ($, e) => {
    seat.windowColumns = e.presentation.columns
    // Kept for the next session's own opening, which has no width to go by.
    await $.store.set(WINDOW_KEY, e.presentation.columns)
    await openPanels($)

    return { text: 'Opened Explorer over Git.' }
  })

  // Closing the pane over unsaved text (the person, or another plugin) gets
  // the unsaved-changes bar instead; answering without `next` keeps it open.
  // Converted pictures go with the pane (a reload forgets them otherwise).
  on('ui.close', { id: [PANE, SPLIT_PANE] }, async ($, e, next) => {
    if (e.origin.kind !== 'unload' && (await guarded($, 'pane'))) return { value: undefined }
    await removeAllConverted($)

    return next(e)
  })

  // In the split pane Git's elements (keys `git/...`) are Git's hook's, beneath.
  on('ui.focus', { requestId: [PANE, SPLIT_PANE] }, async ($, e, next) => {
    const element = e.element
    if (e.requestId === SPLIT_PANE) splitFocus = gitKeyOf(element) === undefined ? 'explorer' : 'git'
    if (element !== undefined && element.startsWith('row:')) {
      const path = element.slice(4)
      const state = await read($, explorer)
      const root = await rootOf($, state)
      const rows = treeRowsOf(state, root)
      const win = windowOf(
        rows,
        rows.findIndex(row => row.path === path),
        treeRows,
        state.offset,
      )
      // The focus ring is the cursor; the selection moves only on Enter.
      if (state.cursor !== path || state.offset !== win.offset) {
        await update($, explorer, s => ({ ...s, cursor: path, offset: win.offset }))
      }
    }

    return next(e)
  })

  // Wheel: scrolls the section under the pointer, the selection stays. Keys:
  // an arrow moves the selection, a page key scrolls the preview. The engine's
  // own window is never used, so the hook always answers `{}` without `next`.
  // In the split pane the wheel below the seam, and the keys while Git's half
  // has them, are Git's hook's, beneath.
  on('ui.scroll', { requestId: [PANE, SPLIT_PANE] }, async ($, e, next) => {
    if (e.requestId === SPLIT_PANE && (e.pointer === undefined ? splitFocus === 'git' : e.pointer.row >= seat.gitTop)) {
      return next(e)
    }
    const state = await read($, explorer)
    const pointer = e.pointer
    // Over the Edit section the wheel and page keys scroll the editor.
    const isOverEdit = pointer === undefined ? Math.abs(e.by) !== 1 : pointer.column >= view.treeEnd
    if (view.isEditDrawn && isOverEdit) {
      sendCommand($, 'scroll', pointer === undefined ? Math.sign(e.by) * view.editRows : e.by)

      return {}
    }
    if (pointer !== undefined) {
      if (pointer.column < view.treeEnd) {
        const offset = clamp(state.offset + e.by, view.treeMax)
        if (offset !== state.offset) await update($, explorer, s => ({ ...s, offset }))
      } else {
        const was = state.previewOffset ?? 0
        const previewOffset = clamp(was + e.by, view.previewMax)
        if (previewOffset !== was) {
          await update($, explorer, s => ({ ...s, previewOffset }))
        }
      }
    } else if (Math.abs(e.by) === 1) {
      const root = await rootOf($, state)
      const rows = treeRowsOf(state, root)
      const at = rows.findIndex(row => row.path === (state.cursor ?? state.selected))
      const target = rows[clamp(at < 0 ? 0 : at + e.by, rows.length - 1)]
      if (target !== undefined && target.path !== state.cursor) {
        const win = windowOf(
          rows,
          rows.indexOf(target),
          treeRows,
          state.offset,
        )
        await update($, explorer, s => ({ ...s, cursor: target.path, offset: win.offset }))
        await $.ui.focus({ requestId: PANE, key: 'row:' + target.path })
      }
    } else {
      const was = state.previewOffset ?? 0
      const previewOffset = clamp(
        was + Math.sign(e.by) * view.previewRows,
        view.previewMax,
      )
      if (previewOffset !== was) {
        await update($, explorer, s => ({ ...s, previewOffset }))
      }
    }
    $.ui.invalidate('ui.render')

    return {}
  })

  // A scrollbar dragged: the window moves, the selection stays (as the wheel).
  on('ui.message', { requestId: [PANE, SPLIT_PANE] }, async ($, e, next) => {
    if (gitKeyOf(e.element) !== undefined) return next(e)
    if (e.element === 'editor') return editorMessage($, e.data, e.surface)
    if (e.element.startsWith('md:link:')) {
      // A link run of rendered markdown (link-client.tsx), pressed in the
      // drawing still shown (same file, same first row); else ignored.
      const data = e.data as { link?: unknown; path?: unknown; offset?: unknown } | null
      const i = data?.link
      const isShown = data?.path === mdShown.path && data.offset === mdShown.offset
      const hit = typeof i === 'number' && isShown ? mdShown.links[i] : undefined
      if (hit !== undefined) await followLink($, hit.href)

      return {}
    }
    if (e.element.startsWith('item:')) {
      // A tree row's Client (row-client.tsx): the arrow opens or closes a dir,
      // the name selects; a double-click is just a second click.
      const hit = (e.data as { hit?: unknown } | null)?.hit
      const row = await rowAt($, e.element.slice(5))
      if (row === undefined) return {}
      if (hit === 'arrow' && row.kind === 'dir') await toggle($, row.path)
      else if (hit === 'name' || hit === 'double') await press($, row)

      return {}
    }
    const data = e.data as { offset?: unknown; start?: unknown; delta?: unknown; done?: unknown } | null
    if (e.element === 'split:panels') {
      // The split pane's seam dragged: the Explorer's new height, kept as a
      // fraction of the rows both halves share.
      const { start, delta } = data ?? {}
      if (typeof start !== 'number' || typeof delta !== 'number') return {}
      if (!Number.isFinite(start) || !Number.isFinite(delta)) return {}
      if (view.splitRoom <= 0) return {}
      const fraction = dragTo(view.splitRoom, start, delta, MIN_HALF_ROWS)
      const after = await update($, explorer, s => ({ ...s, split: { ...s.split, panels: fraction } }))
      if (data?.done === true) await $.store.set(LAYOUT_KEY, after.split ?? {})
      $.ui.invalidate('ui.render')

      return {}
    }
    if (e.element === 'split:tree') {
      // The splitter dragged: Files' new width is where it started plus the
      // pointer's travel, kept as a fraction so a resize keeps it.
      const { start, delta } = data ?? {}
      if (typeof start !== 'number' || typeof delta !== 'number') return {}
      if (!Number.isFinite(start) || !Number.isFinite(delta)) return {}
      if (view.columns <= 0) return {}
      const fraction = dragTo(view.columns, start, delta, MIN_COLS)
      const after = await update($, explorer, s => ({ ...s, split: { ...s.split, tree: fraction } }))
      // The drag ended: the sizes outlive the session (mid-drag moves don't write).
      if (data?.done === true) await $.store.set(LAYOUT_KEY, after.split ?? {})
      $.ui.invalidate('ui.render')

      return {}
    }
    const to = typeof data?.offset === 'number' ? data.offset : NaN
    if (!Number.isFinite(to)) return {}
    if (e.element === 'sb:tree') {
      const offset = clamp(Math.round(to), view.treeMax)
      await update($, explorer, s => ({ ...s, offset }))
    } else if (e.element === 'sb:preview') {
      const previewOffset = clamp(Math.round(to), view.previewMax)
      await update($, explorer, s => ({ ...s, previewOffset }))
    } else if (e.element === 'hb:preview') {
      const previewLeft = clamp(Math.round(to), view.previewLeftMax)
      await update($, explorer, s => ({ ...s, previewLeft }))
    } else if (e.element === 'hb:edit') {
      // The client holds the editor's first column: it gets a `left` command.
      const hview = editing.hview
      if (hview === undefined) return {}
      const left = clamp(Math.round(to), editTotal(hview) - hview.width)
      // Shown at once, so the thumb does not snap back on release while the
      // client's own hview (which confirms it) is on its way.
      editing.hview = { ...hview, left }
      sendCommand($, 'left', left)
    } else {
      return {}
    }
    $.ui.invalidate('ui.render')

    return {}
  })

  // Its own pane, or the split pane: there Git's hook (beneath) draws the rows
  // below the seam, and this one the rows above it and the seam.
  on('ui.render', { component: 'Pane', requestId: [PANE, SPLIT_PANE] }, async ($, e, next) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button, Code } = elements
    const Client = 'Client' in elements ? elements.Client : undefined
    host = e.requestId === SPLIT_PANE ? SPLIT_PANE : PANE
    const isSplit = host === SPLIT_PANE
    // The window's width when no `/ide-panels` measured it this load.
    if (seat.windowColumns === 0 && e.viewport !== undefined) seat.windowColumns = e.viewport.columns
    const state = await read($, explorer)
    const fullRows = e.props.scroll.bodyRows
    // Outside a repo (the footer has no branch) Git's half keeps only its note.
    const isRepo = !isSplit || (await footerOf($, await rootOf($, state))).branch !== undefined
    const halves = splitRows(fullRows, state.split?.panels, isRepo)
    if (isSplit) {
      seat.gitTop = halves.gitTop
      seat.gitRows = halves.bottom
      view.splitRoom = Math.max(0, fullRows - 1)
    }
    const below = isSplit ? await next(e) : undefined
    // Claude Code's theme (its accent from `/color` while one is set).
    const { t, accentBorder } = await themeNow($)
    // The theme and the disk are followed while the panel is up.
    watchTheme($)
    watchDisk($)
    // The Settings values and sheet; the editor keymap follows the values
    // whichever panel's sheet changed them.
    const settingsNow = await read($, settings)
    const sheet = await read($, settingsUi)
    keymap = mergeKeys(pluginOptions, settingsNow).keymap
    // Selected rows and chrome fills: a Button label is the terminal's default
    // foreground, so fills are darkened.
    const sel = onDefaultFg(t.surfaceHover)
    const surface = e.surface
    // The Files icons: the choice (Settings, else by the terminal font) as this
    // surface draws it.
    const fileIcons = iconChoice(settingsNow.fileIcons, themeEnv.fonts)
    const icons = iconsFor(fileIcons, surface)
    const root = await rootOf($, state)
    const expanded = new Set(state.expanded)
    await Promise.all([root, ...expanded].map(dir => ensureListed($, dir)))
    const rows = flatten(listings, expanded, root, { mode: state.mode })
    const isNotUnity =
      state.mode === 'unity' && !(await isUnityProject($, root))
    const index = rows.findIndex(row => row.path === state.selected)
    const bodyRows = isSplit ? halves.top : fullRows
    // The Edit section stands in for Preview where a `Client` can draw it
    // (terminal and desktop; checked by name too, as the table may carry more).
    const canEdit = Client !== undefined && (e.surface === 'terminal' || e.surface === 'desktop')
    const edit = canEdit ? state.edit : undefined
    // What the interactive line holds, one question at a time.
    const ask = edit?.conflict !== undefined ? 'conflict' : edit?.confirm !== undefined ? 'unsaved' : undefined
    // Header lines (the title row with the panel tabs and the actions, its
    // right end kept for Settings; the interactive line while it asks),
    // then the bordered sections (2 rows of frame each).
    const headerRows = ask === undefined ? 1 : 2
    const sectionRows = Math.max(5, bodyRows - headerRows)
    const footer = await footerOf($, root)
    // Outside a repo, look for one appearing (a definite answer only, not an
    // aborted call's); once one has, Git's half is back at its 30%.
    if (footers.has(root)) {
      if (footer.branch === undefined) watchRepo($, root)
      else if (repoLess.delete(root) && state.split?.panels !== undefined) resetPanels($)
    }
    // Each section is framed in the theme's border color, or the `/color` accent.
    const border = { borderStyle: 'round', borderColor: accentBorder ? t.accent : t.border } as const
    // Rows inside a section's frame.
    const innerRows = sectionRows - 2
    treeRows = innerRows
    // The wheel moves the window off the selection, so it only clamps here.
    const win = windowOf(rows, -1, treeRows, state.offset)
    const current = index < 0 ? undefined : rows[index]
    const isUnity = state.mode === 'unity' && !isNotUnity
    const preview: Preview | undefined =
      edit !== undefined
        ? undefined
        : current === undefined
          ? undefined
          : await loadPreview($, current, isUnity, root, surface, state.previewRaw === true)
    // Reference section: a header line, up to `shown` refs and a "+n more"
    // line; Code gets the rest of the pane rows.
    const refs = preview?.type === 'code' ? preview.refs : []
    const shown =
      refs.length === 0
        ? 0
        : Math.min(refs.length, Math.max(1, Math.floor((innerRows - 1) / 2)))
    const hidden = refs.length - shown
    const refLines = refs.length === 0 ? 0 : 1 + shown + (hidden > 0 ? 1 : 0)
    // The focus ring starts on the cursor (else the selection). A row scrolled
    // out of the window is not focused: autoFocus would move the cursor to
    // whatever row the wheel brought in.
    const home = state.cursor ?? current?.path
    const focusKey =
      home === undefined
        ? win.rows[0]?.path
        : win.rows.some(row => row.path === home)
          ? home
          : undefined
    const previewRows = Math.max(1, innerRows - refLines)
    const treeCols = splitAt(e.props.bodyColumns, state.split?.tree ?? 0.35, MIN_COLS)
    const previewInner = Math.max(1, e.props.bodyColumns - treeCols - 2)
    // Rendered markdown: rows at Preview's inner columns less the vertical
    // bar, one Preview row each, so the total drives `sb:preview`, the wheel
    // and page keys as code lines do; they wrap, so no `hb:preview`.
    const md =
      preview?.type === 'markdown'
        ? await markdownView($, preview, Math.max(MIN_WIDTH, previewInner - 1), previewRows, surface, root)
        : undefined
    const previewTotal = md !== undefined ? md.rows.length : preview?.type === 'code' ? preview.lines.length : 0
    const previewOffset = clamp(state.previewOffset ?? 0, previewTotal - previewRows)
    view.columns = e.props.bodyColumns
    view.treeEnd = treeCols
    view.treeMax = Math.max(0, rows.length - treeRows)
    view.previewMax = Math.max(0, previewTotal - previewRows)
    view.previewRows = previewRows
    // Horizontal scroll: lines are cut at column `previewLeft` (Code and Text
    // have no column offset). The room is Preview's inner columns less the
    // vertical bar and, for Code, its line-number gutter: one space, the
    // widest shown number, one space (probed live on 2.1.289: ` 9 `, `  99 `
    // for 99-100). `total` measures every line, so a vertical scroll keeps the
    // thumb's size.
    const previewLines = preview === undefined || preview.type === 'image' || preview.type === 'markdown' ? [] : preview.lines
    const shownLast = preview?.type === 'code' ? Math.min(previewTotal, previewOffset + previewRows) : 0
    const gutter = preview?.type === 'code' ? String(Math.max(1, shownLast)).length + 2 : 0
    const previewWide =
      preview?.type === 'code'
        ? widestCached(preview.path + '\0' + preview.mtime + '\0' + preview.lines.length, preview.lines)
        : widest(previewLines)
    const previewVisible = Math.max(1, previewInner - 1 - gutter)
    view.previewLeftMax = Math.max(0, previewWide - previewVisible)
    const previewLeft = clamp(state.previewLeft ?? 0, view.previewLeftMax)
    view.editRows = innerRows
    view.editColumns = Math.max(1, e.props.bodyColumns - view.treeEnd - 2)
    view.isEditDrawn = edit !== undefined
    // An image: the picture fitted to Preview's inner room less its info row
    // (no scrollbars). The terminal draws the PNG file (`Image`) unless the
    // blit probe found it draws only alts; remote surfaces draw an `.svg`'s
    // text (`Svg`); anything else is metadata and the note saying why.
    const Image = 'Image' in elements ? elements.Image : undefined
    const Svg = 'Svg' in elements ? elements.Svg : undefined
    const image = preview?.type === 'image' ? preview : undefined
    const imageRows = Math.max(1, innerRows - 1)
    const imageCols = Math.max(1, previewInner)
    const imageCells =
      image === undefined
        ? undefined
        : fitCells(
            imageCols,
            imageRows,
            image.width !== undefined && image.height !== undefined && image.height > 0
              ? image.width / image.height
              : (imageCols * CELL_W) / (imageRows * CELL_H),
          )
    const imageSource =
      image?.png !== undefined && image.note === undefined && imageProbe !== 'alt' && Image !== undefined && surface === 'terminal'
        ? { file: image.png, format: 'png' as const, generation: image.mtime }
        : undefined
    if (imageSource !== undefined) probeImage($, imageSource)
    const imageSvg = image?.svg !== undefined && Svg !== undefined ? image.svg : undefined
    const imageText = image === undefined ? '' : imageInfo(formatSize(image.bytes), image.width, image.height)
    // Rendered markdown's window. A link draws as a `Link` where isLinkable
    // says so; every other link is underlined accent text, pressable on
    // terminal and desktop through a `Client` laid over it (`md:link:<i>`).
    const Link = 'Link' in elements ? elements.Link : undefined
    const mdWindow: ViewRow[] = md === undefined ? [] : md.rows.slice(previewOffset, previewOffset + previewRows)
    const isTableRow = (row: ViewRow): boolean => row.kind === 'text' && row.table === true
    const isLinkHere = (href: string, row: ViewRow): boolean => Link !== undefined && isLinkable(href, surface, isTableRow(row))
    const canPressLinks = Client !== undefined && (surface === 'terminal' || surface === 'desktop')
    const mdLinks = md === undefined || !canPressLinks ? [] : linkHits(mdWindow, (href, row) => !isLinkHere(href, row))
    if (preview?.type === 'markdown' && md !== undefined) {
      mdShown.path = preview.path
      mdShown.anchors = md.anchors
      mdShown.links = mdLinks
      mdShown.offset = previewOffset
    }
    const roleColor = (role: Role | undefined): string => (role === undefined || role === 'text' ? t.text : t[role])
    const spanEl = (span: Span, k: string, row: ViewRow) => {
      const style = span.style ?? {}
      const text = cleanText(span.text)
      if (style.href !== undefined && Link !== undefined && isLinkHere(style.href, row)) {
        return (
          <Link key={k} href={style.href}>
            {text}
          </Link>
        )
      }

      return (
        <Text
          key={k}
          color={roleColor(style.color)}
          {...(style.background === undefined ? {} : { backgroundColor: style.background === 'surface' ? t.surface : t.warning })}
          bold={style.bold === true}
          italic={style.italic === true}
          underline={style.underline === true || style.href !== undefined}
          strikethrough={style.strike === true}
          inverse={style.inverse === true}
          dimColor={style.dim === true}
        >
          {text}
        </Text>
      )
    }
    // ' ' for an empty row: an empty Text takes no row.
    const spansRow = (spans: Span[], k: string, row: ViewRow) =>
      spans.length === 0 || spans.every(span => span.text === '') ? (
        <Text key={k}> </Text>
      ) : (
        <Text key={k} wrap="truncate-end">
          {spans.map((span, i) => spanEl(span, k + '.' + i, row))}
        </Text>
      )
    // The window's rows as elements: a text row one Text; the rows of one code
    // block one Code (its prefix a column before it); a picture wholly inside
    // the window one Image, else its `🖼 alt` row and blank rows.
    const markdownRows = (rowsShown: ViewRow[], base: number): RenderChildren[] => {
      const out: RenderChildren[] = []
      let i = 0
      while (i < rowsShown.length) {
        const row = rowsShown[i]!
        const k = 'md:' + (base + i)
        if (row.kind === 'text') {
          out.push(spansRow(row.spans, k, row))
          i += 1
        } else if (row.kind === 'image') {
          out.push(spansRow([...row.prefix, { text: '🖼 ' + (row.alt || row.src), style: { color: 'muted', italic: true } }], k, row))
          i += 1
        } else if (row.kind === 'picture') {
          let j = i
          while (j < rowsShown.length) {
            const later = rowsShown[j]!
            if (later.kind !== 'picture' || later.at !== row.at) break
            j += 1
          }
          const hasPrefix = row.prefix.some(span => span.text !== '')
          if (row.part === 0 && j - i === row.rows && Image !== undefined && surface === 'terminal') {
            const key = 'md:image:' + row.at
            const source = { file: row.png, format: 'png' as const, generation: row.mtime }
            probeImage($, source, key)
            out.push(
              <Box key={k} flexDirection="row" height={row.rows}>
                {hasPrefix && (
                  <Box flexDirection="column" flexShrink={0}>
                    {Array.from({ length: row.rows }, (_, n) => spansRow(row.prefix, k + 'p' + n, row))}
                  </Box>
                )}
                <Image key={key} source={source} columns={row.columns} rows={row.rows} alt={row.alt || nameOf(row.src)} />
              </Box>,
            )
          } else {
            for (let n = i; n < j; n++) {
              const part = rowsShown[n]!
              const label: Span[] =
                n === i ? [{ text: '🖼 ' + (row.alt || row.src), style: { color: 'muted', italic: true } }] : []
              out.push(spansRow([...row.prefix, ...label], 'md:' + (base + n), part))
            }
          }
          i = j
        } else {
          let j = i
          while (j < rowsShown.length) {
            const later = rowsShown[j]!
            if (later.kind !== 'code' || later.block !== row.block) break
            j += 1
          }
          const group = rowsShown.slice(i, j) as Extract<MdRow, { kind: 'code' }>[]
          const prefixKey = (prefix: Span[]) => JSON.stringify(prefix)
          const isSamePrefix = group.every(g => prefixKey(g.prefix) === prefixKey(row.prefix))
          const language = row.lang === '' ? undefined : row.lang
          const code = (source: string, ck: string) => (
            <Code key={ck} source={cleanText(source) || ' '} {...(language === undefined ? {} : { language })} wrap="truncate-end" />
          )
          if (isSamePrefix) {
            const hasPrefix = row.prefix.some(span => span.text !== '')
            out.push(
              <Box key={k} flexDirection="row">
                {hasPrefix && (
                  <Box flexDirection="column" flexShrink={0}>
                    {group.map((g, n) => spansRow(g.prefix, k + 'p' + n, g))}
                  </Box>
                )}
                <Box flexDirection="column" flexGrow={1}>
                  {/* Several Codes when the rows pass Code's 10000 characters,
                      one row per line still. */}
                  {codeChunks(group.map(g => cleanText(g.text))).map((lines, n) => code(lines.join('\n'), k + 'c' + (n === 0 ? '' : n)))}
                </Box>
              </Box>,
            )
          } else {
            group.forEach((g, n) =>
              out.push(
                <Box key={k + '.' + n} flexDirection="row">
                  <Box flexShrink={0}>{spansRow(g.prefix, k + '.' + n + 'p', g)}</Box>
                  {code(g.text, k + '.' + n + 'c')}
                </Box>,
              ),
            )
          }
          i = j
        }
      }

      return out
    }
    // A rendered engine's view chip: its source through the code preview, and back.
    // Not over metadata (too big, binary): there is nothing to flip; the
    // source view always keeps it, so there is a way back.
    const viewEngine = current?.kind === 'file' && edit === undefined ? engineOf(current.name, customEngines) : 'code'
    const isRaw = state.previewRaw === true
    const hasView = hasSourceView(viewEngine) && (isRaw || preview?.type === 'markdown' || preview?.type === 'image')
    // A Client on the seam, two cells across: the first section's last column
    // and the second's first (both frames' borders), so the seam takes a grab
    // from either side. Drawn last in the container holding both sections, so
    // it paints over both borders; `left`/`top` are relative to that container
    // and name the first section's border. `length` stops short of the frames'
    // corners. Surfaces without `Client` keep the plain borders. Keep in sync
    // with git's `splitter`.
    const splitter = (
      key: 'split:tree',
      axis: 'x' | 'y',
      left: number,
      top: number,
      length: number,
      cells: number,
    ) =>
      Client === undefined ? null : (
        <Box position="absolute" top={top} left={left}>
          <Client
            key={key}
            module="../shared/splitter-client.tsx"
            props={{ axis, length, cells, span: 2, color: border.borderColor }}
            width={axis === 'x' ? 2 : length}
            height={axis === 'x' ? length : 2}
          />
        </Box>
      )
    const bar = (cells: string[]) => (
      <Box flexDirection="column" width={1} flexShrink={0}>
        {cells.map((cell, i) => (
          <Text key={'bar:' + i} color={cell === THUMB ? t.accent : t.muted}>
            {cell}
          </Text>
        ))}
      </Box>
    )

    // Draggable on surfaces that draw a `Client`, the Text column elsewhere.
    const dragBar = (key: string, total: number, rows: number, offset: number) =>
      Client === undefined || total <= rows ? (
        bar(scrollbar(total, rows, offset, rows))
      ) : (
        <Client
          key={key}
          module="../shared/scrollbar-client.tsx"
          props={{ total, visible: rows, offset, height: rows, color: t.accent }}
          width={1}
          height={rows}
        />
      )

    // A horizontal scrollbar laid over the section's bottom border (no row of
    // its own), only while the content is wider than the room. Like the title,
    // it sits after the bordered Box in the unbordered wrapper; `left={1}`
    // skips the corner and `width` stops short of the far one. Draggable on
    // surfaces that draw a `Client`, a static Text row elsewhere. The engine's
    // wheel has no horizontal axis, so dragging is the only way to scroll.
    const hbar = (key: string, total: number, visible: number, offset: number, width: number) => {
      if (total <= visible || width <= 0) return null

      return (
        <Box position="absolute" top={sectionRows - 1} left={1}>
          {Client === undefined ? (
            <Box flexDirection="row" height={1}>
              {scrollbar(total, visible, offset, width, { thumb: H_THUMB, track: H_TRACK }).map((cell, i) => (
                <Text key={'hbar:' + i} color={cell === H_THUMB ? t.accent : t.muted}>
                  {cell}
                </Text>
              ))}
            </Box>
          ) : (
            <Client
              key={key}
              module="../shared/scrollbar-client.tsx"
              props={{ axis: 'x', total, visible, offset, height: width, color: t.accent }}
              width={width}
              height={1}
            />
          )}
        </Box>
      )
    }

    // The section's name sits on its top border. A bordered Box clips its
    // children, so the title is an absolute Box after it, at top={0}, in an
    // unbordered wrapper of the same size: a label (default foreground) on an
    // accent-tinted fill, pressing it does nothing. `mark` (Edit's unsaved `●`)
    // is a warning-colored Text on the border before it.
    const titled = (key: string, name: string, mark?: string) => (
      <Box position="absolute" top={0} left={1} flexDirection="row">
        {mark !== undefined && <Text color={t.warning}>{mark}</Text>}
        <Box key={key + ':chrome'} backgroundColor={onDefaultFg(t.accent)}>
          <Text key={key}>{' ' + name + ' '}</Text>
        </Box>
      </Box>
    )

    // A small Button on a frame's top border, as the title: its own label on a
    // tinted fill (accent for the main action, the selection fill otherwise).
    const edgeButton = (key: string, label: string, isMain: boolean, onPress: () => void) => (
      <Box key={key + ':chrome'} backgroundColor={isMain ? onDefaultFg(t.accent) : sel}>
        <Button key={key} plain label={' ' + label + ' '} onPress={onPress} />
      </Box>
    )

    // The interactive line's question, a compact alert: a tone-colored strip
    // and icon, the text cut at the end, its Buttons in the right corner.
    const askLine = (color: string, icon: string, text: string, buttons: RenderChildren) => (
      <Box key="header:ask" flexDirection="row" justifyContent="space-between" gap={1} backgroundColor={t.surface}>
        <Box flexDirection="row" flexShrink={1}>
          <Text color={color}>{'▌' + icon + ' '}</Text>
          <Text color={color} wrap="truncate-end">
            {text}
          </Text>
        </Box>
        <Box flexDirection="row" gap={1} flexShrink={0}>
          {buttons}
        </Box>
      </Box>
    )

    // While the sheet is up the panel's own Buttons do nothing: a press is dropped.
    const asleep =
      <A extends unknown[]>(act: (...args: A) => unknown) =>
      (...args: A): void => {
        if (sheet.open !== host) void act(...args)
      }
    // A one-row `Btn` of the theme.
    const btn = (
      key: string,
      label: string,
      variant: 'primary' | 'secondary' | 'ghost' | 'danger',
      onPress: () => void,
    ) => Btn(elements, t, { key, label, variant, surface, onPress: asleep(onPress) })

    // The Settings sheet, drawn last over the pane below the title row (in the
    // split pane over both halves).
    const sheetTree =
      sheet.open === host
        ? SettingsSheet(elements, t, {
            surface,
            cols: e.props.bodyColumns,
            rows: fullRows,
            settings: settingsNow,
            keymap: keymapNameOf(pluginOptions, settingsNow),
            fileIcons,
            keys: sheet.keys ?? settingsNow.keys ?? '',
            keysError: sheet.keysError,
            onChange: patch => void changeSettings($, patch),
            onKeys: text => void settingsKeys($, text),
            onResetLayout: () => void resetLayout($),
            onDone: () => void settingsDone($),
            onCancel: () => void settingsCancel($),
          })
        : undefined

    const own = (
      <Box flexDirection="column" width="100%" minHeight={bodyRows} backgroundColor={t.canvas}>
        {/* The title row: the title, the panel tabs and the actions (only
            while a row is selected), 2 cells apart with a divider after the
            title and before the actions, cut at the right end on a narrow pane
            (kept for Settings). The active
            tab does nothing (a mode switch would close a clean editor and
            reset the scroll). */}
        <Box key="header" flexDirection="row" justifyContent="space-between" alignItems="center" height={1}>
          <Box key="header:tabs" flexDirection="row" gap={2} flexShrink={1} overflow="hidden">
            <Box flexShrink={0}>
              <Text bold color={t.text}>
                {' Explorer'}
              </Text>
            </Box>
            <Box flexShrink={0}>
              <Text color={t.border}>|</Text>
            </Box>
            <Box flexShrink={0}>
              {Tabs(elements, t, {
                gap: 2,
                surface,
                tabs: [
                  { id: 'files', label: 'Files' },
                  { id: 'unity', label: 'Unity' },
                ],
                selected: state.mode,
                onSelect: asleep((id: string) => (id === state.mode || !isMode(id) ? undefined : void setMode($, id))),
              })}
            </Box>
            {current !== undefined && (
              <Box flexShrink={0}>
                <Text color={t.border}>|</Text>
              </Box>
            )}
            {current !== undefined && (
              <Box key="header:actions" flexDirection="row" gap={2} flexShrink={0}>
                {canEdit &&
                  edit === undefined &&
                  (preview?.type === 'code' || preview?.type === 'markdown') &&
                  preview.generated !== true &&
                  btn('edit', 'Edit', 'secondary', () => void startEdit($, preview.path))}
                {btn('copy-name', 'Copy Name', 'ghost', () => void copyText($, nameOf(state.cursor ?? current.path), surface))}
                {btn('copy-path', 'Copy Full Path', 'ghost', () => void copyText($, state.cursor ?? current.path, surface))}
              </Box>
            )}
            {isNotUnity && (
              <Box flexShrink={0}>
                <Text color={t.muted}>not a Unity project</Text>
              </Box>
            )}
          </Box>
          <Box flexShrink={0}>
            {PaneButtons(elements, t, {
              surface,
              isOpen: sheet.open === host,
              onSettings: () => void toggleSettings($),
            })}
          </Box>
        </Box>
        {/* The interactive line, only while something asks: the question on
            the left, its Buttons in the right corner. */}
        {ask === 'conflict' && edit?.conflict !== undefined
          ? askLine(
              t.warning,
              '⚠',
              (edit.conflict === 'disk' ? 'Changed on disk since loaded: ' : 'Changed on disk while open: ') +
                nameOf(edit.path),
              [
                btn('ask:overwrite', 'Overwrite', 'danger', () => sendCommand($, 'overwrite')),
                btn('ask:reload', 'Reload', 'primary', () => void reloadEdit($)),
                btn('ask:cancel', 'Cancel', 'ghost', () => void patchEdit($, edit.version, { conflict: undefined })),
              ],
            )
          : ask === 'unsaved' && edit !== undefined
            ? askLine(t.warning, '⚠', 'Unsaved changes in ' + nameOf(edit.path), [
                btn('ask:save', 'Save', 'primary', () => sendCommand($, 'save')),
                btn('ask:discard', 'Discard', 'danger', () => void discard($)),
                btn(
                  'ask:cancel',
                  'Cancel',
                  'ghost',
                  () => void patchEdit($, edit.version, { confirm: undefined, pending: undefined }),
                ),
              ])
            : undefined}
        <Box flexDirection="row">
          <Box flexDirection="column" width={treeCols} flexShrink={0} height={sectionRows}>
          <Box {...border} flexDirection="row" height="100%">
            <Box flexDirection="column" flexGrow={1}>
            {rows.length === 0 && <Text color={t.muted}>(empty)</Text>}
            {win.rows.map(row => {
              // Selection bar, a rail per depth level, the dir arrow, then
              // the name. Where a `Client` draws (terminal, desktop) the row is
              // one (row-client.tsx: every click and the arrow)
              // and a blank 1-cell Button after it carries the keyboard ring.
              // Elsewhere: Texts, the arrow a Button of its own, the name a
              // Button (a Button has no color, so the arrow can't be in it).
              const isSelected = row.path === state.selected
              const isIgnored = ignored.has(row.path)
              // `+` added, `*` edited (a dir: something under it), after the name.
              const change = footer.branch === undefined ? undefined : markOf(row.path, footer.marks)
              const changeColor = change === '+' ? t.success : t.warning
              // The kind's icon and a space before the name (Settings `fileIcons`).
              const icon = iconOf(row.name, row.kind, row.isExpanded, icons)
              const iconColor = icon === undefined || isIgnored ? t.muted : t[icon.role]
              // The row's room: frame (2) and vertical bar (1).
              const room = treeCols - 2 - 1
              const label = (cells: number) =>
                // the name's room past the bar, rails, arrow, icon and change
                // mark; no horizontal scroll in list sections, so a long name is cut
                fitLabel(
                  row.kind === 'dir' ? row.name + '/' : row.name,
                  Math.max(3, cells - 1 - 2 * row.depth - 2 - (icon === undefined ? 0 : 2) - (change === undefined ? 0 : 2)),
                )
              const arrow = row.kind === 'dir' ? (row.isExpanded ? '▾ ' : '▸ ') : '  '
              if (canEdit && Client !== undefined) {
                return (
                  <Box key={'line:' + row.path} flexDirection="row" backgroundColor={isSelected ? sel : undefined}>
                    <Client
                      key={'item:' + row.path}
                      module="./row-client.tsx"
                      props={{
                        depth: row.depth,
                        kind: row.kind,
                        isExpanded: row.isExpanded,
                        isSelected,
                        // the ring is on the blank cell: the name shows where
                        // it is when it has left the selection
                        isCursor: state.cursor === row.path && state.cursor !== state.selected,
                        isIgnored,
                        label: label(room - 1),
                        ...(icon === undefined ? {} : { icon: { glyph: icon.glyph, color: iconColor } }),
                        ...(change === undefined ? {} : { change }),
                        colors: { accent: t.accent, border: t.border, muted: t.muted, selection: sel, change: changeColor },
                      }}
                      width={Math.max(1, room - 1)}
                      height={1}
                    />
                    <Button
                      key={'row:' + row.path}
                      plain
                      label=" "
                      autoFocus={row.path === focusKey ? true : undefined}
                      onPress={() => press($, row, true)}
                    />
                  </Box>
                )
              }

              return (
                <Box
                  key={'line:' + row.path}
                  flexDirection="row"
                  backgroundColor={isSelected ? sel : undefined}
                >
                  <Text color={t.accent}>{isSelected ? '▌' : ' '}</Text>
                  {row.depth > 0 && <Text color={t.border}>{'│ '.repeat(row.depth)}</Text>}
                  {row.kind === 'dir' ? (
                    <Button key={'arrow:' + row.path} plain label={arrow} onPress={() => toggle($, row.path)} />
                  ) : (
                    <Text color={isIgnored ? t.muted : t.accent}>{arrow}</Text>
                  )}
                  {icon !== undefined && <Text color={iconColor}>{icon.glyph + ' '}</Text>}
                  <Button
                    key={'row:' + row.path}
                    plain
                    dimColor={isIgnored}
                    autoFocus={row.path === focusKey ? true : undefined}
                    label={label(room)}
                    onPress={() => press($, row)}
                  />
                  {change !== undefined && <Text color={changeColor}>{' ' + change}</Text>}
                </Box>
              )
            })}
            </Box>
            {dragBar('sb:tree', rows.length, treeRows, win.offset)}
          </Box>
          {titled('title:files', 'Files')}
          </Box>
          {edit !== undefined && Client !== undefined ? (
            <Box flexDirection="column" flexGrow={1} height={sectionRows}>
            <Box {...border} flexDirection="row" height="100%" flexGrow={1}>
              <Client
                key="editor"
                module="./editor-client.tsx"
                props={editorProps(edit, t)}
                height={innerRows}
                flexGrow={1}
              />
            </Box>
            {/* The client holds the first column; it reports the view. No
                vertical bar here, so the bar spans all the inner columns. */}
            {editing.hview !== undefined &&
              editing.version === edit.version &&
              hbar('hb:edit', editTotal(editing.hview), editing.hview.width, editing.hview.left, view.editColumns)}
            {titled('title:edit', 'Edit', isEditDirty(edit) ? '●' : undefined)}
            {/* Line actions for terminals that do not report their chords. */}
            <Box position="absolute" top={0} right={1} flexDirection="row" gap={1}>
              {edgeButton('edit:save', 'Save', true, () => sendCommand($, 'save'))}
              {edgeButton('edit:close', 'Close', false, () => void closeEdit($))}
              {EDIT_COMMANDS.map(([label, command]) => edgeButton('edit:' + command, label, false, () => sendCommand($, command)))}
            </Box>
            </Box>
          ) : (
          <Box flexDirection="column" flexGrow={1} height={sectionRows}>
          <Box {...border} flexDirection="row" height="100%" flexGrow={1}>
            <Box flexDirection="column" flexGrow={1}>
            {preview === undefined && <Text color={t.muted}>Select a file.</Text>}
            {preview?.type === 'text' &&
              // ' ' for a line scrolled past its end: an empty Text takes no row
              preview.lines.map(line => (
                <Text color={t.text} wrap="truncate-end">
                  {sliceCols(line, previewLeft) || ' '}
                </Text>
              ))}
            {preview?.type === 'code' && (
              <Code
                source={clip(
                  preview.lines
                    .slice(previewOffset, previewOffset + previewRows)
                    .map(line => sliceCols(line, previewLeft))
                    .join('\n'),
                  previewRows,
                )}
                path={preview.path}
                language={preview.language}
                startLine={previewOffset + 1}
                wrap="truncate-end"
              />
            )}
            {md !== undefined && markdownRows(mdWindow, previewOffset)}
            {refs.length > 0 && (
              <Text bold color={t.accent}>
                References ({refs.length})
              </Text>
            )}
            {refs.slice(0, shown).map(ref =>
              ref.kind === 'resolved' ? (
                <Button
                  key={'ref:' + ref.path}
                  plain
                  label={ref.path.startsWith(root + '/') ? ref.path.slice(root.length + 1) : ref.path}
                  onPress={() => jump($, ref.path)}
                />
              ) : (
                <Text color={t.muted} wrap="truncate-end">
                  {ref.guid} {ref.kind === 'builtin' ? 'Unity built-in' : 'package or missing'}
                </Text>
              ),
            )}
            {hidden > 0 && <Text color={t.muted}>+{hidden} more</Text>}
            {image !== undefined &&
              (imageSource !== undefined && Image !== undefined && imageCells !== undefined ? (
                <Box flexDirection="column" alignItems="center">
                  <Image
                    key={IMAGE_KEY}
                    source={imageSource}
                    columns={imageCells.columns}
                    rows={imageCells.rows}
                    alt={nameOf(image.path) + ' (' + imageText + ')'}
                  />
                  <Text color={t.muted} wrap="truncate-end">
                    {imageText}
                  </Text>
                </Box>
              ) : imageSvg !== undefined && Svg !== undefined ? (
                <Box flexDirection="column" alignItems="center">
                  {/* At most the room under the info row (SVG_ROW_PX a row),
                      never taller than the markup's own height. */}
                  <Svg
                    key={IMAGE_KEY}
                    source={imageSvg}
                    alt={nameOf(image.path)}
                    height={Math.min(image.height ?? Infinity, imageRows * SVG_ROW_PX)}
                  />
                  <Text color={t.muted} wrap="truncate-end">
                    {imageText}
                  </Text>
                </Box>
              ) : (
                <Box flexDirection="column">
                  <Text color={t.text} wrap="truncate-end">
                    {nameOf(image.path)}
                  </Text>
                  <Text color={t.muted} wrap="truncate-end">
                    {imageText}
                  </Text>
                  <Text color={t.muted} wrap="truncate-end">
                    {'modified ' + new Date(image.mtime).toISOString()}
                  </Text>
                  {image.note !== undefined && (
                    <Text color={t.warning} wrap="truncate-end">
                      {image.note}
                    </Text>
                  )}
                </Box>
              ))}
            </Box>
            {image === undefined && dragBar('sb:preview', previewTotal, previewRows, previewOffset)}
          </Box>
          {titled('title:preview', 'Preview')}
          {/* Link runs pressable through a Client, laid over their Text
              (past the frame's top-left corner). */}
          {Client !== undefined &&
            mdLinks.map((hit, i) => (
              <Box key={'md:link:' + i + ':at'} position="absolute" top={1 + hit.y} left={1 + hit.x}>
                <Client
                  key={'md:link:' + i}
                  module="./link-client.tsx"
                  props={{
                    i,
                    path: mdShown.path,
                    offset: previewOffset,
                    color: t.accent,
                    segments: hit.spans.map(span => ({
                      text: cleanText(span.text),
                      ...(span.style?.bold === true ? { bold: true } : {}),
                      ...(span.style?.italic === true ? { italic: true } : {}),
                      ...(span.style?.strike === true ? { strike: true } : {}),
                    })),
                  }}
                  width={hit.width}
                  height={1}
                />
              </Box>
            ))}
          {image === undefined && md === undefined && hbar('hb:preview', previewWide, previewVisible, previewLeft, previewInner - 1)}
          {/* A rendered engine's source view and back. */}
          {hasView && (
            <Box position="absolute" top={0} right={1} flexDirection="row">
              {edgeButton(
                'preview:view',
                isRaw ? 'Rendered' : 'Source',
                false,
                asleep(() =>
                  void update($, explorer, s => ({ ...s, previewRaw: s.previewRaw === true ? undefined : true, previewOffset: 0, previewLeft: 0 })),
                ),
              )}
            </Box>
          )}
          </Box>
          )}
          {splitter('split:tree', 'x', treeCols - 1, 1, sectionRows - 2, treeCols)}
        </Box>
        {!isSplit && sheetTree}
      </Box>
    )
    if (!isSplit) return own

    // The split pane: the Explorer, the seam (dragged up and down where a
    // Client draws, and Git has a repo to show), then Git's half as its hook
    // drew it.
    const cols = e.props.bodyColumns

    return (
      <Box flexDirection="column" width="100%" height={fullRows} backgroundColor={t.canvas}>
        <Box key="split:explorer" flexDirection="column" height={halves.top} flexShrink={0}>
          {own}
        </Box>
        {Client === undefined || !isRepo ? (
          <Text key="split:seam" color={border.borderColor}>
            {'─'.repeat(Math.max(1, cols))}
          </Text>
        ) : (
          <Client
            key="split:panels"
            module="../shared/splitter-client.tsx"
            props={{ axis: 'y', length: cols, cells: halves.top, span: 1, color: border.borderColor }}
            width={cols}
            height={1}
          />
        )}
        <Box key="split:git" flexDirection="column" height={halves.bottom} flexShrink={0}>
          {below}
        </Box>
        {sheetTree}
      </Box>
    )
  })
}
