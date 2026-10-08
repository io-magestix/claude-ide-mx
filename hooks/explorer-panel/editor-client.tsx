import type {
  ClientKeyEvent,
  ClientModule,
  ClientPointerEvent,
  ClientSurface,
  JsonValue,
} from 'claude-code'

import {
  ACTIONS,
  addCursor,
  applyAction,
  chunks,
  commentOf,
  cursorAt,
  endOf,
  extendTo,
  fromText,
  insert,
  isDirty,
  keyOp,
  paste,
  setCursor,
  startOf,
  toText,
} from './editor'
import type { Action, Buffer, Pos } from './editor'
import { TRANSFER_CHUNK } from './edit'
import type { EditorProps, HView } from './edit'

// The Edit section's surface module: holds the buffer, maps keys and the
// pointer to `editor.ts` ops and draws the visible rows. The hooks module
// (index.tsx) owns the file: text arrives in chunks through props, and every
// message back (`need`, `dirty`, `hview`, draft and save chunks, `copy`) waits in an
// outbox until the props ack it, resent every 1.2 s.

type Outgoing = { id: string; data: { [key: string]: JsonValue }; sentAt?: number }

// Mutable cells shared by the module's calls, its listeners and its timer;
// `setState({ cells })` only schedules the redraw.
type Cells = {
  props: EditorProps
  nonce: string
  counter: number
  // Loading: the version being collected and its parts.
  loading?: { version: number; parts: (string | undefined)[] }
  // Loaded: the buffer of `version` and the text it was loaded or saved as.
  version?: number
  buffer?: Buffer
  original: string
  isDirty: boolean
  top: number
  left: number
  // Length of the longest line in the editor's columns (one per UTF-16 unit,
  // a tab one cell, as drawn below): the horizontal bar's total.
  widest: number
  // The `hview` last queued, so an unchanged view is not sent again.
  hview?: HView
  drag?: number // the cursor index a held pointer extends
  outbox: Outgoing[]
  tick: number
  idle: number // ticks since the last edit
  isDraftDue: boolean
  saveSeq: number
  saving?: { seq: number; text: string }
  draftSeq: number
  commandSeq: number
}
type State = { cells: Cells }

const TICK_MS = 200
const RESEND_TICKS = 6 // 1.2 s
const DRAFT_TICKS = 5 // 1 s idle
const SPECIAL = /^(up|down|left|right|home|end|pageup|pagedown|return|enter|tab|backspace|delete|insert|escape|f\d+)$/

const rowsOf = (surface: ClientSurface<State>, cells: Cells): number =>
  Math.max(1, surface.rows > 0 ? surface.rows : cells.props.rows)

const columnsOf = (surface: ClientSurface<State>, cells: Cells): number =>
  Math.max(1, surface.columns > 0 ? surface.columns : cells.props.columns)

const gutterOf = (buffer: Buffer): number => String(buffer.lines.length).length + 1

// Text columns: the region less the line-number gutter.
const textWidthOf = (surface: ClientSurface<State>, cells: Cells, buffer: Buffer): number =>
  Math.max(1, columnsOf(surface, cells) - gutterOf(buffer))

const widestOf = (lines: readonly string[], from = 0, to = lines.length): number => {
  let most = 0
  for (let i = from; i < to; i++) most = Math.max(most, lines[i]!.length)

  return most
}

// `widest` after the lines `was` became `next`: the changed run is what lies
// between the common head and tail (unchanged lines keep their string, so the
// scan is mostly reference compares). Every line is measured again only when
// a widest line left that run and nothing as wide came in.
const widestAfter = (widest: number, was: readonly string[], next: readonly string[]): number => {
  const shorter = Math.min(was.length, next.length)
  let head = 0
  while (head < shorter && was[head] === next[head]) head++
  let tail = 0
  while (tail < shorter - head && was[was.length - 1 - tail] === next[next.length - 1 - tail]) tail++
  const added = widestOf(next, head, next.length - tail)
  if (added >= widest) return added
  if (widestOf(was, head, was.length - tail) < widest) return widest

  return widestOf(next)
}

// --------------------------------------------------------------- outbox

const post = (surface: ClientSurface<State>, cells: Cells): void => {
  const head = cells.outbox[0]
  if (head === undefined || head.sentAt !== undefined) return
  head.sentAt = cells.tick
  surface.post({ ...head.data, id: head.id })
}

// `drop` removes queued (not yet posted) messages the new one supersedes.
const send = (
  surface: ClientSurface<State>,
  cells: Cells,
  data: { [key: string]: JsonValue },
  drop?: (data: { [key: string]: JsonValue }) => boolean,
): void => {
  if (drop !== undefined) {
    cells.outbox = cells.outbox.filter(m => m.sentAt !== undefined || !drop(m.data))
  }
  cells.counter += 1
  cells.outbox.push({ id: cells.nonce + ':' + cells.counter, data })
  post(surface, cells)
}

