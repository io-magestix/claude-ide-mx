import { mixHex } from '../shared/color'
import type { Theme } from '../shared/theme'

// Halfway between two #rrggbb colors.
const mix = (a: string, b: string): string => mixHex(a, b, 0.5)

// Lane and dot colors, one per palette index (PALETTE_SIZE in git.ts), derived
// from the theme's semantic colors so each theme tints the graph its own way.
export const lanePalette = (t: Theme): readonly string[] => [
  t.info,
  t.success,
  t.accent,
  t.warning,
  mix(t.info, t.success),
  t.danger,
  mix(t.warning, t.danger),
  mix(t.accent, t.info),
]

// Status letter colors of a change row.
export const glyphColor = (t: Theme, glyph: string): string =>
  glyph === 'A' || glyph === '?' ? t.success : glyph === 'M' ? t.warning : glyph === 'D' ? t.danger : t.info
