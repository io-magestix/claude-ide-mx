import type { ClientModule, ClientSurface } from 'claude-code'

import { sliceRuns } from '../shared/hscroll'
import { isOnRow, rowGesture } from '../shared/row-gesture'
import { rowHit } from './tree'
import type { ChangeMark, Entry, RowHit } from './tree'

// One tree row as the Files section draws it: the selection bar, a rail per
// depth level, the dir arrow, the kind's icon when icons are on, the name,
// then its change mark (`+` added, `*` edited) when it has one. Everything
// past the selection bar is scrolled sideways by `left` columns (Files'
// horizontal bar) and cut to the region's width. The
// keyboard ring sits on the blank Button after the region, so `isCursor`
// underlines the name to show where it is.
//
// Pointer: the shared row gesture (`row-gesture.ts`) over `rowHit`: a click
// posts `{ hit }` (`arrow` on a dir's arrow, `name` elsewhere), a
// double-click `{ hit: 'double' }` (the Explorer opens or closes a dir, and
// takes it as a click on a file).
type Props = {
  depth: number
  kind: Entry['kind']
  isExpanded: boolean
  isSelected: boolean
  isCursor: boolean
  isIgnored: boolean
  label: string
  icon?: { glyph: string; color: string } // one cell, a space after it
  change?: ChangeMark
  left?: number // columns scrolled off past the selection bar
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
  const isLit = props.isSelected
  type Run = { text: string; color?: string; isDim?: boolean; isLabel?: boolean }
  const runs: Run[] = [
    ...(props.depth > 0 ? [{ text: '│ '.repeat(props.depth), color: colors.border }] : []),
    {
      text: props.kind === 'dir' ? (props.isExpanded ? '▾ ' : '▸ ') : '  ',
      color: props.isIgnored ? colors.muted : colors.accent,
    },
    ...(props.icon !== undefined ? [{ text: props.icon.glyph + ' ', color: props.icon.color }] : []),
    { text: props.label, isDim: props.isIgnored, isLabel: true },
    ...(props.change !== undefined ? [{ text: ' ' + props.change, color: colors.change }] : []),
  ]
  // the room past the selection bar, once laid out
  const room = surface.columns > 0 ? surface.columns - 1 : Infinity
  const shown = props.left === undefined && room === Infinity ? runs : sliceRuns(runs, props.left ?? 0, room)

  return (
    <Box flexDirection="row" width="100%" backgroundColor={isLit ? colors.selection : undefined}>
      <Text color={colors.accent}>{isLit ? '▌' : ' '}</Text>
      {shown.map((run, i) =>
        run.isLabel === true ? (
          <Text key={'run:' + i} dimColor={run.isDim} underline={props.isCursor} wrap="truncate-end">
            {run.text}
          </Text>
        ) : (
          <Text key={'run:' + i} color={run.color}>
            {run.text}
          </Text>
        ),
      )}
    </Box>
  )
}

const hitAt = (surface: ClientSurface<State>, cells: Cells, x: number, y: number): RowHit | undefined => {
  if (!isOnRow(surface.columns, x, y)) return undefined

  // the selection bar stays; the rest is scrolled by `left`
  return rowHit(cells.props.depth, cells.props.kind, x === 0 ? 0 : x + (cells.props.left ?? 0))
}

export default RowClient
