import type { ClientModule, ClientPointerEvent, ClientSurface } from 'claude-code'

import { isOnRow } from '../shared/row-gesture'

// One link run of rendered markdown in Preview, laid exactly over the Text it
// was drawn as and drawing the same label (underlined accent), so the two
// look alike whether or not the region paints. A left down and up inside the
// region posts `{ link: i, path, offset }`, `i` the run's index in the
// drawing's link list, `path` and `offset` naming that drawing (the hook
// ignores a press from one no longer shown).
// The wheel is not the Client's: the pane's ui.scroll hook still gets it.
type Props = {
  i: number
  path: string
  offset: number
  segments: { text: string; bold?: boolean; italic?: boolean; strike?: boolean }[]
  color: string
}

type Cells = { props: Props; isDown: boolean }
type State = { cells: Cells }

const LinkClient: ClientModule<Props, State> = (props, surface) => {
  const { Text } = surface.elements
  if (surface.state === undefined) {
    const cells: Cells = { props, isDown: false }
    surface.onPointer(event => point(surface, cells, event))
    surface.setState({ cells })
  } else {
    surface.state.cells.props = props
  }

  return (
    <Text wrap="truncate-end">
      {props.segments.map((s, n) => (
        <Text key={'s' + n} color={props.color} underline bold={s.bold === true} italic={s.italic === true} strikethrough={s.strike === true}>
          {s.text}
        </Text>
      ))}
    </Text>
  )
}

const point = (surface: ClientSurface<State>, cells: Cells, event: ClientPointerEvent): void => {
  if (event.type === 'down') {
    cells.isDown = event.button === 'left' && isOnRow(surface.columns, event.x, event.y)
  } else if (event.type === 'up') {
    const wasDown = cells.isDown
    cells.isDown = false
    if (wasDown && event.button === 'left' && isOnRow(surface.columns, event.x, event.y)) {
      surface.post({ link: cells.props.i, path: cells.props.path, offset: cells.props.offset })
    }
  }
}

export default LinkClient
