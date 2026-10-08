import type { ClientModule, ClientPointerEvent, ClientSurface } from 'claude-code'

// One cell per visible commit row (top to bottom): Commits' dot (`glyph` in
// its lane color) or none (Graph), then the dim marker (`>` on the selected
// row) and short sha. `background` paints the selected row. After the pointer
// rests DELAY_MS on one row the hooks module is told (`{ hover: y }`). A left down and up on one row posts `{ press: y }`.
type Row = { glyph?: string; color?: string; mark: string; short: string }
type Props = {
  rows: Row[]
  background?: string
}

const DELAY_MS = 600
const TICK_MS = 100

// Mutable cells shared by the module's calls, its pointer listener and its
// timer: the latest props, the row under the pointer (`undefined` when off the
// region), how long it has rested there, whether a card is up for it, and the
// row a left button went down on.
type Cells = { props: Props; row?: number; rested: number; isShown: boolean; down?: number }
type State = { cells: Cells }

const Dots: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  if (surface.state === undefined) {
    const cells: Cells = { props, rested: 0, isShown: false }
    surface.onPointer(event => point(surface, cells, event))
    surface.every(TICK_MS, () => tick(surface, cells))
    surface.setState({ cells })
  } else {
    surface.state.cells.props = props
  }

  return (
    <Box flexDirection="column" flexShrink={0}>
      {props.rows.map((row, i) => (
        <Box
          key={'cell:' + i}
          flexDirection="row"
          backgroundColor={row.mark === '>' ? props.background : undefined}
        >
          {row.glyph !== undefined && <Text color={row.color}>{row.glyph + ' '}</Text>}
          <Text dimColor>{row.mark + row.short + ' '}</Text>
        </Box>
      ))}
    </Box>
  )
}

// The card goes when the pointer leaves its row.
const hide = (surface: ClientSurface<State>, cells: Cells): void => {
  if (cells.isShown) surface.post({ hover: null })
  cells.isShown = false
}

const rowAt = (cells: Cells, y: number): number | undefined =>
  y >= 0 && y < cells.props.rows.length ? y : undefined

const point = (
  surface: ClientSurface<State>,
  cells: Cells,
  event: ClientPointerEvent,
): void => {
  if (event.type === 'down') {
    cells.down = event.button === 'left' ? rowAt(cells, event.y) : undefined
  } else if (event.type === 'up') {
    const row = rowAt(cells, event.y)
    if (event.button === 'left' && row !== undefined && row === cells.down) surface.post({ press: row })
    cells.down = undefined
  } else if (event.type === 'leave') {
    hide(surface, cells)
    cells.row = undefined
    cells.rested = 0
  } else {
    // `enter` or `move`
    const row = rowAt(cells, event.y)
    if (row === cells.row) return
    hide(surface, cells)
    cells.row = row
    cells.rested = 0
  }
}

const tick = (surface: ClientSurface<State>, cells: Cells): void => {
  if (cells.row === undefined || cells.isShown) return
  cells.rested += TICK_MS
  if (cells.rested < DELAY_MS) return
  cells.isShown = true
  surface.post({ hover: cells.row })
}

export default Dots
