import type { ClientPointerEvent, ClientSurface } from 'claude-code'

// The click gesture of a row Client (Explorer's tree rows, Git's branch rows):
// a left down and up on one part of the row posts `{ hit }`; a second left down within DOUBLE_MS of
// the first posts `{ hit: 'double' }` instead, and its up posts nothing. The
// arrow only toggles: a down on it closes any open window and never counts
// toward a double, and a release across the arrow edge is no click.
export const DOUBLE_MS = 400

// Whether a pointer at `x`, `y` is on a one-row Client `columns` wide (0: not
// laid out yet, any column counts).
export const isOnRow = (columns: number, x: number, y: number): boolean =>
  y === 0 && x >= 0 && (columns <= 0 || x < columns)

// What the gesture needs of the row: the part under a cell (`undefined` off
// the row) and which part is the arrow.
type RowGestureOptions<H extends string> = {
  hitAt: (x: number, y: number) => H | undefined
  isArrow: (hit: H) => boolean
}

// Mutable cells kept by one row's listener: the part a left button went down
// on, whether a first click's window is still open (and what
// closes it), and whether the gesture under way is a double-click's second
// down.
type Cells<H> = {
  down?: H
  isArmed: boolean
  disarm?: () => void
  isDouble: boolean
}

type Surface = Pick<ClientSurface, 'every' | 'post'>

// The pointer listener for one row; pass it to `surface.onPointer` once
// (while `state` is still undefined).
export const rowGesture = <H extends string>(
  surface: Surface,
  { hitAt, isArrow }: RowGestureOptions<H>,
): ((event: ClientPointerEvent) => void) => {
  const cells: Cells<H> = { isArmed: false, isDouble: false }

  return event => point(surface, cells, hitAt, isArrow, event)
}

// The first click's window: open for DOUBLE_MS after its down, then shut by
// a one-shot timer (no ticking while the row sits idle).
const arm = <H>(surface: Surface, cells: Cells<H>): void => {
  cells.disarm?.()
  cells.isArmed = true
  const stop = surface.every(DOUBLE_MS, () => {
    cells.isArmed = false
    cells.disarm = undefined
    stop()
  })
  cells.disarm = () => {
    cells.isArmed = false
    stop()
  }
}

const point = <H extends string>(
  surface: Surface,
  cells: Cells<H>,
  hitAt: RowGestureOptions<H>['hitAt'],
  isArrow: RowGestureOptions<H>['isArrow'],
  event: ClientPointerEvent,
): void => {
  if (event.type === 'down') {
    if (event.button !== 'left') {
      cells.down = undefined

      return
    }
    cells.down = hitAt(event.x, event.y)
    if (cells.down === undefined) return
    // The arrow only toggles: two quick clicks on it open and close the dir.
    if (isArrow(cells.down)) {
      cells.disarm?.()
      cells.disarm = undefined
      cells.isDouble = false

      return
    }
    if (cells.isArmed) {
      cells.disarm?.()
      cells.disarm = undefined
      cells.isDouble = true
      surface.post({ hit: 'double' })

      return
    }
    cells.isDouble = false
    arm(surface, cells)
  } else if (event.type === 'up') {
    const down = cells.down
    cells.down = undefined
    if (event.button !== 'left' || down === undefined) return
    if (cells.isDouble) {
      cells.isDouble = false

      return
    }
    // Released off the row, or across the arrow edge: no click.
    const up = hitAt(event.x, event.y)
    if (up === undefined || isArrow(up) !== isArrow(down)) return
    surface.post({ hit: down })
  }
}
