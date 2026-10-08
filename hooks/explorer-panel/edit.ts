import { mixHex } from '../shared/color'
import type { Theme } from '../shared/theme'
import { assemble } from './editor'
import type { Keymap } from './editor'
import { hashOf } from './preview'

// Pure helpers of the Edit section's hook side: draft file names and the
// assembly of chunked messages from the editor client.

// FNV-1a, two seeds: 16 hex digits name a draft without a path in the file name.
export const hashPath = (path: string): string => hashOf(path) + hashOf(path, 0x01234567)

export const DRAFT_DIR = '.claude/ide-panes/drafts'

export const draftFile = (home: string, path: string): string =>
  `${home.replace(/\/$/, '')}/${DRAFT_DIR}/${hashPath(path)}.txt`

// The editor's colors, from the theme (`editorColors` below).
type EditorColors = {
  text: string
  gutter: string // line numbers
  caret: string // the caret cell's background
  caretText: string // the caret cell's text
  selection: string // a selected run's background
}

// The editor's colors in a theme: text and a muted gutter, the caret as the
// text inverted, a selection of the accent sunk 65% into the background.
export const editorColors = (t: Theme): EditorColors => ({
  text: t.text,
  gutter: t.muted,
  caret: t.text,
  caretText: t.bg,
  selection: mixHex(t.accent, t.bg, 0.65),
})

// Props of the editor client (editor-client.tsx), built by the hook.
export type EditorProps = {
  path: string
  language: string // '' when none (no comment prefix)
  colors: EditorColors // the theme's, for the drawing
  keymap: Keymap
  rows: number // the region's rows and columns as the hook laid them out
  columns: number
  version: number // a new one drops the buffer and loads again
  chunk: string // the text's chunk `index` of `total`; '' when none
  index: number // -1: nothing sent yet; `total`: all delivered
  total: number
  isDraft: boolean // the text is a draft: dirty from the start
  ack: string // id of the last message the hook took
  saved: number // seq of the last save the hook wrote
  // A border Button's action (an `editor.ts` action, `save`, `overwrite`),
  // `scroll` (moves the window `by` rows) or `left` (the horizontal bar
  // dragged: `by` is the first column shown); `scroll` and `left` leave the
  // cursor where it is. Applied once per `commandSeq`.
  command: string
  commandSeq: number
  by: number
}

// The client's horizontal view, posted as `{ hview, version }` whenever one
// of its numbers changes (an edit, a cursor move, a `left` command, a resize):
// the Edit section's bar draws from the latest. Columns are the editor's own:
// one per UTF-16 unit, a tab one cell.
export type HView = {
  left: number // the first column shown
  widest: number // the longest line's length
  width: number // the text columns (the region less the line-number gutter)
}

export const parseHView = (data: unknown): HView | undefined => {
  const d = data as Partial<Record<keyof HView, unknown>> | null
  if (d === null || typeof d !== 'object') return undefined
  const { left, widest, width } = d
  for (const n of [left, widest, width]) {
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) return undefined
  }

  return { left: left as number, widest: widest as number, width: width as number }
}

// Chunk size both ways: under the 100,000-char bound of props and posts,
// with room for JSON escapes and the other fields.
export const TRANSFER_CHUNK = 80_000

// One chunk of a text the client sends: a draft or a save.
export type ChunkMsg = {
  kind: 'draft' | 'save'
  version: number
  seq: number
  index: number
  total: number
  chunk: string
  force?: boolean // a save that overwrites a file changed on disk
}

export const parseChunk = (data: unknown): ChunkMsg | undefined => {
  const d = data as Partial<Record<keyof ChunkMsg, unknown>> | null
  if (d === null || typeof d !== 'object') return undefined
  const { kind, version, seq, index, total, chunk, force } = d
  if (kind !== 'draft' && kind !== 'save') return undefined
  if (typeof version !== 'number' || typeof seq !== 'number') return undefined
  if (typeof index !== 'number' || typeof total !== 'number') return undefined
  if (typeof chunk !== 'string') return undefined
  if (!Number.isInteger(index) || !Number.isInteger(total)) return undefined
  if (total < 1 || total > 64 || index < 0 || index >= total) return undefined

  return { kind, version, seq, index, total, chunk, ...(force === true ? { force: true } : {}) }
}

// The text being collected for one (kind, version, seq).
export type Incoming = {
  kind: ChunkMsg['kind']
  version: number
  seq: number
  parts: (string | undefined)[]
  // Set once the text was handed out, so a repeated last chunk does not
  // trigger the write again.
  isDone: boolean
}

// Adds a chunk; `text` is set only by the chunk that completes the text.
export const accept = (
  current: Incoming | undefined,
  msg: ChunkMsg,
): { incoming: Incoming; text?: string } => {
  const same =
    current !== undefined &&
    current.kind === msg.kind &&
    current.version === msg.version &&
    current.seq === msg.seq &&
    current.parts.length === msg.total
  const incoming: Incoming = same
    ? current
    : {
        kind: msg.kind,
        version: msg.version,
        seq: msg.seq,
        parts: Array.from({ length: msg.total }, () => undefined),
        isDone: false,
      }
  incoming.parts[msg.index] = msg.chunk
  if (incoming.isDone) return { incoming }
  const text = assemble(incoming.parts)
  if (text === undefined) return { incoming }
  incoming.isDone = true

  return { incoming, text }
}
