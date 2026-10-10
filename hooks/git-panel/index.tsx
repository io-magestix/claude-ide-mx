import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, RenderElement } from 'claude-code'

import type { GitState, SettingsState, SettingsUi } from '../../types'
import { iconChoice } from '../explorer-panel/icons'
import { window as windowOf } from '../explorer-panel/tree'
import { sliceCols, sliceDiffCols, widest } from '../shared/hscroll'
import { H_THUMB, H_TRACK, THUMB, clamp, scrollbar } from '../shared/scrollbar'
import { DEFAULTS, SETTINGS_KEY, keymapNameOf, keysError, resolveTheme, withGitDefaults } from '../shared/settings'
import { PaneButtons, SettingsSheet } from '../shared/settings-sheet'
import { THEME_POLL_MS, parseTabbyFonts, parseTabbyScheme, tabbyConfigPaths, themeEnv } from '../shared/term-theme'
import { dragTo, layoutOf, splitAt } from '../shared/split'
import { GIT_PREFIX, SPLIT_PANE, gitKeyOf, prefixKeys, seat } from '../shared/layout'
import { Badge, Btn, Tabs, onDefaultFg } from '../shared/ui'
import { glyphColor, lanePalette } from './git-theme'
import {
  GIT_PANE,
  branchTree,
  headNameArgv,
  headRefArgv,
  refsArgv,
  copyTextOf,
  remoteArgv,
  remoteSummary,
  shortDir,
  branchesArgv,
  changeCounts,
  changeDiffArgv,
  changeGlyph,
  changeRows,
  toggled,
  cellRuns,
  changeWords,
  fileDiff,
  filesArgv,
  DIFF_COLS,
  fitStart,
  graphColumns,
  maxLanesFor,
  isUntracked,
  diffBody,
  diffGutter,
  diffLines,
  infoHead,
  containsArgv,
  layoutGraph,
  logArgv,
  parseContains,
  PALETTE_SIZE,
  parseBranches,
  parseLog,
  parseNameStatus,
  patchArgv,
  parseStatus,
  sliceDiff,
  splitShow,
  statArgv,
  statusArgv,
  trackLabel,
} from './git'
import type { Branch, BranchRow, Change, ChangeRow, Commit, Contains, GraphRow, RemoteAction } from './git'

type On = Parameters<Register>[0]

// The `/color` of this session; set by the explorer's hooks.
const sessionColor = atom<'ide-panes', 'sessionColor'>(
  { plugin: 'ide-panes', key: 'sessionColor' } as const,
  '',
)
// The Settings values; the explorer's session.start seeds them.
const settings = atom<'ide-panes', 'settings'>(
  { plugin: 'ide-panes', key: 'settings' } as const,
  {} satisfies SettingsState,
)
// The Settings sheet while it is up; session only.
const settingsUi = atom<'ide-panes', 'settingsUi'>(
  { plugin: 'ide-panes', key: 'settingsUi' } as const,
  {} satisfies SettingsUi,
)
const PANE = GIT_PANE

// Where Git is drawn: its own pane or the split pane's bottom half,
// its keys prefixed `git/`. Set by each drawing.
let host: typeof PANE | typeof SPLIT_PANE = PANE

// Moves the keyboard ring onto one of Git's elements, wherever it is drawn.
const focusGit = ($: EngineInterface, key: string) =>
  $.ui.focus({ requestId: host, key: host === SPLIT_PANE ? GIT_PREFIX + key : key })

// Each side of a splitter keeps at least this many columns / rows.
const MIN_COLS = 12
const MIN_ROWS = 4
// Pane body columns from which Branches takes its narrower (wide) fraction.
const WIDE = 140
// Default split fractions: Branches' width (`sideWide` from WIDE columns, else
// `sideNarrow`), Info's share of the Overview's right column, Files' width in
// Change Log, Info's share under Graph. Each is applied in one place in the
// render hook.
const SPLIT = { sideWide: 0.2, sideNarrow: 0.3, info: 0.4, files: 0.3, graph: 0.35 } as const

type Tab = 'overview' | 'graph' | 'changelog'

// An old persisted `'changes'` is Change Log; any other unknown value, Overview.
const tabOf = (s: GitState): Tab => {
  const tab = s.tab as string | undefined

  return tab === 'changes' || tab === 'changelog'
    ? 'changelog'
    : tab === 'graph'
      ? 'graph'
      : 'overview'
}

const git = atom<'ide-panes', 'git'>(
  { plugin: 'ide-panes', key: 'git' } as const,
  { ref: 'all', offset: 0, branchOffset: 0, detailOffset: 0 } satisfies GitState,
)

// The git state as drawn: the Settings defaults where it has none (the tab,
// `limit` until paged).
const gitNow = async ($: EngineInterface) => withGitDefaults(await read($, git), await read($, settings))

// register's options (userConfig): the keymap preset the sheet shows while
// the Settings have none.
let pluginOptions: PluginOptions | undefined

// The Settings sheet (shared/settings-sheet.tsx): the explorer keeps the same
// handlers in its own file, as the validator follows `$` only within one file.

// The Settings Button: opens the sheet here (from the other pane's sheet it moves, keeping
// what was changed); on the open sheet it is `done`.
const toggleSettings = async ($: EngineInterface): Promise<void> => {
  const ui = await read($, settingsUi)
  if (ui.open === PANE) return settingsDone($)
  const now = await read($, settings)
  await update($, settingsUi, (u): SettingsUi => (u.open === undefined ? { open: PANE, before: now } : { ...u, open: PANE }))
  // The sheet takes the keyboard, its ring on the editor keymap in effect
  // (Enter there changes nothing; Tab walks on to the keys field).
  sheetFocus($, 'settings:keymap:' + keymapNameOf(pluginOptions, now))
}

// As the explorer's focusOn: a press's own drawing is not there yet, so the
// focus waits for it; a click leaves the keyboard with the prompt, so the pane
// asks for it first (granted only over an empty composer); a deny retries.
const sheetFocus = ($: EngineInterface, key: string, tries = 4): void => {
  $.clock.after(50, async () => {
    try {
      const pane = (await $.ui.panes()).find(p => p.id === PANE)
      if (pane !== undefined && !pane.isFocused) await $.ui.open({ id: PANE, title: 'Git', focus: true })
      const moved = await $.ui.focus({ requestId: PANE, key })
      if (moved.deny !== undefined && tries > 1) sheetFocus($, key, tries - 1)
    } catch {
      // the person clicks into it
    }
  })
}

// A change applies at once (both panels redraw); `done` saves it. A new page
// size drops the commits paged to.
const changeSettings = async ($: EngineInterface, patch: Partial<SettingsState>): Promise<void> => {
  await update($, settings, s => ({ ...s, ...patch }))
  if (patch.gitLimit !== undefined) await update($, git, s => ({ ...s, limit: undefined }))
}

// The key overrides field: good text (empty is none) is applied; bad text is
// kept in the field with its error, the settings keep the last good text.
const settingsKeys = async ($: EngineInterface, text: string): Promise<void> => {
  const error = keysError(text)
  await update($, settingsUi, u => ({ ...u, keys: text, keysError: error }))
  if (error === undefined) await update($, settings, s => ({ ...s, keys: text.trim() === '' ? undefined : text }))
}

// Both panels' section sizes back to their defaults, here and for later
// sessions; `{}` keeps the draw off the layout read from the store.
const resetLayout = async ($: EngineInterface): Promise<void> => {
  await $.store.delete(LAYOUT_KEY)
  await $.store.delete('layout:explorer')
  storedLayout = undefined
  await update($, git, s => ({ ...s, split: {} }))
  const explorerRef = { plugin: 'ide-panes', key: 'explorer' } as const
  const held = await $.state.get(explorerRef)
  if (held.value !== undefined) await $.state.set(explorerRef, { ...held.value, split: {} })
  await $.ui.toast('Layout reset')
}

