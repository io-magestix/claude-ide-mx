// The session color `/color` sets, as the prompt bar draws it (256-color
// codes captured from the terminal); '' is the default prompt bar color.
const CODES: Record<string, number> = {
  '': 45,
  red: 198,
  blue: 45,
  green: 82,
  yellow: 226,
  purple: 171,
  orange: 208,
  pink: 213,
  cyan: 51,
}

const isSessionColor = (name: string): boolean => name in CODES

// `/color`'s answer: "Session color set to: green" or "... reset to default".
export const parseColorAnswer = (text: string): string | undefined => {
  if (/reset to default/.test(text)) return ''
  const found = /set to: ([a-z]+)/.exec(text)

  return found?.[1] !== undefined && isSessionColor(found[1]) ? found[1] : undefined
}

// The last `agentColor` in a transcript (`grep -h '"agentColor"'` output).
export const lastAgentColor = (stdout: string): string | undefined => {
  const all = [...stdout.matchAll(/"agentColor":"([a-z]*)"/g)]
  const name = all.at(-1)?.[1]
  if (name === undefined) return undefined

  return name === 'default' ? '' : isSessionColor(name) ? name : undefined
}

// A 256-color code as '#rrggbb' (xterm palette: 16 system colors, the 6x6x6
// cube, the gray ramp); out-of-range codes are clamped.
const SYSTEM = [
  '#000000', '#800000', '#008000', '#808000', '#000080', '#800080', '#008080', '#c0c0c0',
  '#808080', '#ff0000', '#00ff00', '#ffff00', '#0000ff', '#ff00ff', '#00ffff', '#ffffff',
]
const LEVELS = [0, 95, 135, 175, 215, 255]
const hex2 = (v: number): string => v.toString(16).padStart(2, '0')

export const ansi256Hex = (code: number): string => {
  const n = Math.max(0, Math.min(255, Math.round(code)))
  if (n < 16) return SYSTEM[n] as string
  if (n >= 232) {
    const g = 8 + (n - 232) * 10

    return '#' + hex2(g) + hex2(g) + hex2(g)
  }
  const i = n - 16

  return '#' + hex2(LEVELS[Math.floor(i / 36)] as number) + hex2(LEVELS[Math.floor(i / 6) % 6] as number) + hex2(LEVELS[i % 6] as number)
}

// The session color as '#rrggbb' (an unknown name reads as the default).
export const sessionHex = (name: string): string => ansi256Hex(CODES[name] ?? (CODES[''] as number))

// `a` moved toward `b` by `amount` (0..1), both '#rrggbb'; `a` when either is not.
export const mixHex = (a: string, b: string, amount: number): string => {
  const ma = /^#([0-9a-f]{6})$/i.exec(a)
  const mb = /^#([0-9a-f]{6})$/i.exec(b)
  if (ma === null || mb === null) return a
  const na = parseInt(ma[1] as string, 16)
  const nb = parseInt(mb[1] as string, 16)
  const k = Math.min(1, Math.max(0, amount))
  const c = (shift: number) => {
    const x = (na >> shift) & 255
    const y = (nb >> shift) & 255

    return Math.round(x + (y - x) * k).toString(16).padStart(2, '0')
  }

  return '#' + c(16) + c(8) + c(0)
}
