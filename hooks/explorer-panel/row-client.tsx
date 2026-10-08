import type { ClientModule, ClientSurface } from 'claude-code'

import { rowGesture } from '../shared/row-gesture'
import { rowHit } from './tree'
import type { Entry, RowHit } from './tree'

// One tree row as the Files section draws it: the selection mark, a rail per
// depth level, the dir arrow, the name (already cut to the room), then its
// change mark (`+` added, `*` edited) when it has one. The
// keyboard ring sits on the blank Button after the region, so `isCursor`
// underlines the name to show where it is.
//
// Pointer: the shared row gesture (`row-gesture.ts`) over `rowHit`: a click
// posts `{ hit }` (`arrow` on a dir's arrow, `mark` on the mark cell, `name`
// elsewhere) with the `ctrl`/`shift` flags of the down, a double-click
// `{ hit: 'double' }`.
type Props = {
  depth: number
  kind: Entry['kind']
  isExpanded: boolean
  isSelected: boolean
  isMarked?: boolean // in the multi-selection: drawn as the selected row
  isCursor: boolean
  isIgnored: boolean
  label: string
  change?: '+' | '*'
  colors: { accent: string; border: string; muted: string; selection: string; change: string }
}

// The latest props, shared by the module's calls and its pointer listener.
type Cells = { props: Props }
type State = { cells: Cells }

const RowClient: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  if (surface.state === undefined) {
    const cells: Cells = { props }
    surface.onPointer(
      rowGesture<RowHit>(surface, {
        hitAt: (x, y) => hitAt(surface, cells, x, y),
        isArrow: hit => hit === 'arrow',
      }),
    )
    surface.setState({ cells })
  } else {
    surface.state.cells.props = props
  }
  const { colors } = props
  const isLit = props.isSelected || props.isMarked === true

  return (
    <Box flexDirection="row" width="100%" backgroundColor={isLit ? colors.selection : undefined}>
      <Text color={colors.accent}>{isLit ? '▌' : ' '}</Text>
      {props.depth > 0 && <Text color={colors.border}>{'│ '.repeat(props.depth)}</Text>}
      <Text color={props.isIgnored ? colors.muted : colors.accent}>
        {props.kind === 'dir' ? (props.isExpanded ? '▾ ' : '▸ ') : '  '}
      </Text>
      <Text dimColor={props.isIgnored} underline={props.isCursor} wrap="truncate-end">
        {props.label}
      </Text>
      {props.change !== undefined && <Text color={colors.change}>{' ' + props.change}</Text>}
    </Box>
  )
}

const hitAt = (surface: ClientSurface<State>, cells: Cells, x: number, y: number): RowHit | undefined => {
  if (y !== 0 || x < 0 || (surface.columns > 0 && x >= surface.columns)) return undefined

  return rowHit(cells.props.depth, cells.props.kind, x)
}

export default RowClient