// As the explorer's explorerThemeEnv (the validator follows `$` within one
// file): what the theme draws from, into the shared `themeEnv`.
const gitThemeEnv = async ($: EngineInterface): Promise<void> => {
  const env = themeEnv
  try {
    if (env.configPaths === undefined) {
      env.configPaths = tabbyConfigPaths(
        await $.env.get('TERM_PROGRAM'),
        await $.env.get('TABBY_CONFIG_DIRECTORY'),
        await $.env.get('HOME'),
      )
    }
    if (env.configPaths.length > 0 && Date.now() - env.checkedAt >= THEME_POLL_MS) {
      env.checkedAt = Date.now()
      for (const path of env.configPaths) {
        const stat = await $.fs.stat(path).catch(() => undefined)
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
    if (env.ccTheme === undefined) {
      const row = (await $.config.list()).find(r => r.key === 'theme')
      env.ccTheme = typeof row?.value === 'string' ? row.value : 'dark'
    }
  } catch {
    // not readable now: the theme draws from what is known (else as `dark`)
  }
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

// Git output is cached here, not in $.state; Bash, fetch, pull, push and a
// moved ref seen by the watch clear it; Write/Edit/NotebookEdit and a working
// tree change seen by the watch drop the status, show and change entries
// (`touched`).
let repoRoot: string | null | undefined
let branchCache: Branch[] | undefined
let statusCache: Change[] | undefined
const graphCache = new Map<string, Commit[]>()
// graphCache's key: the ref and the page size it was read with.
const graphKey = (ref: string, limit: number): string => ref + '\0' + limit
const showCache = new Map<string, { head: string[]; diff: string }>()
// A commit's changed files and whole patch, for the diff view. Cleared by
// `clear()` only: commits do not change on Write/Edit.
const diffCache = new Map<string, { files: Change[]; patch: string }>()
const changeCache = new Map<string, { head: string[]; diff: string }>()
// The branches containing a commit (the Commits hover card, Info), per sha.
const containsCache = new Map<string, Contains>()
// The commit under the resting pointer (its card is up), and the shas of the
// commit rows as last drawn, top to bottom (the hash Client's `y`), with the
// key of the Client drawn for them: `dots` in Commits, `shas` in Graph.
// Transient, so module variables, not `$.state`.
let hovered: string | undefined
let commitWindow: { element: string; shas: string[] } = { element: '', shas: [] }
// Branch names a card lists before `+N more`: half per group, all of it
// when the other group is empty.
const CARD_NAMES = 8
// Columns of a Commits row's dot and the space after it.
const DOT_COLS = 2
let hasHead: boolean | undefined
// The branch HEAD names when no branch is HEAD (a repo before its first commit);
// null: detached. Cleared with the caches.
let unborn: string | null | undefined
// Diff Preview's body width (Code's gutter + widest body line) for the last
// diff measured: one entry keyed by the diff string, so a redraw of the same
// diff (wheel ticks, drags) does not walk the whole, uncapped patch again.
let diffWidth: { diff: string; cols: number } | undefined
const diffWidthOf = (diff: string): number => {
  if (diffWidth?.diff !== diff) diffWidth = { diff, cols: diffGutter(diff) + widest(diffBody(diff)) }

  return diffWidth.cols
}
// Rows the graph and the Files list show; set by render, read by the focus hook.
let graphRows = 20
// Commit rows of each tab, so a tab switch can window the list for the tab it goes to.
const tabRows = { overview: 20, graph: 20 }
let changeRoom = 20
// The last drawing's geometry, set by render and read by the scroll hook: where
// each section sits (Overview: columns split at `branchEnd`, the right column's
// rows at `infoTop`; Change Log: columns split at `filesEnd`), each section's
// furthest offset (`filesMax`: the Files list of Change Log or the diff view) and
// the rows Info and Diff Preview show, and their furthest first column (the
// horizontal bars).
const view = {
  columns: 0, // the totals the splitters divide: the body's columns, the sections' rows
  area: 0,
  branchEnd: 0,
  filesEnd: 0,
  infoTop: 0,
  branchMax: 0,
  graphMax: 0,
  infoMax: 0,
  filesMax: 0,
  detailMax: 0,
  detailRows: 1,
  infoRows: 1,
  infoLeftMax: 0,
  detailLeftMax: 0,
}

// The splitters' messages: which `split` fraction each sets, and its axis.
const SEAMS = {
  'split:side': { key: 'side', axis: 'x', min: MIN_COLS },
  'split:info': { key: 'info', axis: 'y', min: MIN_ROWS },
  'split:files': { key: 'files', axis: 'x', min: MIN_COLS },
  'split:graph': { key: 'graph', axis: 'y', min: MIN_ROWS },
} as const

// The section sizes, global (every repo): the whole `split` object, written
// when a splitter drag ends. Git has no session.start (one per plugin) and a
// render may not write `$.state`, so the render reads the store once per load
// while `split` is unset and keeps it here: the draw's fallback under
// `state.split`, and the base the first drag merges into. Both reset on
// reload, harmlessly, as `$.state` keeps the session's own sizes.
const LAYOUT_KEY = 'layout:git'
let layoutLoaded = false
let storedLayout: GitState['split']

const loadLayout = async ($: EngineInterface): Promise<void> => {
  storedLayout = layoutOf(await $.store.get(LAYOUT_KEY), ['side', 'info', 'files', 'graph']) as GitState['split']
  layoutLoaded = true
}

const clear = (): void => {
  seen = undefined
  repoRoot = undefined
  branchCache = undefined
  statusCache = undefined
  graphCache.clear()
  showCache.clear()
  diffCache.clear()
  changeCache.clear()
  containsCache.clear()
  hasHead = undefined
  unborn = undefined
}

// Calls that threw (the engine aborts a git call when its render is
// superseded). Their empty answer is not the repo's, so it is not cached.
let threw = 0

// Read-only git call; undefined on an exit code outside `ok` or any failure.
const run = async (
  $: EngineInterface,
  cwd: string,
  argv: string[],
  ok: readonly number[] = [0],
): Promise<string | undefined> => {
  try {
    // Read-only: a status refreshing the index takes no lock from the person's
    // own git commands (the watch runs one every 2 s).
    const ran = await $.process.run(argv, { cwd, env: { GIT_OPTIONAL_LOCKS: '0' }, timeoutMs: 15000 })

    return ok.includes(ran.exitCode) ? ran.stdout : undefined
  } catch {
    threw += 1

    return undefined
  }
}

const rootOf = async (
  $: EngineInterface,
  cwd: string,
): Promise<string | null> => {
  if (typeof repoRoot === 'string') return repoRoot
  // Not a repo is not cached: the next render looks again.
  const out = await run($, cwd, ['git', 'rev-parse', '--show-toplevel'])
  if (out === undefined) return null
  repoRoot = out.trim()

  return repoRoot
}

const branchesOf = async (
  $: EngineInterface,
  cwd: string,
): Promise<Branch[]> => {
  if (branchCache === undefined) {
    const before = threw
    const parsed = parseBranches((await run($, cwd, branchesArgv())) ?? '')
    if (threw !== before) return parsed
    branchCache = parsed
  }

  return branchCache
}

const statusOf = async (
  $: EngineInterface,
  cwd: string,
): Promise<Change[]> => {
  if (statusCache === undefined) {
    const before = threw
    const parsed = parseStatus((await run($, cwd, statusArgv())) ?? '')
    if (threw !== before) return parsed
    statusCache = parsed
  }

  return statusCache
}

const graphOf = async (
  $: EngineInterface,
  cwd: string,
  state: GitState & { limit: number },
): Promise<Commit[]> => {
  const key = graphKey(state.ref, state.limit)
  let lines = graphCache.get(key)
  if (lines === undefined) {
    const before = threw
    lines = parseLog(
      (await run($, cwd, logArgv(state.ref, state.limit))) ?? '',
    )
    if (threw !== before) return lines
    graphCache.set(key, lines)
  }

  return lines
}

const detailsOf = async (
  $: EngineInterface,
  cwd: string,
  sha: string,
): Promise<{ head: string[]; diff: string }> => {
  let shown = showCache.get(sha)
  if (shown === undefined) {
    const before = threw
    // Overview's Info shows no patch; the full-panel commit diff fetches it.
    const stat = await run($, cwd, statArgv(sha))
    shown = { head: splitShow(stat ?? ''), diff: '' }
    if (threw !== before) return shown
    showCache.set(sha, shown)
  }

  return shown
}

// Every branch containing the commit, local and remote apart.
const containsOf = async (
  $: EngineInterface,
  cwd: string,
  sha: string,
): Promise<Contains> => {
  let names = containsCache.get(sha)
  if (names === undefined) {
    const before = threw
    names = parseContains((await run($, cwd, containsArgv(sha))) ?? '')
    if (threw !== before) return names
    containsCache.set(sha, names)
  }

  return names
}

// The files a commit changed and its whole patch (a merge against its first
// parent), one fetch of each.
const diffOf = async (
  $: EngineInterface,
  cwd: string,
  sha: string,
): Promise<{ files: Change[]; patch: string }> => {
  let shown = diffCache.get(sha)
  if (shown === undefined) {
    const before = threw
    const names = await run($, cwd, filesArgv(sha))
    const patch = await run($, cwd, patchArgv(sha))
    shown = { files: parseNameStatus(names ?? ''), patch: patch ?? '' }
    if (threw !== before) return shown
    diffCache.set(sha, shown)
  }

  return shown
}

// The Diff Preview head of one change: its path, what happened, a rename's source.
const changeHead = (change: Change): string[] => [
  change.path,
  changeWords(change),
  ...(change.from === undefined ? [] : ['from ' + change.from]),
]

// Head lines and the diff of one change against HEAD, run from the repo root
// (status paths are relative to it). An untracked file is
// diffed with `--no-index`, which exits 1 when the files differ.
const changeDetailsOf = async (
  $: EngineInterface,
  cwd: string,
  change: Change,
): Promise<{ head: string[]; diff: string }> => {
  let shown = changeCache.get(change.path)
  if (shown === undefined) {
    const before = threw
    let head = hasHead
    if (head === undefined) {
      head = (await run($, cwd, ['git', 'rev-parse', '--verify', '--quiet', 'HEAD'])) !== undefined
      if (threw === before) hasHead = head
    }
    const out = await run(
      $,
      cwd,
      changeDiffArgv(change, head),
      isUntracked(change) ? [0, 1] : [0],
    )
    shown = {
      head: changeHead(change),
      diff: (out ?? '').replace(/^\n+/, ''),
    }
    if (threw !== before) return shown
    changeCache.set(change.path, shown)
  }

  return shown
}

// The Files list as drawn now, a tree grouped by `/`: the cached status, or in
// the diff view the open commit's files.
const rowsOf = (state: GitState): ChangeRow[] =>
  changeRows(
    state.diff === undefined ? (statusCache ?? []) : (diffCache.get(state.diff)?.files ?? []),
    new Set(state.changeCollapsed ?? []),
  )

const fit = (text: string, width: number): string =>
  text.length > width ? text.slice(0, Math.max(1, width - 1)) + '…' : text

// The fetch, pull or push running now; a second press waits for it to finish.
let busy: RemoteAction | undefined

// Runs a fetch, pull or push (no credential prompt: it fails instead of hanging),
// reports it in a toast and reloads every cached view of the repo.
const remote = async ($: EngineInterface, action: RemoteAction): Promise<void> => {
  if (busy !== undefined) return
  busy = action
  $.ui.invalidate('ui.render')
  const cwd = await $.session.root()
  let text: string
  try {
    const ran = await $.process.run(remoteArgv(action), {
      cwd,
      env: { GIT_TERMINAL_PROMPT: '0' },
      timeoutMs: 120000,
    })
    text = remoteSummary(action, ran.exitCode, ran.stdout, ran.stderr)
  } catch (error) {
    text = `git ${action}: failed: ${error instanceof Error ? error.message : String(error)}`
  }
  busy = undefined
  clear()
  await $.ui.toast(text)
  $.ui.invalidate('ui.render')
}

const touched = ($: EngineInterface): void => {
  dropTree()
  $.ui.invalidate('ui.render')
}

// The working tree's caches; `tree`, a status already read, fills it again.
const dropTree = (tree?: string): void => {
  seen = undefined
  statusCache = tree === undefined ? undefined : parseStatus(tree)
  showCache.clear()
  changeCache.clear()
  hasHead = undefined
}

// Changes made outside Claude (a commit, checkout, stash or fetch in a shell,
// an editor saving files) show without a press: while a panel is up the repo
// is looked at every GIT_LOOK_MS. Claude's own tool calls clear the caches at
// once (the tool.call hooks).
let gitWatch: { cancel: () => void } | undefined
const GIT_LOOK_MS = 2000
// What the cached views were read against: the ref HEAD names, every ref's sha
// and the working tree's status. Dropped with the caches; the drawing that
// fills them again takes it first, so a change after it is the watch's.
type Look = { refs: string; tree: string }
let seen: Look | undefined

// One look; undefined when a call failed or was aborted.
const lookRepo = async ($: EngineInterface, root: string): Promise<Look | undefined> => {
  const before = threw
  const [head, refs, tree] = await Promise.all([
    run($, root, headRefArgv(), [0, 1]),
    run($, root, refsArgv(), [0, 1]),
    run($, root, statusArgv()),
  ])
  if (threw !== before || head === undefined || refs === undefined || tree === undefined) return undefined

  return { refs: head + '\0' + refs, tree }
}

const watchGit = ($: EngineInterface): void => {
  if (gitWatch !== undefined) return
  try {
    gitWatch = $.clock.after(GIT_LOOK_MS, async () => {
      gitWatch = undefined
      try {
        // Both panes closed: the next drawing watches again.
        if (!(await $.ui.panes()).some(pane => pane.id === PANE || pane.id === SPLIT_PANE)) return
        const root = repoRoot
        // A fetch, pull or push clears everything when it ends.
        const now = busy === undefined && seen !== undefined && typeof root === 'string' ? await lookRepo($, root) : undefined
        // `seen` gone meanwhile: a hook cleared the caches, the drawing looks.
        if (now !== undefined && seen !== undefined && root === repoRoot) {
          if (now.refs !== seen.refs) {
            clear()
            statusCache = parseStatus(now.tree)
            seen = now
            $.ui.invalidate('ui.render')
          } else if (now.tree !== seen.tree) {
            dropTree(now.tree)
            seen = now
            $.ui.invalidate('ui.render')
          }
        }
        watchGit($)
      } catch {
        // no surface to ask: the next drawing watches again
      }
    })
  } catch {
    // no clock here: the drawing goes on without the watch
  }
}

// A full ref (or a folder's prefix) copied by a double-click on a Branches row.
const copyRef = async (
  $: EngineInterface,
  text: string,
  surface: Parameters<EngineInterface['ui']['copy']>[0]['surface'],
): Promise<void> => {
  const copied = await $.ui.copy({ text, surface })
  await $.ui.toast(copied.isCopied ? `Copied: ${text}` : `Copy failed: ${copied.reason}`)
}

// The commits of `ref` (a branch name or `all`), from the top, a page at a time.
const selectRef = ($: EngineInterface, ref: string) =>
  update($, git, s => ({
    ...s,
    ref,
    offset: 0,
    infoOffset: 0,
    infoLeft: 0,
    selected: undefined,
    limit: undefined, // the page size again
  }))

// Opens or closes a Branches folder or category (`l:`, `r:origin`, ...).
const toggleFolder = ($: EngineInterface, key: string) =>
  update($, git, s => ({ ...s, collapsed: toggled(s.collapsed ?? [], key) }))

const keyOf = (commit: Commit): string => 'commit:' + commit.sha

// `sha` selected: Info keeps its scroll for the same commit, else starts over.
const selectCommit = (s: GitState, sha: string): GitState => ({
  ...s,
  selected: sha,
  infoOffset: s.selected === sha ? s.infoOffset : 0,
  infoLeft: s.selected === sha ? s.infoLeft : 0,
})

export const register = (on: On, options?: PluginOptions): void => {
  pluginOptions = options
  // Clear the caches after Bash may have run git; never denies or rewrites the call.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    clear()
    $.ui.invalidate('ui.render')

    return ran
  })

  // The working tree changed: the status counts and the shown commits are
  // reread. Never denies or rewrites the call.
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    touched($)

    return ran
  })
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)
    touched($)

    return ran
  })
  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => {
    const ran = await next(e)
    touched($)

    return ran
  })

  on('ui.focus', { requestId: [PANE, SPLIT_PANE] }, async ($, e, next) => {
    // In the split pane only Git's elements (keys `git/...`) are this hook's.
    const element = e.requestId === SPLIT_PANE ? gitKeyOf(e.element) : e.element
    if (element !== undefined && element.startsWith('commit:')) {
      const sha = element.slice('commit:'.length)
      const state = await gitNow($)
      const lines = graphCache.get(graphKey(state.ref, state.limit)) ?? []
      const win = windowOf(
        lines,
        lines.findIndex(commit => commit.sha === sha),
        graphRows,
        state.offset,
      )
      if (state.selected !== sha || state.offset !== win.offset) {
        await update($, git, s => ({ ...selectCommit(s, sha), offset: win.offset }))
      }
    }

    if (element !== undefined && element.startsWith('change:')) {
      const path = element.slice('change:'.length)
      const state = await gitNow($)
      const rows = rowsOf(state)
      const win = windowOf(
        rows,
        rows.findIndex(row => row.kind === 'leaf' && row.item.path === path),
        changeRoom,
        state.changeOffset ?? 0,
      )
      if (state.change !== path || state.changeOffset !== win.offset) {
        await update($, git, s => ({
          ...s,
          change: path,
          changeOffset: win.offset,
          detailOffset: s.change === path ? s.detailOffset : 0,
          detailLeft: s.change === path ? s.detailLeft : 0,
        }))
      }
    }

    if (element !== undefined && element.startsWith('dfile:')) {
      const path = element.slice('dfile:'.length)
      const state = await gitNow($)
      const rows = rowsOf(state)
      const win = windowOf(
        rows,
        rows.findIndex(row => row.kind === 'leaf' && row.item.path === path),
        changeRoom,
        state.diffFileOffset ?? 0,
      )
      if (state.diffFile !== path || state.diffFileOffset !== win.offset) {
        await update($, git, s => ({
          ...s,
          diffFile: path,
          diffFileOffset: win.offset,
          detailOffset: s.diffFile === path ? s.detailOffset : 0,
          detailLeft: s.diffFile === path ? s.detailLeft : 0,
        }))
      }
    }

    return next(e)
  })

  // Wheel: scrolls the section under the pointer. Keys: an arrow moves the
  // commit selection, a page key scrolls the details. The engine's own window
  // is never used, so the hook always answers `{}` without `next`.
  on('ui.scroll', { requestId: [PANE, SPLIT_PANE] }, async ($, e) => {
    const state = await gitNow($)
    // The diff view replaces whichever tab it was opened from.
    const isDiff = state.diff !== undefined
    const isChanges = !isDiff && tabOf(state) === 'changelog'
    const isGraph = !isDiff && tabOf(state) === 'graph'
    const isFiles = isDiff || isChanges
    const filesPart = isDiff ? 'diffFileOffset' : 'changeOffset'
    // In the split pane rows count from the top of Git's half.
    const pointer =
      e.pointer !== undefined && e.requestId === SPLIT_PANE ? { ...e.pointer, row: e.pointer.row - seat.gitTop } : e.pointer
    if (pointer !== undefined) {
      // Change Log and the diff view: Files | Diff Preview. Graph: the list
      // over Info. Overview: Branches | Commits over Info.
      const part = isGraph
        ? pointer.row < view.infoTop
          ? 'offset'
          : 'infoOffset'
        : isFiles
        ? pointer.column < view.filesEnd
          ? filesPart
          : 'detailOffset'
        : pointer.column < view.branchEnd
          ? 'branchOffset'
          : pointer.row < view.infoTop
            ? 'offset'
            : 'infoOffset'
      const max =
        part === 'branchOffset'
          ? view.branchMax
          : part === 'offset'
            ? view.graphMax
            : part === 'infoOffset'
              ? view.infoMax
              : part === 'changeOffset' || part === 'diffFileOffset'
                ? view.filesMax
                : view.detailMax
      const was = state[part] ?? 0
      const next = clamp(was + e.by, max)
      if (next !== was) await update($, git, s => ({ ...s, [part]: next }))
    } else if (Math.abs(e.by) === 1 && isFiles) {
      const rows = rowsOf(state)
      const leaves = rows.flatMap(row => (row.kind === 'leaf' ? [row.item.path] : []))
      const current = isDiff ? state.diffFile : state.change
      const at = leaves.indexOf(current ?? leaves[0] ?? '')
      const path = leaves[clamp(at < 0 ? 0 : at + e.by, leaves.length - 1)]
      if (path !== undefined && path !== current) {
        const win = windowOf(
          rows,
          rows.findIndex(row => row.kind === 'leaf' && row.item.path === path),
          changeRoom,
          state[filesPart] ?? 0,
        )
        await update($, git, s =>
          isDiff
            ? { ...s, diffFile: path, diffFileOffset: win.offset, detailOffset: 0, detailLeft: 0 }
            : { ...s, change: path, changeOffset: win.offset, detailOffset: 0, detailLeft: 0 },
        )
        await focusGit($, (isDiff ? 'dfile:' : 'change:') + path)
      }
    } else if (Math.abs(e.by) === 1) {
      const lines = graphCache.get(graphKey(state.ref, state.limit)) ?? []
      const at = lines.findIndex(commit => commit.sha === state.selected)
      const sha = lines[clamp(at < 0 ? 0 : at + e.by, lines.length - 1)]?.sha
      if (sha !== undefined && sha !== state.selected) {
        const win = windowOf(
          lines,
          lines.findIndex(commit => commit.sha === sha),
          graphRows,
          state.offset,
        )
        await update($, git, s => ({
          ...s,
          selected: sha,
          offset: win.offset,
          infoOffset: 0,
          infoLeft: 0,
        }))
        await focusGit($, 'commit:' + sha)
      }
    } else if (isFiles) {
      const was = state.detailOffset ?? 0
      const detailOffset = clamp(
        was + Math.sign(e.by) * view.detailRows,
        view.detailMax,
      )
      if (detailOffset !== was) await update($, git, s => ({ ...s, detailOffset }))
    } else if (isGraph) {
      const was = state.offset
      const offset = clamp(was + Math.sign(e.by) * graphRows, view.graphMax)
      if (offset !== was) await update($, git, s => ({ ...s, offset }))
    } else {
      const was = state.infoOffset ?? 0
      const infoOffset = clamp(was + Math.sign(e.by) * view.infoRows, view.infoMax)
      if (infoOffset !== was) await update($, git, s => ({ ...s, infoOffset }))
    }
    $.ui.invalidate('ui.render')

    return {}
  })

  // A scrollbar dragged: the window moves, the selection stays (as the wheel).
  on('ui.message', { requestId: [PANE, SPLIT_PANE] }, async ($, e) => {
    // In the split pane the Explorer's hook passes on only Git's keys (`git/...`).
    const element = e.requestId === SPLIT_PANE ? gitKeyOf(e.element) : e.element
    if (element === undefined) return {}
    const data = e.data as { offset?: unknown; start?: unknown; delta?: unknown; done?: unknown } | null
    if (element === 'dots' || element === 'shas') {
      // Only the window drawn for this Client maps its rows.
      const shaAt = (y: unknown): string | undefined =>
        element === commitWindow.element && typeof y === 'number' && Number.isInteger(y)
          ? commitWindow.shas[y]
          : undefined
      const message = e.data as { hover?: unknown; press?: unknown } | null
      if (message !== null && 'press' in message) {
        // A click on a row's dot or hash: that commit is selected, as a press
        // on its subject, and the keyboard moves to the subject Button.
        const sha = shaAt(message.press)
        if (sha === undefined) return {}
        await update($, git, s => selectCommit(s, sha))
        $.ui.invalidate('ui.render')
        await focusGit($, 'commit:' + sha)

        return {}
      }
      // The pointer rested on a row's dot or hash (`hover: y`) or left it
      // (`null`): the card shows that row's commit, its branches fetched once.
      const sha = shaAt(message?.hover)
      hovered = sha
      $.ui.invalidate('ui.render')
      if (sha !== undefined && !containsCache.has(sha)) {
        await containsOf($, await $.session.root(), sha)
        $.ui.invalidate('ui.render')
      }

      return {}
    }
    if (element.startsWith('bitem:')) {
      // A Branches row's Client (branch-client.tsx): the arrow opens or closes
      // a folder, the name selects a branch (a folder's name does nothing), a
      // double-click copies the full ref or the folder's prefix.
      const key = element.slice('bitem:'.length)
      const hit = (e.data as { hit?: unknown } | null)?.hit
      const state = await read($, git)
      const branches = await branchesOf($, await $.session.root())
      const row = branchTree(branches, new Set(state.collapsed ?? [])).find(r =>
        r.kind === 'branch' ? 'b:' + r.branch.name === key : r.key === key,
      )
      if (row === undefined) return {}
      if (hit === 'arrow' && row.kind === 'folder') await toggleFolder($, row.key)
      else if (hit === 'name' && row.kind === 'branch') await selectRef($, row.branch.name)
      else if (hit === 'double') {
        const text = copyTextOf(row)
        if (text !== undefined) await copyRef($, text, e.surface)
      }
      $.ui.invalidate('ui.render')

      return {}
    }
    const seam = SEAMS[element as keyof typeof SEAMS]
    if (seam !== undefined) {
      // A splitter dragged: the section's new size is where it started plus
      // the pointer's travel, kept as a fraction so a resize keeps it.
      const { start, delta } = data ?? {}
      if (typeof start !== 'number' || typeof delta !== 'number') return {}
      if (!Number.isFinite(start) || !Number.isFinite(delta)) return {}
      const total = seam.axis === 'x' ? view.columns : view.area
      if (total <= 0) return {}
      const fraction = dragTo(total, start, delta, seam.min)
      // Info's seams keep Info's share (the section below), not the top one's.
      const isBelow = seam.key === 'info' || seam.key === 'graph'
      const after = await update($, git, s => ({
        ...s,
        split: { ...(s.split ?? storedLayout), [seam.key]: isBelow ? 1 - fraction : fraction },
      }))
      // The drag ended: the sizes outlive the session (mid-drag moves don't write).
      if (data?.done === true) await $.store.set(LAYOUT_KEY, after.split ?? {})
      $.ui.invalidate('ui.render')

      return {}
    }
    const to = typeof data?.offset === 'number' ? data.offset : NaN
    if (!Number.isFinite(to)) return {}
    const parts = {
      'sb:branches': ['branchOffset', view.branchMax],
      'sb:graph': ['offset', view.graphMax],
      'sb:info': ['infoOffset', view.infoMax],
      'sb:changes': ['changeOffset', view.filesMax],
      'sb:dfiles': ['diffFileOffset', view.filesMax],
      'sb:details': ['detailOffset', view.detailMax],
      'hb:info': ['infoLeft', view.infoLeftMax],
      'hb:details': ['detailLeft', view.detailLeftMax],
    } as const
    const part = parts[element as keyof typeof parts]
    if (part === undefined) return {}
    const value = clamp(Math.round(to), part[1])
    await update($, git, s => ({ ...s, [part[0]]: value }))
    $.ui.invalidate('ui.render')

    return {}
  })

  // Its own pane, or the split pane's rows below the seam (asked for by the
  // Explorer's hook, above this one), there with every key prefixed `git/`.
  on('ui.render', { component: 'Pane', requestId: [PANE, SPLIT_PANE] }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button, Code } = elements
    const Client = 'Client' in elements ? elements.Client : undefined
    host = e.requestId === SPLIT_PANE ? SPLIT_PANE : PANE
    const isSplit = host === SPLIT_PANE
    const bodyRows = isSplit ? seat.gitRows : e.props.scroll.bodyRows
    const own = (tree: RenderElement): RenderElement => (isSplit ? prefixKeys(tree, GIT_PREFIX) : tree)
    // The hash Client (dots and hashes, and so the hover card and the hash
    // press) where a Client is drawn; elsewhere the hash is a Button.
    const hasDots = Client !== undefined && (e.surface === 'terminal' || e.surface === 'desktop')
    const state = await gitNow($)
    // The Settings theme, its accent taken from the `/color` session color
    // while one is set (and `accentFromSession` is on, the default).
    const settingsNow = await read($, settings)
    // The commits a `more` adds, and the Settings sheet while it is up.
    const page = settingsNow.gitLimit ?? DEFAULTS.gitLimit
    const sheet = await read($, settingsUi)
    // While the sheet is up the panel's own Buttons do nothing: a press is dropped.
    const asleep =
      <A extends unknown[]>(act: (...args: A) => unknown) =>
      (...args: A): void => {
        if (sheet.open !== host) void act(...args)
      }
    const color = await read($, sessionColor)
    await gitThemeEnv($)
    const t = resolveTheme(settingsNow, color, themeEnv)
    // That `/color` accent frames the sections too, as it did before themes.
    const accentBorder = color !== '' && (settingsNow.accentFromSession ?? true)
    // Selected rows: a Button label is the terminal's default foreground, so fills are darkened.
    const sel = onDefaultFg(t.surfaceHover)
    const lanes = lanePalette(t)
    const surface = e.surface
    // Settings (the title row's right end, left of the pane's close mark) and its
    // sheet, drawn last over the panel below the title row. The split pane has
    // one, the Explorer's, and its sheet covers both halves.
    const paneButtons = isSplit
      ? undefined
      : PaneButtons(elements, t, {
          surface,
          isOpen: sheet.open === PANE,
          onSettings: () => void toggleSettings($),
        })
    const settingsSheet =
      !isSplit && sheet.open === PANE
        ? SettingsSheet(elements, t, {
            surface,
            cols: e.props.bodyColumns,
            rows: bodyRows,
            settings: settingsNow,
            keymap: keymapNameOf(pluginOptions, settingsNow),
            fileIcons: iconChoice(settingsNow.fileIcons, themeEnv.fonts),
            keys: sheet.keys ?? settingsNow.keys ?? '',
            keysError: sheet.keysError,
            onChange: patch => void changeSettings($, patch),
            onKeys: text => void settingsKeys($, text),
            onResetLayout: () => void resetLayout($),
            onDone: () => void settingsDone($),
            onCancel: () => void settingsCancel($),
          })
        : undefined
    if (state.split === undefined && !layoutLoaded) await loadLayout($)
    const cwd = await $.session.root()
    const before = threw
    const root = await rootOf($, cwd)
    if (root === null) {
      // An aborted lookup says nothing about the repo and nothing else redraws
      // this: look again shortly. For a real "not a repo" the Explorer watches
      // for one appearing and redraws both panels when it does.
      if (threw !== before) $.clock.after(1000, () => $.ui.invalidate('ui.render'))

      return own(
        <Box flexDirection="column" width="100%" minHeight={bodyRows} backgroundColor={t.canvas}>
          <Box key="header" flexDirection="row" justifyContent="space-between" alignItems="center">
            <Text bold color={t.text}>{" Git"}</Text>
            {paneButtons}
          </Box>
          <Text color={t.muted}>Not a git repository</Text>
          {settingsSheet}
        </Box>
      )
    }

    // What the views are read against, taken before them (its status fills
    // the status cache); the watch compares its looks with it.
    if (seen === undefined) {
      const now = await lookRepo($, root)
      if (now !== undefined) {
        seen = now
        statusCache ??= parseStatus(now.tree)
      }
    }
    watchGit($)
    const columns = e.props.bodyColumns
    const home = await $.env.get('HOME')
    const changes = await statusOf($, cwd)
    const counts = changeCounts(changes)
    const isClean = counts.added + counts.modified + counts.deleted === 0
    const tab = tabOf(state)
    // The diff view replaces the panel body, whichever tab it was opened from.
    const isDiff = state.diff !== undefined
    const isChanges = !isDiff && tab === 'changelog'
    // Change Log and the diff view both draw Files | Diff Preview.
    const isFiles = isDiff || isChanges
    const isWide = columns >= WIDE
    // Each section is framed in the theme's border color, or the `/color` accent.
    const border = { borderStyle: 'round', borderColor: accentBorder ? t.accent : t.border } as const
    // One header line (the title, the panel tabs and the actions, its right
    // end kept for Settings; no interactive line: nothing asks) and one
    // footer row; the sections share the rest.
    const headerRows = 1
    const area = Math.max(4, bodyRows - headerRows - 1)
    // The four sizes the splitters drive, each computed here from its
    // default fraction. Fixed cell widths (not percentages) so labels,
    // hit-testing and the drawn columns agree.
    // Branches' width (Overview).
    const split = state.split ?? storedLayout ?? {}
    const sideCols = splitAt(columns, split.side ?? (isWide ? SPLIT.sideWide : SPLIT.sideNarrow), MIN_COLS)
    // Commits' height; Info takes the rest of the right column (Overview).
    const topRows = Math.max(3, splitAt(area, 1 - (split.info ?? SPLIT.info), MIN_ROWS))
    // Files' width (Change Log).
    const filesCols = splitAt(columns, split.files ?? SPLIT.files, MIN_COLS)
    // Graph's height; Info takes the rest of the panel (Graph).
    const graphTop = Math.max(3, splitAt(area, 1 - (split.graph ?? SPLIT.graph), MIN_ROWS))

    const rightCols = columns - sideCols
    // Graph: Graph over Info across the panel; Overview: Commits over Info in
    // the right column. Info's size is the active tab's.
    const isGraph = !isDiff && tab === 'graph'
    const infoRows = Math.max(3, area - (isGraph ? graphTop : topRows))
    const infoWidth = isGraph ? columns : rightCols
    // Each section is framed: 2 rows and 2 columns go to the border.
    const topInner = Math.max(3, topRows - 2)
    const graphInner = Math.max(3, graphTop - 2)
    const infoInner = Math.max(3, infoRows - 2)
    const fullInner = Math.max(3, area - 2)
    tabRows.graph = Math.max(2, graphInner - 1)
    tabRows.overview = Math.max(2, topInner - 1)
    graphRows = isGraph ? tabRows.graph : tabRows.overview
    const graphWidth = (isGraph ? columns : rightCols) - 5
    // the scrollbar takes one more column in each section
    const sideWidth = sideCols - 3

    const branches = await branchesOf($, cwd)
    const lines = isChanges ? [] : await graphOf($, cwd, state)
    // Graph's lanes take what the row's other columns leave; Commits draws one
    // dot per row, so its lanes are never collapsed.
    const laid = isGraph ? layoutGraph(lines, maxLanesFor(graphWidth, true)) : layoutGraph(lines)
    const index = lines.findIndex(commit => commit.sha === state.selected)
    const selected = index >= 0 ? lines[index] : lines[0]
    // The wheel moves the window off the selection, so it only clamps here.
    const win = windowOf(laid, -1, graphRows, state.offset)
    // Rows are padded to the widest lanes in view, so the text lines up
    // without leaving room for lanes scrolled out of it.
    const laneCols = win.rows.reduce((max, row) => Math.max(max, row.cells.length), 0)
    // Commits (Overview) or Graph, no diff view open: the rows as drawn, for
    // the hash Client's `y`; a card whose commit left them, or another tab, goes.
    const isCommits = !isDiff && !isChanges && !isGraph
    const hashKey = isCommits ? 'dots' : 'shas'
    const prevElement = commitWindow.element
    commitWindow =
      hasDots && (isCommits || isGraph)
        ? { element: hashKey, shas: win.rows.map(row => row.commit.sha) }
        : { element: '', shas: [] }
    if (hovered !== undefined && (prevElement !== commitWindow.element || !commitWindow.shas.includes(hovered))) {
      hovered = undefined
    }
    const isMore = lines.length >= state.limit
    // A commit scrolled out of the window is not focused: autoFocus would move
    // the selection to whatever row the wheel brought in.
    const focusKey =
      selected === undefined || !win.rows.some(row => row.commit === selected)
        ? undefined
        : keyOf(selected)
    const remotes = new Set(branches.filter(branch => branch.isRemote).map(branch => branch.name))
    changeRoom = Math.max(2, fullInner)
    const diffShown = isDiff && state.diff !== undefined ? await diffOf($, cwd, state.diff) : undefined
    // The Files list: the working tree (Change Log) or the open commit's files.
    const frows = isFiles ? rowsOf(state) : []
    const leaves = frows.flatMap(row => (row.kind === 'leaf' ? [row.item] : []))
    const chosen = leaves.find(change => change.path === (isDiff ? state.diffFile : state.change)) ?? leaves[0]
    const fileOffset = (isDiff ? state.diffFileOffset : state.changeOffset) ?? 0
    const fileKey = isDiff ? 'dfile:' : 'change:'
    const cwin = windowOf(frows, -1, changeRoom, fileOffset)
    const changeFocus =
      chosen !== undefined &&
      cwin.rows.some(row => row.kind === 'leaf' && row.item.path === chosen.path)
        ? fileKey + chosen.path
        : undefined
    const details = isDiff
      ? chosen === undefined || diffShown === undefined
        ? undefined
        : { head: changeHead(chosen), diff: fileDiff(diffShown.patch, chosen.path) }
      : isChanges
        ? chosen === undefined
          ? undefined
          : await changeDetailsOf($, root, chosen)
        : selected === undefined
          ? undefined
          : await detailsOf($, cwd, selected.sha)
    const opened = lines.find(commit => commit.sha === state.diff)
    // Info's `local` / `remote` lines: every branch containing the selected
    // commit, fetched once per sha.
    const contains = isFiles || selected === undefined ? undefined : await containsOf($, cwd, selected.sha)
    const head0 = branches.find(branch => branch.isHead)
    // Info: every head line, windowed by `infoOffset`.
    const infoAll =
      details === undefined || isFiles || selected === undefined
        ? []
        : infoHead(details.head, selected, contains, head0?.name)
    const infoMax = Math.max(0, infoAll.length - infoInner)
    const infoOffset = clamp(state.infoOffset ?? 0, infoMax)
    const infoShown = infoAll.slice(infoOffset, infoOffset + infoInner)
    // Info's columns, past the frame and the vertical bar, scrolled by `infoLeft`.
    const infoCols = Math.max(1, infoWidth - 3)
    const infoWide = widest(infoAll)
    const infoLeftMax = Math.max(0, infoWide - infoCols)
    const infoLeft = clamp(state.infoLeft ?? 0, infoLeftMax)
    // Diff Preview: a few head lines, then the diff windowed by `detailOffset`.
    const headRows = Math.max(6, Math.floor(fullInner / 2))
    const previewHead = isFiles && details !== undefined ? details.head.slice(0, headRows) : []
    const diffRows = Math.max(1, fullInner - previewHead.length)
    const diffTotal = isFiles && details !== undefined ? diffLines(details.diff).length : 0
    // Diff Preview's columns, past the frame and the vertical bar, scrolled by
    // `detailLeft`. Measured over the whole diff, not the window, so the thumb
    // keeps its size while the diff scrolls. A body line sits after Code's
    // gutter, so it needs the gutter's columns more; head lines have none.
    const previewCols = columns - filesCols
    const detailCols = Math.max(1, previewCols - 3)
    const detailWide =
      isFiles && details !== undefined
        ? Math.max(widest(previewHead), diffWidthOf(details.diff))
        : 0
    const detailLeftMax = Math.max(0, detailWide - detailCols)
    const detailLeft = clamp(state.detailLeft ?? 0, detailLeftMax)
    if (head0 === undefined && unborn === undefined) {
      const before = threw
      const name = (await run($, root, headNameArgv()))?.trim()
      if (threw === before) unborn = name === undefined || name === '' ? null : name
    }
    const headName = head0?.name ?? unborn ?? undefined
    const branchRoom = Math.max(2, fullInner - 1)
    const tree = branchTree(branches, new Set(state.collapsed ?? []))
    const branchWin = windowOf(tree, -1, branchRoom, state.branchOffset ?? 0)
    const branchRows = branchWin.rows
    view.columns = columns
    view.area = area
    view.branchEnd = sideCols
    view.filesEnd = filesCols
    view.infoTop = (isGraph ? graphTop : topRows) + headerRows // the header lines sit above Commits or Graph
    view.branchMax = Math.max(0, tree.length - branchRoom)
    view.graphMax = Math.max(0, lines.length - graphRows)
    view.infoMax = infoMax
    view.infoRows = infoInner
    view.infoLeftMax = infoLeftMax
    view.detailLeftMax = detailLeftMax
    view.filesMax = Math.max(0, frows.length - changeRoom)
    view.detailMax = Math.max(0, diffTotal - diffRows)
    view.detailRows = diffRows
    const bar = (cells: string[]) => (
      <Box flexDirection="column" width={1} flexShrink={0}>
        {cells.map((cell, i) => (
          <Text key={'bar:' + i} color={cell === THUMB ? t.accent : t.muted}>
            {cell}
          </Text>
        ))}
      </Box>
    )

    // Draggable on surfaces that draw a `Client`, the Text column elsewhere;
    // `lead` blank rows sit above the bar (the section's header rows).
    const dragBar = (
      key: string,
      total: number,
      rows: number,
      offset: number,
      lead = 0,
    ) =>
      Client === undefined || total <= rows ? (
        bar([...Array.from({ length: lead }, () => ' '), ...scrollbar(total, rows, offset, rows)])
      ) : (
        <Box flexDirection="column" width={1} flexShrink={0}>
          {Array.from({ length: lead }, (_, i) => (
            <Text key={'lead:' + i}> </Text>
          ))}
          <Client
            key={key}
            module="../shared/scrollbar-client.tsx"
            props={{ total, visible: rows, offset, height: rows, color: t.accent }}
            width={1}
            height={rows}
          />
        </Box>
      )

    // A horizontal bar over a text section's bottom border: an absolute Box at
    // `top` (that border's row) in the section's unbordered wrapper, drawn after
    // the frame so it paints over it, `width` columns from the corner (the
    // right corner stays). Draggable on surfaces that draw a `Client`, a Text
    // row elsewhere; nothing while every line fits.
    const hbar = (
      key: string,
      total: number,
      visible: number,
      offset: number,
      top: number,
      width: number,
    ) =>
      total <= visible || width <= 0 ? null : (
        <Box position="absolute" top={top} left={1} flexDirection="row">
          {Client === undefined ? (
            scrollbar(total, visible, offset, width, { thumb: H_THUMB, track: H_TRACK }).map((cell, i) => (
              <Text key={'hbar:' + i} color={cell === H_THUMB ? t.accent : t.muted}>
                {cell}
              </Text>
            ))
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

    // The offset that keeps the selected commit in view; 0 with no selection.
    const offsetFor = (s: GitState, to: Tab): number => {
      const lines = graphCache.get(graphKey(s.ref, state.limit)) ?? []
      const at = lines.findIndex(commit => commit.sha === s.selected)

      return at < 0 ? 0 : windowOf(lines, at, to === 'graph' ? tabRows.graph : tabRows.overview, 0).offset
    }

    const showTab = (to: Tab) =>
      update($, git, s => ({
        ...s,
        tab: to,
        diff: undefined,
        diffFile: undefined,
        diffFileOffset: 0,
        detailOffset: 0,
        detailLeft: 0,
        infoOffset: 0,
        infoLeft: 0,
        ...(to === 'changelog' ? { changeOffset: 0 } : { offset: offsetFor(s, to) }),
      }))

    // The commit's diff view; the row's commit becomes the selected one. `back`
    // closes it, to the tab it was opened from (the tab is not changed).
    const openDiff = (sha: string) =>
      update($, git, s => ({
        ...selectCommit(s, sha),
        diff: sha,
        diffFile: undefined,
        diffFileOffset: 0,
        detailOffset: 0,
        detailLeft: 0,
      }))
    const closeDiff = () =>
      update($, git, s => ({
        ...s,
        diff: undefined,
        diffFile: undefined,
        diffFileOffset: 0,
        detailOffset: 0,
        detailLeft: 0,
      }))

    const toggleChange = (key: string) =>
      update($, git, s => ({ ...s, changeCollapsed: toggled(s.changeCollapsed ?? [], key) }))

    // The section's name sits on its top border. A bordered Box clips its
    // children, so the title is an absolute Box after it, at top={0}, in an
    // unbordered wrapper of the same size: a label (default foreground) on an
    // accent-tinted fill, pressing it does nothing.
    const titled = (key: string, name: string) => (
      <Box key={key + ':chrome'} position="absolute" top={0} left={1} backgroundColor={onDefaultFg(t.accent)}>
        <Text key={key}>{' ' + name + ' '}</Text>
      </Box>
    )

    // A Client on the seam, two cells across: the first section's last column
    // or row and the second's first (both frames' borders), so the seam takes
    // a grab from either side. Drawn last in the container holding both
    // sections, so it paints over both borders; `left`/`top` are relative to
    // that container and name the first section's border. `length` stops short
    // of the frames' corners. Surfaces without `Client` keep the plain borders.
    const splitter = (
      key: keyof typeof SEAMS,
      axis: 'x' | 'y',
      left: number,
      top: number,
      length: number,
      cells: number,
      marks?: readonly { row: number; text: string }[],
    ) =>
      Client === undefined ? null : (
        <Box position="absolute" top={top} left={left}>
          <Client
            key={key}
            module="../shared/splitter-client.tsx"
            props={{
              axis,
              length,
              cells,
              span: 2,
              color: border.borderColor,
              ...(marks === undefined ? {} : { marks }),
            }}
            width={axis === 'x' ? 2 : length}
            height={axis === 'x' ? length : 2}
          />
        </Box>
      )

    const branchColumn = (
      <Box flexDirection="column" width={sideCols} flexShrink={0} height={area}>
      <Box {...border} flexDirection="row" height="100%">
        <Box flexDirection="column" flexGrow={1}>
        <Box flexDirection="row" backgroundColor={state.ref === 'all' ? sel : undefined}>
          <Text color={t.accent}>{state.ref === 'all' ? '▌' : ' '}</Text>
          <Button key="all" plain label="All" onPress={asleep(() => selectRef($, 'all'))} />
        </Box>
        {branchRows.map((row: BranchRow) => {
          // Rails per depth as in the explorer; a folder opens or closes.
          const rails = '│ '.repeat(row.depth)
          const room = Math.max(4, sideWidth - 1 - rails.length)
          if (hasDots) {
            // A row Client (bar, rails, arrow or `*` slot, label), then a blank
            // 1-cell Button holding the keyboard ring: Enter selects a branch
            // or opens or closes a folder.
            const k = row.kind === 'branch' ? 'b:' + row.branch.name : row.key
            const isSelected = row.kind === 'branch' && state.ref === row.branch.name
            const cols = Math.max(1, sideWidth - 1)
            const text =
              row.kind === 'branch'
                ? row.name + (trackLabel(row.branch.track) === '' ? '' : ' ' + trackLabel(row.branch.track))
                : row.isGroup === true
                  ? row.name + ' (' + String(row.count ?? 0) + ')'
                  : row.name + '/'

            return (
              <Box key={'bline:' + k} flexDirection="row" backgroundColor={isSelected ? sel : undefined}>
                <Client
                  key={'bitem:' + k}
                  module="./branch-client.tsx"
                  props={{
                    depth: row.depth,
                    isFolder: row.kind === 'folder',
                    isGroup: row.kind === 'folder' && row.isGroup === true,
                    isOpen: row.kind === 'folder' && row.isOpen,
                    isSelected,
                    isRemote: row.kind === 'branch' ? row.branch.isRemote : row.key.startsWith('r:') && row.isGroup !== true,
                    isHead: row.kind === 'branch' && row.branch.isHead,
                    label: fit(text, Math.max(3, cols - 1 - rails.length - 2)),
                    colors: { accent: t.accent, muted: t.muted, selection: sel },
                  }}
                  width={cols}
                  height={1}
                />
                {row.kind === 'branch' ? (
                  <Button key={'branch:' + row.branch.name} plain label=" " onPress={() => selectRef($, row.branch.name)} />
                ) : (
                  <Button key={'bdir:' + row.key} plain label=" " onPress={() => toggleFolder($, row.key)} />
                )}
              </Box>
            )
          }
          if (row.kind === 'folder' && row.isGroup === true) {
            // A category row: `▾ Local (N)` / `▸ Remote (N)`, the whole label a
            // Button that opens or closes the group; the arrow is an accent Text
            // beside it (a Button has no color, and a Text over it blocks the press).
            const label = fit(row.name + ' (' + String(row.count ?? 0) + ')', room - 2)

            return (
              <Box key={'bline:' + row.key} flexDirection="row">
                <Text> </Text>
                <Text bold color={t.accent}>{row.isOpen ? '▾ ' : '▸ '}</Text>
                <Button key={'bdir:' + row.key} plain label={label} onPress={() => toggleFolder($, row.key)} />
              </Box>
            )
          }
          if (row.kind === 'folder') {
            return (
              <Box key={'bline:' + row.key} flexDirection="row">
                <Text> </Text>
                {row.depth > 0 && <Text color={t.muted}>{rails}</Text>}
                <Button
                  key={'bdir:' + row.key}
                  plain
                  dimColor={row.key.startsWith('r:')}
                  label={fit((row.isOpen ? '▾ ' : '▸ ') + row.name + '/', room)}
                  onPress={() => toggleFolder($, row.key)}
                />
              </Box>
            )
          }
          const { branch } = row
          const isSelected = state.ref === branch.name

          return (
            <Box
              key={'bline:' + branch.name}
              flexDirection="row"
              backgroundColor={isSelected ? sel : undefined}
            >
              <Text color={t.accent}>{isSelected ? '▌' : ' '}</Text>
              {row.depth > 0 && <Text color={t.muted}>{rails}</Text>}
              <Button
                key={'branch:' + branch.name}
                plain
                dimColor={branch.isRemote}
                label={fit(
                  (branch.isHead ? '* ' : '  ') +
                    row.name +
                    (trackLabel(branch.track) === '' ? '' : ' ' + trackLabel(branch.track)),
                  room,
                )}
                onPress={() => selectRef($, branch.name)}
              />
            </Box>
          )
        })}
        </Box>
        {dragBar('sb:branches', tree.length, branchRoom, branchWin.offset, 1)}
      </Box>
      {titled('title:branches', 'Branches')}
      </Box>
    )

    // Ref badges: HEAD accent, local branches green, remote branches grey, tags outlined.
    const refVariant = (ref: string): 'default' | 'success' | 'secondary' | 'outline' =>
      ref.startsWith('HEAD') ? 'default' : ref.startsWith('tag: ') ? 'outline' : remotes.has(ref) ? 'secondary' : 'success'
    // A Commits row's dot: the commit's lane color, `○` for a merge.
    const dotOf = (row: GraphRow) => ({
      glyph: row.commit.parents.length > 1 ? '○' : '●',
      color: lanes[row.color % PALETTE_SIZE] ?? t.text,
    })
    // The short shas' columns (git may lengthen one to keep it unique).
    const shortCols = win.rows.reduce((max, row) => Math.max(max, row.commit.short.length), 7)
    // Columns before the hash: Graph's lanes and their space, or Commits' dot and space.
    const leadCols = (wide: boolean) => (wide ? laneCols + 1 : DOT_COLS)

    // A Graph row's lanes, padded to the widest lanes in view plus a space.
    const lanesOf = (row: GraphRow) =>
      cellRuns(row.cells, laneCols + 1).map((seg, i) => (
        <Text key={'lane:' + i} color={lanes[seg.color % PALETTE_SIZE]}>
          {seg.text}
        </Text>
      ))

    // One commit row: lanes (Graph) or a dot (Commits), marked short sha, refs,
    // subject; `wide` adds the dim author and date columns. Where the hash
    // Client is drawn, the lanes, dot and hash are columns of their own and the
    // row starts at the refs; its subject Button then holds `commit:<sha>`.
    const commitRow = (row: GraphRow, width: number, wide: boolean) => {
      const { commit } = row
      const isSelected = commit.sha === selected?.sha
      const pick = () =>
        update($, git, s => selectCommit(s, commit.sha))
      // Commits: a dot and a space instead of the lanes (`graphColumns` adds
      // the lanes' trailing space itself).
      const cols = graphColumns(width, wide ? laneCols : DOT_COLS - 1, wide)
      // refs that fit ~40% of the subject's room, the rest as `…`
      const refs: string[] = []
      let used = 0
      for (const ref of commit.refs) {
        // a badge is the ref and a cap on each side, then a space
        if (used + ref.length + 3 > Math.floor(cols.subject * 0.4)) {
          refs.push('…')
          used += 2
          break
        }
        refs.push(ref)
        used += ref.length + 3
      }
      const subjectCols = Math.max(1, cols.subject - used)
      const autoFocus = keyOf(commit) === focusKey ? true : undefined

      return (
        <Box
          key={'row:' + commit.sha}
          flexDirection="row"
          backgroundColor={isSelected ? sel : undefined}
        >
          {!hasDots &&
            (wide ? (
              lanesOf(row)
            ) : (
              <Text key="dot" color={dotOf(row).color}>
                {dotOf(row).glyph + ' '}
              </Text>
            ))}
          {!hasDots && (
            <Button
              key={keyOf(commit)}
              plain
              dimColor
              autoFocus={autoFocus}
              label={(isSelected ? '>' : ' ') + commit.short}
              onPress={pick}
            />
          )}
          {!hasDots && <Text> </Text>}
          {refs.map((ref, i) =>
            ref === '…' ? (
              <Text key={'ref:' + i} color={t.muted}>
                {'… '}
              </Text>
            ) : (
              <Box key={'ref:' + i} flexDirection="row">
                {Badge(elements, t, { label: ref, variant: refVariant(ref) })}
                <Text> </Text>
              </Box>
            ),
          )}
          <Button
            key={hasDots ? keyOf(commit) : 'subject:' + commit.sha}
            plain
            autoFocus={hasDots ? autoFocus : undefined}
            label={fit(commit.subject, subjectCols).padEnd(subjectCols)}
            onPress={pick}
          />
          {cols.author > 0 && (
            <Text key={'author:' + commit.sha} color={t.muted}>
              {' ' + fit(commit.author, cols.author).padEnd(cols.author)}
            </Text>
          )}
          {cols.date > 0 && (
            <Text key={'date:' + commit.sha} color={t.muted}>
              {' ' + commit.date.padEnd(cols.date)}
            </Text>
          )}
          {/* `⧉`, right-aligned in DIFF_COLS: one cell always stays between the
              date and it. */}
          <Box width={DIFF_COLS} flexShrink={0} justifyContent="flex-end">
            <Button
              key={'diff:' + commit.sha}
              plain
              label="⧉"
              onPress={asleep(() => openDiff(commit.sha))}
            />
          </Box>
        </Box>
      )
    }

    // The windowed commit list with `more` and its scrollbar, as drawn in Commits
    // (compact) and Graph (wide). Where a `Client` is drawn, the rows are three
    // parallel columns: Graph's lanes, the hash Client (Commits' dot, the marker
    // and the hash; it reports a resting pointer and a press), and the rest of
    // each row. Each column paints the selected row's background.
    const commitList = (width: number, wide: boolean) => (
      <Box {...border} flexDirection="row" height="100%">
        <Box flexDirection="column" flexGrow={1}>
          {lines.length === 0 && <Text color={t.muted}>(no commits)</Text>}
          {hasDots && Client !== undefined && win.rows.length > 0 ? (
            <Box flexDirection="row">
              {wide && (
                <Box flexDirection="column" flexShrink={0} width={leadCols(true)}>
                  {win.rows.map(row => (
                    <Box
                      key={'lanes:' + row.commit.sha}
                      flexDirection="row"
                      backgroundColor={row.commit.sha === selected?.sha ? sel : undefined}
                    >
                      {lanesOf(row)}
                    </Box>
                  ))}
                </Box>
              )}
              <Client
                key={wide ? 'shas' : 'dots'}
                module="./dots-client.tsx"
                props={{
                  rows: win.rows.map(row => ({
                    ...(wide ? {} : dotOf(row)),
                    mark: row.commit.sha === selected?.sha ? '>' : ' ',
                    short: row.commit.short.padEnd(shortCols),
                  })),
                  background: sel,
                }}
                width={(wide ? 0 : DOT_COLS) + 1 + shortCols + 1}
                height={win.rows.length}
              />
              <Box flexDirection="column" flexGrow={1}>
                {win.rows.map(row => commitRow(row, width, wide))}
              </Box>
            </Box>
          ) : (
            win.rows.map(row => commitRow(row, width, wide))
          )}
          {isMore && (
            <Button
              key="more"
              plain
              label={`More (+${page})`}
              onPress={() => update($, git, s => ({ ...s, limit: state.limit + page }))}
            />
          )}
        </Box>
        {dragBar('sb:graph', lines.length, graphRows, win.offset)}
      </Box>
    )

    // The hovered commit's branches: a framed card over Commits or Graph
    // (`wide`), `cols` × `rows`, its top on the row's line just past the hash;
    // flipped to end on that line when it would pass the section's bottom
    // border (the seam above Info), and kept inside the section's width.
    const hoverCard = (wide: boolean, cols: number, rows: number) => {
      if (hovered === undefined || !hasDots) return null
      const at = commitWindow.shas.indexOf(hovered)
      const commit = win.rows[at]?.commit
      if (commit === undefined) return null
      const names = containsCache.get(commit.sha)
      const title = 'Branches · ' + commit.short
      type Item = { text: string; isDim?: boolean; isBold?: boolean }
      // One group: its bold heading, its first `cap` names and `+N more`;
      // nothing when empty.
      const group = (heading: string, all: readonly string[], cap: number, isDim: boolean): Item[] => {
        if (all.length === 0) return []
        const shown = all.slice(0, cap)

        return [
          { text: heading, isBold: true },
          ...shown.map(name => ({ text: (name === head0?.name ? '* ' : '  ') + name, isDim })),
          ...(all.length > shown.length ? [{ text: `  +${all.length - shown.length} more`, isDim: true }] : []),
        ]
      }
      const items: Item[] =
        names === undefined
          ? [{ text: '…', isDim: true }]
          : names.local.length === 0 && names.remote.length === 0
            ? [{ text: '(none)', isDim: true }]
            : [
                ...group('Local', names.local, names.remote.length === 0 ? CARD_NAMES : CARD_NAMES / 2, false),
                ...group('Remote', names.remote, names.local.length === 0 ? CARD_NAMES : CARD_NAMES / 2, true),
              ]
      // frame and one column of padding a side
      const width = Math.min(cols, Math.max(title.length, ...items.map(item => item.text.length)) + 4)
      const height = items.length + 3
      const row = 1 + at // the section's top border is line 0
      const bottom = rows - 1 // the bottom border's line
      const top = row + height <= bottom ? row : Math.max(0, row + 1 - height)
      const left = Math.max(0, Math.min(1 + leadCols(wide) + 1 + shortCols + 1, cols - width))
      const room = Math.max(1, width - 4)

      return (
        <Box
          key="card"
          position="absolute"
          top={top}
          left={left}
          width={width}
          flexDirection="column"
          borderStyle="round"
          borderColor={t.borderStrong}
          backgroundColor={t.surface}
          paddingX={1}
        >
          <Text bold color={t.accent}>{fit(title, room)}</Text>
          {items.map((item, i) => (
            <Text key={'card:' + i} color={item.isDim === true ? t.muted : t.text} bold={item.isBold === true ? true : undefined}>
              {fit(item.text, room)}
            </Text>
          ))}
        </Box>
      )
    }

    const commitsSection = (
      <Box flexDirection="column" width={rightCols} flexShrink={0} height={topRows}>
        {commitList(graphWidth, false)}
        {titled('title:commits', 'Commits')}
        {hoverCard(false, rightCols, topRows)}
      </Box>
    )

    const graphSection = (
      <Box flexDirection="column" width={columns} flexShrink={0} height={graphTop}>
        {commitList(graphWidth, true)}
        {titled('title:graph', 'Graph')}
        {hoverCard(true, columns, graphTop)}
      </Box>
    )

    // Info, `width` × `rows`: Overview's right column under Commits, or the
    // panel under Graph.
    const infoSection = (width: number, rows: number) => (
      <Box flexDirection="column" width={width} flexShrink={0} height={rows}>
      <Box {...border} flexDirection="row" height="100%">
        <Box flexDirection="column" flexGrow={1}>
        {details === undefined && <Text color={t.muted}>Select a commit.</Text>}
        {infoShown.map((text, i) => (
          <Text key={'info:' + (infoOffset + i)} bold={infoOffset + i === 0} color={infoOffset + i === 0 ? t.accent : t.text} wrap="truncate-end">
            {sliceCols(text, infoLeft) || ' '}
          </Text>
        ))}
        </Box>
        {dragBar('sb:info', infoAll.length, infoInner, infoOffset)}
      </Box>
      {hbar('hb:info', infoWide, infoCols, infoLeft, rows - 1, infoCols)}
      </Box>
    )

    // Files | Diff Preview across the panel. `rows` is the list as drawn (a window
    // of it from `fileOffset`), `selected` the path shown, `details` its head
    // lines and diff, `previewOffset` the first diff line, `focus` the key
    // autoFocus lands on, `title` the Files title. File rows are keyed
    // `<keyPrefix><path>` and their scrollbar `barKey`: Change Log feeds it the
    // working tree (`change:`, `sb:changes`), the diff view a commit's files
    // (`dfile:`, `sb:dfiles`).
    // Files | Diff Preview (Change Log, the diff view): the Files rows, chosen
    // file and its details are the ones worked out above.
    const filesAndPreview = (p: {
      title: string
      barKey: string
      emptyText: string
      noneText: string
      onPick: (path: string) => void
    }) => {
      const filesWidth = filesCols - 5
      const pOffset = clamp(state.detailOffset ?? 0, diffTotal - diffRows)
      const pDiff = details === undefined ? '' : sliceDiff(details.diff, pOffset, diffRows)

      return (
        <Box flexDirection="row">
          <Box flexDirection="column" width={filesCols} flexShrink={0} height={area}>
          <Box {...border} flexDirection="row" height="100%">
            <Box flexDirection="column" flexGrow={1}>
              {frows.length === 0 && <Text color={t.muted}>{p.emptyText}</Text>}
              {cwin.rows.map(row => {
                const rails = '│ '.repeat(row.depth)
                if (row.kind === 'folder') {
                  return (
                    <Box key={'cline:' + row.key} flexDirection="row">
                      <Text> </Text>
                      {row.depth > 0 && <Text color={t.muted}>{rails}</Text>}
                      <Button
                        key={'cdir:' + row.key}
                        plain
                        label={fit((row.isOpen ? '▾ ' : '▸ ') + row.name + '/', filesWidth - 1 - rails.length)}
                        onPress={() => toggleChange(row.key)}
                      />
                    </Box>
                  )
                }
                const change = row.item
                const isSelected = change.path === chosen?.path
                const glyph = changeGlyph(change)
                const label = fitStart(row.name, Math.max(4, filesWidth - 3 - rails.length))
                const slash = label.lastIndexOf('/')

                return (
                  <Box
                    key={'cline:' + change.path}
                    flexDirection="row"
                    backgroundColor={isSelected ? sel : undefined}
                  >
                    <Text color={t.accent}>{isSelected ? '▌' : ' '}</Text>
                    {row.depth > 0 && <Text color={t.muted}>{rails}</Text>}
                    <Text bold color={glyphColor(t, glyph)}>
                      {glyph}
                    </Text>
                    <Text> </Text>
                    {slash >= 0 && <Text color={t.muted}>{label.slice(0, slash + 1)}</Text>}
                    <Button
                      key={fileKey + change.path}
                      plain
                      autoFocus={fileKey + change.path === changeFocus ? true : undefined}
                      label={label.slice(slash + 1)}
                      onPress={() => p.onPick(change.path)}
                    />
                  </Box>
                )
              })}
            </Box>
            {dragBar(p.barKey, frows.length, changeRoom, cwin.offset)}
          </Box>
            {/* The name chip: name + 2 cells from column 1, short of the far corner. */}
            {titled('title:files', fit(p.title, Math.max(5, filesCols - 5)))}
          </Box>
          <Box flexDirection="column" width={previewCols} flexShrink={0} height={area}>
          <Box {...border} flexDirection="row" height="100%">
            <Box flexDirection="column" flexGrow={1}>
            {details === undefined && <Text color={t.muted}>{p.noneText}</Text>}
            {previewHead.map((text, i) => (
              <Text key={'head:' + i} bold={i === 0} color={i === 0 ? t.accent : t.text} wrap="truncate-end">
                {sliceCols(text, detailLeft) || ' '}
              </Text>
            ))}
            {pDiff !== '' && <Code source={sliceDiffCols(pDiff, detailLeft)} format="diff" wrap="truncate-end" />}
            {details !== undefined && pDiff === '' && (
              <Text color={t.muted}>
                {/^(Binary files|GIT binary patch)/m.test(details.diff)
                  ? 'Binary file.'
                  : 'No textual changes.'}
              </Text>
            )}
            </Box>
            {dragBar('sb:details', diffTotal, diffRows, pOffset, previewHead.length)}
          </Box>
          {titled('title:diff', 'Diff Preview')}
          {hbar('hb:details', detailWide, detailCols, detailLeft, area - 1, detailCols)}
          </Box>
          {splitter('split:files', 'x', filesCols - 1, 1, area - 2, filesCols)}
        </Box>
      )
    }

    const TAB_LABEL = { overview: 'Overview', graph: 'Graph', changelog: 'Change Log' } as const

    return own(
      <Box flexDirection="column" width="100%" minHeight={bodyRows} backgroundColor={t.canvas}>
        {/* The title, the panel tabs and the actions, 2 cells apart with a
            divider after the title and after the tabs, cut at the right end on
            a narrow pane (kept for Settings). */}
        <Box key="header" flexDirection="row" justifyContent="space-between" alignItems="center" height={1}>
          <Box key="header:tabs" flexDirection="row" gap={2} flexShrink={1} overflow="hidden">
            <Box flexShrink={0}>
              <Text bold color={t.text}>{' Git'}</Text>
            </Box>
            <Box flexShrink={0}>
              <Text color={t.border}>|</Text>
            </Box>
            <Box flexShrink={0}>
              {Tabs(elements, t, {
                gap: 2,
                surface,
                tabs: (['overview', 'graph', 'changelog'] as const).map(id => ({ id, label: TAB_LABEL[id] })),
                selected: tab,
                onSelect: asleep((id: string) => showTab(id as Tab)),
              })}
            </Box>
            <Box flexShrink={0}>
              <Text color={t.border}>|</Text>
            </Box>
            {isDiff && (
              <Box flexShrink={0}>
                {Btn(elements, t, { key: 'back', label: 'Back', variant: 'secondary', surface, onPress: asleep(closeDiff) })}
              </Box>
            )}
            <Box flexShrink={0}>
              {Btn(elements, t, {
                key: 'fetch',
                label: busy === 'fetch' ? 'Fetching…' : 'Fetch',
                variant: 'ghost',
                surface,
                onPress: asleep(() => remote($, 'fetch')),
              })}
            </Box>
            <Box flexShrink={0}>
              {Btn(elements, t, {
                key: 'pull',
                label: busy === 'pull' ? 'Pulling…' : 'Pull',
                variant: 'primary',
                surface,
                onPress: asleep(() => remote($, 'pull')),
              })}
            </Box>
            <Box flexShrink={0}>
              {Btn(elements, t, {
                key: 'push',
                label: busy === 'push' ? 'Pushing…' : 'Push',
                variant: 'secondary',
                surface,
                onPress: asleep(() => remote($, 'push')),
              })}
            </Box>
          </Box>
          {paneButtons !== undefined && <Box flexShrink={0}>{paneButtons}</Box>}
        </Box>
        {isDiff ? (
          filesAndPreview({
            title: 'Files · ' + (opened === undefined ? (state.diff ?? '').slice(0, 7) : opened.short + ' ' + opened.subject),
            barKey: 'sb:dfiles',
            emptyText: 'No files changed',
            noneText: 'Select a file.',
            onPick: path =>
              update($, git, s => ({
                ...s,
                diffFile: path,
                detailOffset: s.diffFile === path ? s.detailOffset : 0,
                detailLeft: s.diffFile === path ? s.detailLeft : 0,
              })),
          })
        ) : isChanges ? (
          filesAndPreview({
            title: 'Files',
            barKey: 'sb:changes',
            emptyText: 'Working tree clean',
            noneText: 'Select a change.',
            onPick: path =>
              update($, git, s => ({
                ...s,
                change: path,
                detailOffset: s.change === path ? s.detailOffset : 0,
                detailLeft: s.change === path ? s.detailLeft : 0,
              })),
          })
        ) : isGraph ? (
          <Box flexDirection="column">
            {graphSection}
            {infoSection(columns, infoRows)}
            {splitter('split:graph', 'y', 1, graphTop - 1, columns - 2, graphTop)}
            {/* Info's title sits on the row the seam covers: drawn after it */}
            <Box position="absolute" top={graphTop} left={0}>
              {titled('title:info', 'Info')}
            </Box>
          </Box>
        ) : (
          <Box flexDirection="row">
            {branchColumn}
            <Box flexDirection="column">
              {commitsSection}
              {infoSection(rightCols, infoRows)}
              {splitter('split:info', 'y', 1, topRows - 1, rightCols - 2, topRows)}
              {/* Info's title sits on the row the seam covers: drawn after it */}
              <Box position="absolute" top={topRows} left={0}>
                {titled('title:info', 'Info')}
              </Box>
            </Box>
            {/* the seam's second column is the right column's left border: keep
                Commits' bottom-left and Info's top-left corners (rows from top=1) */}
            {splitter('split:side', 'x', sideCols - 1, 1, area - 2, sideCols, [
              { row: topRows - 2, text: '╰' },
              { row: topRows - 1, text: '╭' },
            ])}
          </Box>
        )}
        <Box flexDirection="row" justifyContent="space-between" gap={2}>
          <Box flexShrink={1} flexDirection="row" gap={1}>
            <Text key="footer:dir" wrap="truncate-start" color={t.muted}>{' ' + shortDir(root, home)}</Text>
            {Badge(elements, t, { key: 'footer:branch', label: headName ?? 'detached', variant: 'outline' })}
          </Box>
          <Box key="footer:counts" flexShrink={0} paddingRight={1} flexDirection="row" gap={1}>
            {Badge(elements, t, { label: `+${counts.added}`, variant: isClean ? 'secondary' : 'success' })}
            {Badge(elements, t, { label: `~${counts.modified}`, variant: isClean ? 'secondary' : 'outline' })}
            {Badge(elements, t, { label: `-${counts.deleted}`, variant: isClean ? 'secondary' : 'destructive' })}
          </Box>
        </Box>
        {settingsSheet}
      </Box>
    )
  })
}
