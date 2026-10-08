// The panels' theme follows Claude Code's `/config` theme, painted on the
// terminal's own color scheme where it is known (Tabby's, read from its
// config.yaml). Pure: the panels read the files and the config and hand the
// text and names here.
import { mixHex } from './color'
import type { Theme } from './theme'
import { contrast, luminance } from './ui'

// A terminal color scheme: its default colors and the 16 ANSI ones.
export type TermScheme = {
  name?: string
  foreground: string
  background: string
  colors: string[] // 16: black, red, green, yellow, blue, magenta, cyan, white, then the bright ones
}

const HEX = /^#[0-9a-f]{6}$/i

// A YAML scalar as Tabby writes one: bare, '...' or "...".
const scalar = (text: string): string => {
  const s = text.trim()

  return /^(['"]).*\1$/.test(s) ? s.slice(1, -1) : s
}

// The scheme named `key` (`colorScheme`, `lightColorScheme`) under the top
// level `terminal:` of a Tabby config.yaml; undefined when it is not there or
// lacks a color. Reads only the lines Tabby writes, not YAML at large.
const schemeAt = (lines: readonly string[], key: string): TermScheme | undefined => {
  const terminal = lines.findIndex(line => /^terminal:\s*$/.test(line))
  if (terminal < 0) return undefined
  let at = -1
  for (let i = terminal + 1; i < lines.length && !/^\S/.test(lines[i] ?? ''); i++) {
    if (new RegExp(`^  ${key}:\\s*$`).test(lines[i] ?? '')) {
      at = i
      break
    }
  }
  if (at < 0) return undefined
  const fields: Record<string, string> = {}
  const colors: string[] = []
  let inColors = false
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line.trim() === '') continue
    if (!/^ {4}/.test(line)) break
    const item = /^ {4,}- (.*)$/.exec(line)
    if (item !== null && inColors) {
      colors.push(scalar(item[1] ?? ''))
      continue
    }
    const field = /^ {4}(\w+):(.*)$/.exec(line)
    if (field === null) continue
    inColors = field[1] === 'colors'
    if (!inColors) fields[field[1] ?? ''] = scalar(field[2] ?? '')
  }
  const foreground = fields.foreground ?? ''
  const background = fields.background ?? ''
  if (!HEX.test(foreground) || !HEX.test(background) || colors.length < 16 || !colors.every(c => HEX.test(c))) return undefined

  return { name: fields.name, foreground, background, colors: colors.slice(0, 16) }
}

// The scheme Tabby draws with: `terminal.colorScheme`, or its
// `lightColorScheme` while `appearance.colorSchemeMode` is `light`. Tabby
// writes no scheme until one is picked (then this is undefined), and a
// profile's own scheme is not seen (the running profile is not known).
export const parseTabbyScheme = (yaml: string): TermScheme | undefined => {
  const lines = yaml.split(/\r?\n/)
  const appearance = lines.findIndex(line => /^appearance:\s*$/.test(line))
  let isLight = false
  for (let i = appearance + 1; appearance >= 0 && i < lines.length && !/^\S/.test(lines[i] ?? ''); i++) {
    const mode = /^ {2}colorSchemeMode:(.*)$/.exec(lines[i] ?? '')
    if (mode !== null) isLight = scalar(mode[1] ?? '') === 'light'
  }

  return (isLight ? schemeAt(lines, 'lightColorScheme') : undefined) ?? schemeAt(lines, 'colorScheme')
}

// xterm's 16 colors, for Claude Code's ANSI themes where the terminal's are not known.
export const XTERM16 = [
  '#000000', '#cd0000', '#00cd00', '#cdcd00', '#0000ee', '#cd00cd', '#00cdcd', '#e5e5e5',
  '#7f7f7f', '#ff0000', '#00ff00', '#ffff00', '#5c5cff', '#ff00ff', '#00ffff', '#ffffff',
]
const ANSI_NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']

// The colors of Claude Code's themes the panels use (Claude Code 2.1, its
// `/config` theme): `rgb(...)` or `ansi:<name>`, the terminal's own color.
type CcPalette = {
  text: string
  inactive: string
  promptBorder: string
  claude: string
  permission: string
  success: string
  error: string
  warning: string
  userMessageBackground: string
}
export const CC_PALETTES: Record<string, CcPalette> = {
  dark: {
    text: 'rgb(255,255,255)', inactive: 'rgb(153,153,153)', promptBorder: 'rgb(136,136,136)', claude: 'rgb(215,119,87)',
    permission: 'rgb(177,185,249)', success: 'rgb(78,186,101)', error: 'rgb(255,107,128)', warning: 'rgb(255,193,7)',
    userMessageBackground: 'rgb(55,55,55)',
  },
  light: {
    text: 'rgb(0,0,0)', inactive: 'rgb(102,102,102)', promptBorder: 'rgb(153,153,153)', claude: 'rgb(215,119,87)',
    permission: 'rgb(87,105,247)', success: 'rgb(44,122,57)', error: 'rgb(171,43,63)', warning: 'rgb(150,108,30)',
    userMessageBackground: 'rgb(240,240,240)',
  },
  'dark-daltonized': {
    text: 'rgb(255,255,255)', inactive: 'rgb(153,153,153)', promptBorder: 'rgb(136,136,136)', claude: 'rgb(255,153,51)',
    permission: 'rgb(153,204,255)', success: 'rgb(51,153,255)', error: 'rgb(255,102,102)', warning: 'rgb(255,204,0)',
    userMessageBackground: 'rgb(55,55,55)',
  },
  'light-daltonized': {
    text: 'rgb(0,0,0)', inactive: 'rgb(102,102,102)', promptBorder: 'rgb(153,153,153)', claude: 'rgb(255,153,51)',
    permission: 'rgb(51,102,255)', success: 'rgb(0,102,153)', error: 'rgb(204,0,0)', warning: 'rgb(255,153,0)',
    userMessageBackground: 'rgb(220,220,220)',
  },
  'dark-ansi': {
    text: 'ansi:whiteBright', inactive: 'ansi:white', promptBorder: 'ansi:white', claude: 'ansi:redBright',
    permission: 'ansi:blueBright', success: 'ansi:greenBright', error: 'ansi:redBright', warning: 'ansi:yellowBright',
    userMessageBackground: 'ansi:blackBright',
  },
  'light-ansi': {
    text: 'ansi:black', inactive: 'ansi:blackBright', promptBorder: 'ansi:white', claude: 'ansi:redBright',
    permission: 'ansi:blue', success: 'ansi:green', error: 'ansi:red', warning: 'ansi:yellow',
    userMessageBackground: 'ansi:white',
  },
}

