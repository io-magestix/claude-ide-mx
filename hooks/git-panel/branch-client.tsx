import type { ClientModule, ClientSurface } from 'claude-code'

import { sliceRuns } from '../shared/hscroll'
import { isOnRow, rowGesture } from '../shared/row-gesture'
import { branchHit } from './git'

type BranchHit = 'arrow' | 'name'

// One Branches row as the section draws it: the selection mark, a rail per
// depth level, a 2-cell slot (a folder's arrow, a branch's `*` head marker),
// then the label (a branch's carries its track label, a category row's its
// count, a folder's a trailing `/`). Everything past the selection mark is
// scrolled sideways by `left` columns (Branches' horizontal bar) and cut to
// the region's width.
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
  left?: number // columns scrolled off past the selection mark
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
  type Run = { text: string; color?: string; isLabel?: boolean }
  const runs: Run[] = [
    ...(props.depth > 0 ? [{ text: '│ '.repeat(props.depth), color: colors.muted }] : []),
    props.isFolder ? { text: props.isOpen ? '▾ ' : '▸ ', color: colors.accent } : { text: props.isHead ? '* ' : '  ' },
    { text: props.label, isLabel: true },
  ]
  // the room past the selection mark, once laid out
  const room = surface.columns > 0 ? surface.columns - 1 : Infinity
  const shown = props.left === undefined && room === Infinity ? runs : sliceRuns(runs, props.left ?? 0, room)

  return (
    <Box flexDirection="row" width="100%" backgroundColor={props.isSelected ? colors.selection : undefined}>
      <Text color={colors.accent}>{props.isSelected ? '▌' : ' '}</Text>
      {shown.map((run, i) =>
        run.isLabel === true ? (
          <Text key={'run:' + i} bold={props.isGroup} dimColor={props.isRemote} wrap="truncate-end">
            {run.text}
          </Text>
        ) : run.color === undefined ? (
          <Text key={'run:' + i}>{run.text}</Text>
        ) : (
          <Text key={'run:' + i} bold={props.isFolder && props.isGroup} color={run.color}>
            {run.text}
          </Text>
        ),
      )}
    </Box>
  )
}

const hitAt = (surface: ClientSurface<State>, cells: Cells, x: number, y: number): BranchHit | undefined => {
  if (!isOnRow(surface.columns, x, y)) return undefined

  // the selection mark stays; the rest is scrolled by `left`
  return branchHit(cells.props.depth, cells.props.isFolder, x === 0 ? 0 : x + (cells.props.left ?? 0))
}

export default BranchClient
