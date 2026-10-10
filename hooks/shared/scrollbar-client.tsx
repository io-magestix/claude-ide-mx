import type { ClientModule, ClientPointerEvent, ClientSurface } from 'claude-code'

import { BAR, H_EDGE, H_INNER, THUMB, barRuns, clamp, scrollbar } from './scrollbar'

// `axis` 'y' (the default) draws BAR columns of `height` rows; 'x' draws BAR
// rows (the section's last inner row over its bottom border), `height` then
// read as the bar's length in columns. The laid-out size (`surface.rows` /
// `surface.columns`) wins over `height` once known.
type Props = {
  total: number
  visible: number
  offset: number
  height: number
  color: string
  axis?: 'x' | 'y'
}

// Mutable cells shared by the module's calls and its pointer listener: the
// latest props, and the offset under a drag (`undefined` when none).
type Cells = { props: Props; held?: number; grab: number }
type State = { cells: Cells }

// The bar's length in cells along its axis.
const lengthOf = (surface: ClientSurface<State>, props: Props): number =>
  props.axis === 'x'
    ? surface.columns > 0 ? surface.columns : props.height
    : surface.rows > 0 ? surface.rows : props.height

const thumbOf = (props: Props, length: number): number =>
  Math.min(length, Math.max(1, Math.round((length * props.visible) / props.total)))

// Offset that puts the thumb's first cell at `top`.
const offsetAt = (props: Props, length: number, top: number): number => {
  const free = length - thumbOf(props, length)
  const span = props.total - props.visible
  if (free <= 0) return 0

  return clamp(Math.round((top / free) * span), span)
}

const topOf = (props: Props, length: number, offset: number): number => {
  const free = length - thumbOf(props, length)
  const span = props.total - props.visible

  return Math.round(free * clamp(offset / span, 1))
}

const ScrollBar: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const length = lengthOf(surface, props)
  if (surface.state === undefined) {
    const cells: Cells = { props, grab: 0 }
    surface.onPointer(event => point(surface, cells, event))
    surface.setState({ cells })
  } else {
    surface.state.cells.props = props
  }
  const held = surface.state?.cells.held
  const offset = held ?? props.offset

  // Runs of thumb or track cells; two Texts, not one with
  // `dimColor={undefined}`: the engine refuses some props set to undefined.
  const runs = (cells: string[], thumb: string, key: string) =>
    barRuns(cells, thumb).map((run, i) =>
      run.isThumb ? (
        <Text key={key + i} color={props.color}>
          {run.text}
        </Text>
      ) : (
        <Text key={key + i} dimColor>
          {run.text}
        </Text>
      ),
    )

  if (props.axis === 'x') {
    return (
      <Box flexDirection="column" height={BAR} flexShrink={0}>
        {[H_INNER, H_EDGE].map((glyphs, row) => (
          <Box key={'bar:' + row} flexDirection="row" height={1}>
            {runs(scrollbar(props.total, props.visible, offset, length, glyphs), glyphs.thumb, 'bar:' + row + ':')}
          </Box>
        ))}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" width={BAR} flexShrink={0}>
      {scrollbar(props.total, props.visible, offset, length).map((cell, i) => runs([cell], THUMB, 'bar:' + i + ':'))}
    </Box>
  )
}

const point = (
  surface: ClientSurface<State>,
  cells: Cells,
  event: ClientPointerEvent,
): void => {
  const { props } = cells
  const length = lengthOf(surface, props)
  if (props.total <= props.visible || length <= 0) return
  const at = props.axis === 'x' ? event.x : event.y
  const thumb = thumbOf(props, length)
  const top = topOf(props, length, cells.held ?? props.offset)
  const isDragging = cells.held !== undefined
  if (event.type === 'down' && event.button === 'left') {
    const isThumb = at >= top && at < top + thumb
    cells.grab = isThumb ? at - top : Math.floor(thumb / 2)
    cells.held = offsetAt(props, length, at - cells.grab)
    surface.post({ offset: cells.held })
    surface.setState({ cells })
  } else if (event.type === 'move' && isDragging) {
    cells.held = offsetAt(props, length, at - cells.grab)
    surface.post({ offset: cells.held })
    surface.setState({ cells })
  } else if (event.type === 'up' && isDragging) {
    const offset = offsetAt(props, length, at - cells.grab)
    cells.held = undefined
    surface.post({ offset })
    surface.setState({ cells })
  }
}

export default ScrollBar
