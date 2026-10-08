export const THUMB = '┃'
export const TRACK = '│'
export const H_THUMB = '━'
export const H_TRACK = '─'

// `value` held to 0..max (a negative `max` is 0).
export const clamp = (value: number, max: number): number =>
  Math.min(Math.max(0, value), Math.max(0, max))

// A one-column scrollbar of `height` rows over `total` rows of which `visible`
// show from `offset`: the thumb is proportional (at least 1 row), its place
// follows offset / (total - visible). All blank when everything fits.
// `glyphs` picks the thumb and track cells: `{ thumb: H_THUMB, track: H_TRACK }`
// for a one-row horizontal bar, `height` then being its length in columns.
export const scrollbar = (
  total: number,
  visible: number,
  offset: number,
  height: number,
  glyphs: { thumb: string; track: string } = { thumb: THUMB, track: TRACK },
): string[] => {
  const rows = Math.max(0, Math.floor(height))
  if (total <= visible || visible <= 0 || rows === 0) {
    return Array.from({ length: rows }, () => ' ')
  }
  const thumb = Math.min(rows, Math.max(1, Math.round((rows * visible) / total)))
  const span = total - visible
  const ratio = Math.min(1, Math.max(0, offset / span))
  const top = Math.round((rows - thumb) * ratio)

  return Array.from({ length: rows }, (_, i) =>
    i >= top && i < top + thumb ? glyphs.thumb : glyphs.track,
  )
}
