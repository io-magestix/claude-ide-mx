// The split layout (Settings `layout: 'split'`): one pane, `ide-split`, the
// Explorer on top and Git below, instead of the two panes as tabs. Pure
// helpers, plus `seat`: what the two panels' hooks share about it.
import type { RenderElement } from 'claude-code'

import { splitAt } from './split'

export const EXPLORER_PANE = 'ide-explorer'
export const SPLIT_PANE = 'ide-split'
export const SPLIT_TITLE = 'IDE'

// The Explorer's share of the split pane's rows (Git takes the rest), until
// the seam between them is dragged (`explorer.split.panels`).
export const SPLIT_TOP = 0.7
// The split pane's share of the window's columns when it opens docked.
export const SPLIT_WIDTH = 0.2
// The fewest columns it asks for: below this Git's two columns do not fit.
export const MIN_SPLIT_COLUMNS = 24
// The fewest rows a half keeps: header lines, a framed section, the footer.
export const MIN_HALF_ROWS = 8
// Git's rows while the root is not in a repo: its title, the note, `refresh`.
export const NO_REPO_ROWS = 3

// Every key of Git's half is prefixed, so its elements never share a key
// with the Explorer's (`refresh`, `settings`, `header`, ...).
export const GIT_PREFIX = 'git/'

// The columns the split pane asks for in a window `window` columns wide.
export const splitColumns = (window: number): number =>
  Math.max(MIN_SPLIT_COLUMNS, Math.round(window * SPLIT_WIDTH))

// The split pane's rows: the Explorer's `top` rows, the seam's one row, then
// Git's `bottom` rows from row `gitTop`. Outside a repo Git keeps only its
// NO_REPO_ROWS and the Explorer takes the rest.
export const splitRows = (
  bodyRows: number,
  fraction: number | undefined,
  isRepo = true,
): { top: number; bottom: number; gitTop: number } => {
  const room = Math.max(0, bodyRows - 1)
  const top = isRepo
    ? splitAt(room, fraction ?? SPLIT_TOP, MIN_HALF_ROWS)
    : Math.max(0, room - Math.min(NO_REPO_ROWS, Math.floor(room / 2)))

  return { top, bottom: room - top, gitTop: top + 1 }
}

// `tree` with `prefix` before every key; the rest of each element as it was.
// A tree as JSX builds it keeps the key and children in `props`; one that has
// come back through `next(e)` also has them on the element itself.
export const prefixKeys = (tree: RenderElement, prefix: string): RenderElement => {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk)
    if (typeof node !== 'object' || node === null || !('props' in node)) return node
    const element = { ...(node as Record<string, unknown>) }
    const props = { ...(element.props as Record<string, unknown>) }
    if (typeof props.key === 'string') props.key = prefix + props.key
    if ('children' in props) props.children = walk(props.children)
    element.props = props
    if (typeof element.key === 'string') element.key = prefix + element.key
    if ('children' in element) element.children = walk(element.children)

    return element
  }

  return walk(tree) as RenderElement
}

// A key of Git's half without its prefix; undefined when it is not Git's.
export const gitKeyOf = (key: string | undefined): string | undefined =>
  key !== undefined && key.startsWith(GIT_PREFIX) ? key.slice(GIT_PREFIX.length) : undefined

// Shared by the two panels' hooks (module state, reset by a reload and set
// again by the next drawing): the window's columns as `/ide-panels` last saw
// them, the rows of Git's half as the split pane last drew it, and a switch
// of layout under way.
export const seat = {
  windowColumns: 0,
  gitTop: 0,
  gitRows: 0,
  // The layout a switch is closing panes for: a close the unsaved-changes bar
  // holds meanwhile seats it once answered.
  switching: undefined as 'tabs' | 'split' | undefined,
}