const sendText = (
  surface: ClientSurface<State>,
  cells: Cells,
  kind: 'draft' | 'save',
  seq: number,
  text: string,
  force = false,
): void => {
  const parts = chunks(text, TRANSFER_CHUNK)
  const version = cells.version ?? -1
  // A newer draft or save replaces the queued parts of an older draft.
  const isOldDraft = (d: { [key: string]: JsonValue }) => d.kind === 'draft'
  parts.forEach((chunk, index) =>
    send(
      surface,
      cells,
      { kind, version, seq, index, total: parts.length, chunk, ...(force ? { force } : {}) },
      index === 0 ? isOldDraft : undefined,
    ),
  )
}

const markDirty = (surface: ClientSurface<State>, cells: Cells, isNow: boolean): void => {
  if (isNow === cells.isDirty) return
  cells.isDirty = isNow
  send(surface, cells, { dirty: isNow, version: cells.version ?? -1 }, d => 'dirty' in d)
}

// Tells the hook the horizontal view (the Edit section's bar) when it changed:
// the first column shown, the longest line and the text columns.
const syncView = (surface: ClientSurface<State>, cells: Cells, width: number): void => {
  if (cells.buffer === undefined || cells.version === undefined) return
  const was = cells.hview
  if (was !== undefined && was.left === cells.left && was.widest === cells.widest && was.width === width) return
  const hview = { left: cells.left, widest: cells.widest, width }
  cells.hview = hview
  send(surface, cells, { hview, version: cells.version }, d => 'hview' in d)
}

// ----------------------------------------------------------------- props

// New props: take a chunk, an ack, a save mark or a command. Mutates the
// cells only; the caller is drawing (or about to), so no setState.
const take = (surface: ClientSurface<State>, cells: Cells, props: EditorProps): void => {
  cells.props = props
  const head = cells.outbox[0]
  if (head !== undefined && head.id === props.ack) {
    cells.outbox.shift()
  }
  if (props.version !== cells.version && cells.loading?.version !== props.version) {
    // A new version: drop the buffer and what was queued for the old one.
    cells.version = undefined
    cells.buffer = undefined
    cells.saving = undefined
    cells.isDirty = false
    cells.isDraftDue = false
    cells.outbox = []
    cells.hview = undefined
    cells.loading = { version: props.version, parts: [] }
    send(surface, cells, { need: 0, version: props.version })
  }
  const loading = cells.loading
  if (
    loading !== undefined &&
    loading.version === props.version &&
    props.total > 0 &&
    props.index >= 0 &&
    props.index < props.total &&
    loading.parts[props.index] === undefined
  ) {
    if (loading.parts.length !== props.total) {
      loading.parts = Array.from({ length: props.total }, () => undefined)
    }
    loading.parts[props.index] = props.chunk
    // The chunk answers the `need`: drop it, ask for the next missing one.
    cells.outbox = cells.outbox.filter(m => !('need' in m.data))
    const next = loading.parts.findIndex(part => part === undefined)
    if (next >= 0) {
      send(surface, cells, { need: next, version: props.version })
    } else {
      const text = loading.parts.join('')
      cells.loading = undefined
      cells.version = props.version
      cells.buffer = fromText(text)
      // A draft differs from the file by definition: no undo makes it clean,
      // only a save does.
      cells.original = props.isDraft ? '\0' : text
      cells.top = 0
      cells.left = 0
      cells.widest = widestOf(cells.buffer.lines)
      cells.isDirty = props.isDraft
      cells.commandSeq = props.commandSeq
      // `need: total` lets the hook drop the text from the props; the dirty
      // state follows, whatever the hook last heard.
      send(surface, cells, { need: props.total, version: props.version })
      send(surface, cells, { dirty: props.isDraft, version: props.version })
    }
  }
  if (cells.saving !== undefined && props.saved === cells.saving.seq) {
    cells.original = cells.saving.text
    cells.saving = undefined
    if (cells.buffer !== undefined) markDirty(surface, cells, isDirty(cells.buffer, cells.original))
  }
  if (props.commandSeq !== cells.commandSeq) {
    cells.commandSeq = props.commandSeq
    if (cells.buffer !== undefined) run(surface, cells, props.command, props.by)
  }
  post(surface, cells)
}

// ----------------------------------------------------------------- editing

const save = (surface: ClientSurface<State>, cells: Cells, force: boolean): void => {
  if (cells.buffer === undefined) return
  cells.saveSeq += 1
  const text = toText(cells.buffer)
  cells.saving = { seq: cells.saveSeq, text }
  cells.isDraftDue = false
  sendText(surface, cells, 'save', cells.saveSeq, text, force)
}

