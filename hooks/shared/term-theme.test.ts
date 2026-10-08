import { expect, test } from 'claude-code/testing'

import { resolveTheme, settingsOf } from './settings'
import {
  XTERM16,
  ccThemeName,
  parseTabbyScheme,
  supportedTerminal,
  tabbyConfigPaths,
  themeEnv,
  themeFromClaudeCode,
  themeFromScheme,
  themeNote,
} from './term-theme'
import type { TermScheme } from './term-theme'
import { THEMES } from './theme'
import { contrastRatio } from './ui'

const ELEMENTARY = [
  '#242424', '#d71c15', '#5aa513', '#fdb40c', '#063b8c', '#e40038', '#2595e1', '#efefef',
  '#4b4b4b', '#fc1c18', '#6bc219', '#fec80e', '#0955ff', '#fb0050', '#3ea8fc', '#8c00ec',
]
const scheme = (name: string, fg: string, bg: string, colors = ELEMENTARY, quote = "'") =>
  [
    `    name: ${name}`,
    `    foreground: ${quote}${fg}${quote}`,
    `    background: ${quote}${bg}${quote}`,
    `    cursor: ${quote}#bbbbbb${quote}`,
    '    colors:',
    ...colors.map(c => `      - ${quote}${c}${quote}`),
  ].join('\n')
// A Tabby config.yaml as Tabby writes it, its terminal section in the middle.
const config = (terminal: string, appearance = '') =>
  ['version: 7', 'profiles:', '  - name: Work', '    colorScheme: nope', 'terminal:', terminal, '  scrollbackLines: 2500', 'appearance:', appearance, 'ssh:', '  knownHosts: []'].join('\n')

test('parseTabbyScheme: the terminal colorScheme, quoted or bare', () => {
  const parsed = parseTabbyScheme(config('  colorScheme:\n' + scheme('Elementary', '#efefef', '#181818')))
  expect(parsed).toEqual({ name: 'Elementary', foreground: '#efefef', background: '#181818', colors: ELEMENTARY })
  expect(parseTabbyScheme(config('  colorScheme:\n' + scheme('Bare', '#efefef', '#181818', ELEMENTARY, '')))?.name).toBe('Bare')
  expect(parseTabbyScheme(config('  colorScheme:\n' + scheme('Double', '#efefef', '#181818', ELEMENTARY, '"')))?.background).toBe('#181818')
})

test('parseTabbyScheme: none picked, or one short of colors, is no scheme', () => {
  expect(parseTabbyScheme(config('  fontSize: 14'))).toBeUndefined()
  expect(parseTabbyScheme(config('  colorScheme:\n' + scheme('Short', '#efefef', '#181818', ELEMENTARY.slice(0, 8))))).toBeUndefined()
  expect(parseTabbyScheme('')).toBeUndefined()
})

test('parseTabbyScheme: the light scheme while colorSchemeMode is light', () => {
  const both =
    '  colorScheme:\n' + scheme('Dark', '#efefef', '#181818') + '\n  lightColorScheme:\n' + scheme('Light', '#202020', '#fafafa')
  expect(parseTabbyScheme(config(both, '  colorSchemeMode: light'))?.name).toBe('Light')
  expect(parseTabbyScheme(config(both, '  colorSchemeMode: dark'))?.name).toBe('Dark')
  expect(parseTabbyScheme(config(both))?.name).toBe('Dark')
})

const ELEMENTARY_SCHEME: TermScheme = { name: 'Elementary', foreground: '#efefef', background: '#181818', colors: ELEMENTARY }

test('themeFromScheme: its background and text, readable accents from its colors', () => {
  const t = themeFromScheme(ELEMENTARY_SCHEME)
  expect(t.bg).toBe('#181818')
  expect(t.canvas).toBe('#181818')
  expect(t.text).toBe('#efefef')
  for (const key of ['accent', 'danger', 'success', 'warning', 'info'] as const) {
    expect({ key, ok: contrastRatio(t[key], t.bg) >= 3 }).toEqual({ key, ok: true })
    expect(ELEMENTARY).toContain(t[key])
  }
  // bright blue, readable on this background
  expect(t.accent).toBe('#0955ff')
})

