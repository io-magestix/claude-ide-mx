import { expect, test } from 'claude-code/testing'

import { THEMES } from './theme'

// The engine's 256-color fallback (used under tmux): a gray goes to the gray
// ramp 232..255, any other color to the 6x6x6 cube by rounding each channel.
const ansi256 = (hex: string): number => {
  const n = parseInt(hex.slice(1), 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  if (r === g && g === b) {
    if (r < 8) return 16
    if (r > 248) return 231

    return Math.round(((r - 8) / 247) * 24) + 232
  }
  const c = (v: number) => Math.round((v / 255) * 5)

  return 16 + 36 * c(r) + 6 * c(g) + c(b)
}

test('ansi256 matches the codes the engine emits', () => {
  expect(ansi256('#1f1e1d')).toBe(59)
  expect(ansi256('#3d3b38')).toBe(59)
  expect(ansi256('#d97757')).toBe(174)
  expect(ansi256('#1f1f1f')).toBe(234)
})

test('the theme keeps its frames visible in 256 colors', () => {
  for (const name of ['claude'] as const) {
    const t = THEMES[name]
    expect({ name, differs: ansi256(t.border) !== ansi256(t.bg) }).toEqual({ name, differs: true })
    expect({ name, differs: ansi256(t.border) !== ansi256(t.surface) }).toEqual({ name, differs: true })
    expect({ name, differs: ansi256(t.text) !== ansi256(t.bg) }).toEqual({ name, differs: true })
  }
})