// Keeps the primary cursor in the window.
const follow = (surface: ClientSurface<State>, cells: Cells): void => {
  const buffer = cells.buffer
  if (buffer === undefined) return
  const head = buffer.cursors[buffer.cursors.length - 1]!.head
  const rows = rowsOf(surface, cells)
  const width = textWidthOf(surface, cells, buffer)
  if (head.line < cells.top) cells.top = head.line
  else if (head.line >= cells.top + rows) cells.top = head.line - rows + 1
  if (head.col < cells.left) cells.left = head.col
  else if (head.col >= cells.left + width) cells.left = head.col - width + 1
}

// Swaps in the buffer an op produced; a text change marks dirty and
// schedules the draft.
const apply = (surface: ClientSurface<State>, cells: Cells, next: Buffer): void => {
  const was = cells.buffer
  cells.buffer = next
  if (was !== undefined && was.lines !== next.lines) {
    cells.widest = widestAfter(cells.widest, was.lines, next.lines)
    cells.idle = 0
    cells.isDraftDue = true
    markDirty(surface, cells, isDirty(next, cells.original))
  }
  follow(surface, cells)
}

const act = (surface: ClientSurface<State>, cells: Cells, action: Action): void => {
  const buffer = cells.buffer
  if (buffer === undefined) return
  const result = applyAction(buffer, action, {
    comment: commentOf(cells.props.language),
    rows: rowsOf(surface, cells),
  })
  apply(surface, cells, result.buffer)
  if (result.copy !== undefined && result.copy.length <= TRANSFER_CHUNK) {
    send(surface, cells, { copy: result.copy })
  }
  if (result.save === true) save(surface, cells, false)
}

// A border Button's command, as the props carry it.
const run = (surface: ClientSurface<State>, cells: Cells, command: string, by: number): void => {
  if (command === 'save' || command === 'overwrite') {
    save(surface, cells, command === 'overwrite')
  } else if (command === 'scroll' && cells.buffer !== undefined) {
    const max = Math.max(0, cells.buffer.lines.length - rowsOf(surface, cells))
    cells.top = Math.min(Math.max(0, cells.top + by), max)
  } else if (command === 'left' && cells.buffer !== undefined) {
    // The horizontal bar dragged: the view moves, the cursor stays. The caret
    // cell past a line's end counts (End puts the view there), as in the bar.
    const max = Math.max(0, cells.widest + 1 - textWidthOf(surface, cells, cells.buffer))
    cells.left = Math.min(Math.max(0, Math.round(by)), max)
  } else if ((ACTIONS as readonly string[]).includes(command)) {
    act(surface, cells, command as Action)
  }
}

const key = (surface: ClientSurface<State>, cells: Cells, event: ClientKeyEvent): void => {
  const buffer = cells.buffer
  if (buffer === undefined) return
  const action = keyOp(event, cells.props.keymap)
  if (action !== undefined) {
    act(surface, cells, action)
  } else if (event.ctrl !== true && event.meta !== true) {
    const text = event.key === 'space' ? ' ' : event.key
    if (SPECIAL.test(text) || text === '') return
    // One character is typing; more at once is a paste.
    apply(surface, cells, [...text].length === 1 ? insert(buffer, text) : paste(buffer, text))
  } else {
    return
  }
  surface.setState({ cells })
}

const posAt = (cells: Cells, x: number, y: number): Pos | undefined => {
  const buffer = cells.buffer
  if (buffer === undefined) return undefined
  const line = Math.min(Math.max(0, cells.top + y), buffer.lines.length - 1)
  const col = Math.max(0, cells.left + x - gutterOf(buffer))

  return { line, col: Math.min(col, buffer.lines[line]!.length) }
}

const point = (surface: ClientSurface<State>, cells: Cells, event: ClientPointerEvent): void => {
  const buffer = cells.buffer
  const pos = posAt(cells, event.x, event.y)
  if (buffer === undefined || pos === undefined) return
  if (event.type === 'down' && event.button === 'left') {
    let next: Buffer
    if (event.alt === true || event.ctrl === true) {
      next = addCursor(buffer, pos)
    } else if (event.shift === true) {
      next = extendTo(buffer, pos)
    } else {
      next = setCursor(buffer, pos)
    }
    cells.buffer = next
    const at = cursorAt(next, pos)
    cells.drag = at >= 0 ? at : next.cursors.length - 1
    surface.setState({ cells })
  } else if (event.type === 'move' && cells.drag !== undefined && event.button === 'left') {
    cells.buffer = extendTo(buffer, pos, cells.drag)
    follow(surface, cells)
    surface.setState({ cells })
  } else if (event.type === 'up' && cells.drag !== undefined) {
    cells.drag = undefined
  }
}