test('themeFromClaudeCode: the palette of the /config theme, the background left to the terminal', () => {
  const dark = themeFromClaudeCode('dark', undefined)
  expect(dark.canvas).toBeUndefined()
  expect(dark.text).toBe('#ffffff')
  expect(dark.accent).toBe('#d77757')
  expect(dark.border).toBe('#888888')
  const light = themeFromClaudeCode('light', undefined)
  expect(light.text).toBe('#000000')
  expect(light.bg).toBe('#ffffff')
  // the scheme known: its background is painted, its colors serve the ANSI themes
  const ansi = themeFromClaudeCode('dark-ansi', ELEMENTARY_SCHEME)
  expect(ansi.canvas).toBe('#181818')
  expect(ansi.accent).toBe(ELEMENTARY[9])
  expect(themeFromClaudeCode('light-ansi', undefined).text).toBe(XTERM16[0])
})

test('ccThemeName: auto by the terminal background, unknown names as dark', () => {
  expect(ccThemeName('auto', undefined)).toBe('dark')
  expect(ccThemeName('auto', { ...ELEMENTARY_SCHEME, background: '#fafafa' })).toBe('light')
  expect(ccThemeName('light-daltonized', undefined)).toBe('light-daltonized')
  expect(ccThemeName('solarized', undefined)).toBe('dark')
  expect(ccThemeName(undefined, undefined)).toBe('dark')
})

test('tabbyConfigPaths: the directory Tabby names, its defaults, none outside Tabby', () => {
  expect(tabbyConfigPaths(undefined, '/cfg/tabby/', '/home/u')).toEqual(['/cfg/tabby/config.yaml'])
  expect(tabbyConfigPaths('Tabby', undefined, '/home/u')).toEqual([
    '/home/u/Library/Application Support/tabby/config.yaml',
    '/home/u/.config/tabby/config.yaml',
  ])
  expect(tabbyConfigPaths('iTerm.app', undefined, '/home/u')).toEqual([])
})

test('supportedTerminal: Tabby when its config is found, else none', () => {
  expect(supportedTerminal({ ...themeEnv, configPaths: ['/c.yaml'] })).toBe('Tabby')
  expect(supportedTerminal({ ...themeEnv, configPaths: [] })).toBeUndefined()
  expect(supportedTerminal({ ...themeEnv, configPaths: undefined })).toBeUndefined()
})

test('themeNote: what an outside theme follows, or why it draws as the default', () => {
  const env = (patch: Partial<typeof themeEnv>) => ({ ...themeEnv, configPaths: [] as string[], scheme: undefined, ccTheme: undefined, ...patch })
  expect(themeNote('claude', env({}))).toBeUndefined()
  expect(themeNote('terminal', env({}))).toBe('this terminal is not supported: drawn as default')
  expect(themeNote('terminal', env({ configPaths: ['/c.yaml'] }))).toContain('no Tabby color scheme')
  expect(themeNote('terminal', env({ configPaths: ['/c.yaml'], scheme: ELEMENTARY_SCHEME }))).toBe('Tabby: Elementary')
  expect(themeNote('claude-code', env({ ccTheme: 'light' }))).toBe('follows /theme: light')
})

test('settings: theme takes its three sources; resolveTheme draws each, else claude', () => {
  expect(settingsOf({ theme: 'terminal' })).toEqual({ theme: 'terminal' })
  expect(settingsOf({ theme: 'nord' })).toEqual({})
  expect(resolveTheme({ theme: 'terminal' }, '')).toEqual(THEMES.claude)
  expect(resolveTheme({ theme: 'terminal' }, '', { scheme: ELEMENTARY_SCHEME }).bg).toBe('#181818')
  expect(resolveTheme({ theme: 'claude-code' }, '', { ccTheme: 'light' }).text).toBe('#000000')
  expect(resolveTheme({}, '', { scheme: ELEMENTARY_SCHEME })).toEqual(THEMES.claude)
})
