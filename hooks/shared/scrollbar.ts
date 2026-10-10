// A bar is BAR cells thick: a vertical bar BAR columns, each row one cell
// string of them (a solid thumb centred across both, a thin centred track); a
// horizontal bar BAR rows, the section's last inner row over its bottom
// border, each row drawn from its own glyphs (`H_INNER`, `H_EDGE`), so the
// thumb is a solid block across both rows and the track the border's line.
export const BAR = 2
export const THUMB = '▐▌'
const TRACK = '▕▏'
export const H_INNER = { thumb: '▄', track: ' ' }
export const H_EDGE = { thumb: '▀', track: '─' }

// `value` held to 0..max (a negative `max` is 0).
export const clamp = (value: number, max: number): number =>
  Math.min(Math.max(0, value), Math.max(0, max))

// A vertical scrollbar of `height` rows over `total` rows of which `visible`
// show from `offset`: the thumb is proportional (at least 1 row), its place
// follows offset / (total - visible). All blank when everything fits.
// `glyphs` picks the thumb and track cells: `H_INNER` or `H_EDGE` for a row
// of a horizontal bar, `height` then being its length in columns.
export const scrollbar = (
  total: number,
  visible: number,
  offset: number,
  height: number,
  glyphs: { thumb: string; track: string } = { thumb: THUMB, track: TRACK },
): string[] => {
  const rows = Math.max(0, Math.floor(height))
  if (total <= visible || visible <= 0 || rows === 0) {
    return Array.from({ length: rows }, () => ' '.repeat(glyphs.thumb.length))
  }
  const thumb = Math.min(rows, Math.max(1, Math.round((rows * visible) / total)))
  const span = total - visible
  const ratio = Math.min(1, Math.max(0, offset / span))
  const top = Math.round((rows - thumb) * ratio)

  return Array.from({ length: rows }, (_, i) =>
    i >= top && i < top + thumb ? glyphs.thumb : glyphs.track,
  )
}

// `cells` merged into runs of one kind (thumb or not), so a bar draws as a
// few Texts rather than one per cell.
export const barRuns = (cells: readonly string[], thumb: string): { text: string; isThumb: boolean }[] => {
  const runs: { text: string; isThumb: boolean }[] = []
  for (const cell of cells) {
    const isThumb = cell === thumb
    const last = runs[runs.length - 1]
    if (last !== undefined && last.isThumb === isThumb) last.text += cell
    else runs.push({ text: cell, isThumb })
  }

  return runs
}