// One palette color as '#rrggbb': `rgb(r,g,b)`, or `ansi:<name>[Bright]` from
// the terminal's colors (xterm's when unknown).
const colorOf = (value: string, colors: readonly string[]): string => {
  const rgb = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(value)
  if (rgb !== null) return '#' + [rgb[1], rgb[2], rgb[3]].map(v => Number(v).toString(16).padStart(2, '0')).join('')
  const ansi = /^ansi:([a-z]+?)(Bright)?$/.exec(value)
  const at = ansi === null ? -1 : ANSI_NAMES.indexOf(ansi[1] ?? '')
  if (ansi === null || at < 0) return value

  return colors[at + (ansi[2] === undefined ? 0 : 8)] ?? XTERM16[at] ?? value
}

// The theme `name` resolves to: `auto` is dark or light by the terminal's
// background (dark when it is not known); a name it does not know is `dark`.
export const ccThemeName = (name: string | undefined, scheme: TermScheme | undefined): string => {
  if (name === 'auto') return scheme !== undefined && luminance(scheme.background) > 0.5 ? 'light' : 'dark'

  return name !== undefined && name in CC_PALETTES ? name : 'dark'
}

// The panels' tokens from Claude Code's theme `name`. Claude Code draws on the
// terminal's own background: with the scheme known it is painted, otherwise
// left to the terminal (`canvas` undefined; `bg` then a stand-in for the math).
export const themeFromClaudeCode = (name: string | undefined, scheme: TermScheme | undefined): Theme => {
  const resolved = ccThemeName(name, scheme)
  const palette = CC_PALETTES[resolved] as CcPalette
  const isLight = resolved.startsWith('light')
  const colors = scheme?.colors ?? XTERM16
  const c = (key: keyof CcPalette) => colorOf(palette[key], colors)
  const text = c('text')
  const surface = c('userMessageBackground')
  const accent = c('claude')
  const border = c('promptBorder')

  return {
    bg: scheme?.background ?? (isLight ? '#ffffff' : '#1f1f1f'),
    canvas: scheme?.background,
    surface,
    surfaceHover: mixHex(surface, text, 0.12),
    border,
    borderStrong: mixHex(border, text, 0.35),
    text,
    muted: c('inactive'),
    accent,
    accentText: contrast(accent),
    accentHover: mixHex(accent, isLight ? '#000000' : '#ffffff', 0.2),
    danger: c('error'),
    success: c('success'),
    warning: c('warning'),
    info: c('permission'),
    focus: accent,
  }
}

// What the theme was last read from, shared by the two panels
// (module state: a reload reads again). `configPaths`: the Tabby config.yaml
// candidates (empty outside Tabby; undefined until looked up); `scheme`, its
// scheme as of `mtime`; `ccTheme`, Claude Code's `/config` theme.
export const themeEnv = {
  configPaths: undefined as string[] | undefined,
  checkedAt: 0,
  mtime: -1,
  scheme: undefined as TermScheme | undefined,
  ccTheme: undefined as string | undefined,
}

// How often the Tabby config and the `/config` theme are looked at again
// while a panel is up.
export const THEME_POLL_MS = 2000

// Where Tabby keeps its config.yaml: the directory Tabby names in its
// sessions' environment, else its defaults (macOS, then Linux). None outside
// Tabby (`TERM_PROGRAM`, or the variable, says so).
export const tabbyConfigPaths = (
  program: string | undefined,
  dir: string | undefined,
  home: string | undefined,
): string[] => {
  if (dir !== undefined && dir !== '') return [dir.replace(/\/$/, '') + '/config.yaml']
  if (program !== 'Tabby' || home === undefined) return []

  return [home + '/Library/Application Support/tabby/config.yaml', home + '/.config/tabby/config.yaml']
}

// Forgets what was read: each load of the plugin reads the sources again.
export const resetThemeEnv = (): void => {
  themeEnv.configPaths = undefined
  themeEnv.checkedAt = 0
  themeEnv.mtime = -1
  themeEnv.scheme = undefined
  themeEnv.ccTheme = undefined
}