// Every tick: resend an unacked message, post the draft after 1 s idle.
const tick = (surface: ClientSurface<State>, cells: Cells): void => {
  cells.tick += 1
  cells.idle += 1
  const head = cells.outbox[0]
  if (head?.sentAt !== undefined && cells.tick - head.sentAt >= RESEND_TICKS) {
    head.sentAt = undefined
    post(surface, cells)
  }
  if (cells.isDraftDue && cells.idle >= DRAFT_TICKS && cells.buffer !== undefined) {
    cells.isDraftDue = false
    if (cells.isDirty) {
      cells.draftSeq += 1
      sendText(surface, cells, 'draft', cells.draftSeq, toText(cells.buffer))
    }
  }
}

// ----------------------------------------------------------------- drawing

// Cell styles of one line: 1 selected, 2 a caret.
const marksOf = (buffer: Buffer, line: number): Map<number, 1 | 2> => {
  const marks = new Map<number, 1 | 2>()
  const length = buffer.lines[line]!.length
  for (const c of buffer.cursors) {
    const s = startOf(c)
    const e = endOf(c)
    if (line >= s.line && line <= e.line) {
      const from = line === s.line ? s.col : 0
      // A selection running past the line's end takes its newline cell.
      const to = line === e.line ? e.col : length + 1
      for (let col = from; col < to; col++) if (!marks.has(col)) marks.set(col, 1)
    }
    if (c.head.line === line) marks.set(c.head.col, 2)
  }

  return marks
}

const Editor: ClientModule<EditorProps, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  let cells = surface.state?.cells
  if (cells === undefined) {
    cells = {
      props,
      nonce: Math.floor(Math.random() * 1e9).toString(36),
      counter: 0,
      original: '',
      isDirty: false,
      top: 0,
      left: 0,
      widest: 0,
      outbox: [],
      tick: 0,
      idle: 0,
      isDraftDue: false,
      // Seqs start past the last save the hook wrote, so an earlier
      // instance's `saved` never reads as this one's.
      saveSeq: props.saved,
      draftSeq: 0,
      commandSeq: props.commandSeq,
    }
    const own = cells
    surface.onKey(event => key(surface, own, event))
    surface.onPointer(event => point(surface, own, event))
    // Resends and drafts change nothing drawn: no setState here.
    surface.every(TICK_MS, () => tick(surface, own))
    take(surface, cells, props)
    surface.setState({ cells })
  } else if (cells.props !== props) {
    take(surface, cells, props)
  }
  const buffer = cells.buffer
  if (buffer === undefined) {
    const parts = cells.loading?.parts ?? []
    const got = parts.filter(part => part !== undefined).length

    return (
      <Text dimColor>
        {parts.length > 1 ? `loading ${got}/${parts.length}` : 'loading…'}
      </Text>
    )
  }
  const rows = rowsOf(surface, cells)
  const gutter = gutterOf(buffer)
  const width = textWidthOf(surface, cells, buffer)
  // Every change to the view (an edit, a move, a resize) ends in a drawing:
  // the bar's numbers go out from here.
  syncView(surface, cells, width)
  const top = Math.min(cells.top, Math.max(0, buffer.lines.length - 1))
  const shown = buffer.lines.slice(top, top + rows)
  const colors = cells.props.colors

  return (
    <Box flexDirection="column">
      {shown.map((text, i) => {
        const line = top + i
        const marks = marksOf(buffer, line)
        let end = Math.min(text.length, cells.left + width)
        for (const col of marks.keys()) {
          if (col >= cells.left && col < cells.left + width) end = Math.max(end, col + 1)
        }
        // Runs of one style; tabs show as one space.
        const runs: { style: 0 | 1 | 2; text: string }[] = []
        for (let col = cells.left; col < end; col++) {
          const style = marks.get(col) ?? 0
          const ch = text[col] === undefined || text[col] === '\t' ? ' ' : text[col]!
          const last = runs[runs.length - 1]
          if (last !== undefined && last.style === style) last.text += ch
          else runs.push({ style, text: ch })
        }

        return (
          <Text key={'line:' + line} wrap="truncate-end">
            <Text color={colors.gutter}>{String(line + 1).padStart(gutter - 1) + ' '}</Text>
            {runs.map((run, k) =>
              run.style === 2 ? (
                <Text key={'run:' + k} color={colors.caretText} backgroundColor={colors.caret}>
                  {run.text}
                </Text>
              ) : run.style === 1 ? (
                <Text key={'run:' + k} color={colors.text} backgroundColor={colors.selection}>
                  {run.text}
                </Text>
              ) : (
                <Text key={'run:' + k} color={colors.text}>{run.text}</Text>
              ),
            )}
          </Text>
        )
      })}
    </Box>
  )
}

export default Editor
