import type { ClientModule, ClientSurface } from 'claude-code'

import { isOnRow, rowGesture } from '../shared/row-gesture'
import { branchHit } from './git'

type BranchHit = 'arrow' | 'name'

// One Branches row as the section draws it: the selection mark, a rail per
// depth level, a 2-cell slot (a folder's arrow, a branch's `*` head marker),
// then the label (already cut to the room; a branch's carries its track
// label, a category row's its count, a folder's a trailing `/`).
//
// Pointer: the shared row gesture (`row-gesture.ts`) over `branchHit`: a click
// posts `{ hit }` (`arrow` on a folder's arrow, `name` elsewhere), a
// double-click `{ hit: 'double' }`.
type Props = {
  depth: number
  isFolder: boolean
  isGroup: boolean // a category row (`Local (N)` / `Remote (N)`): bold, depth 0
  isOpen: boolean
  isSelected: boolean
  isRemote: boolean
  isHead: boolean // the checked-out branch: `*` in the slot
  label: string
  colors: { accent: string; muted: string; selection: string }
}

// The latest props, shared by the module's calls and its pointer listener.
type Cells = { props: Props }
type State = { cells: Cells }

const BranchClient: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  if (surface.state === undefined) {
    const cells: Cells = { props }
    surface.onPointer(
      rowGesture<BranchHit>(surface, {
        hitAt: (x, y) => hitAt(surface, cells, x, y),
        isArrow: hit => hit === 'arrow',
      }),
    )
    surface.setState({ cells })
  } else {
    surface.state.cells.props = props
  }
  const { colors } = props

  return (
    <Box flexDirection="row" width="100%" backgroundColor={props.isSelected ? colors.selection : undefined}>
      <Text color={colors.accent}>{props.isSelected ? '▌' : ' '}</Text>
      {props.depth > 0 && <Text color={colors.muted}>{'│ '.repeat(props.depth)}</Text>}
      {props.isFolder ? (
        <Text bold={props.isGroup} color={colors.accent}>
          {props.isOpen ? '▾ ' : '▸ '}
        </Text>
      ) : (
        <Text>{props.isHead ? '* ' : '  '}</Text>
      )}
      <Text bold={props.isGroup} dimColor={props.isRemote} wrap="truncate-end">
        {props.label}
      </Text>
    </Box>
  )
}

const hitAt = (surface: ClientSurface<State>, cells: Cells, x: number, y: number): BranchHit | undefined => {
  if (!isOnRow(surface.columns, x, y)) return undefined

  return branchHit(cells.props.depth, cells.props.isFolder, x)
}

export default BranchClient
