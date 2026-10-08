import { expect, test } from 'claude-code/testing'

import { ansi256Hex, sessionHex } from './color'
import { DEFAULTS, keysError, mergeKeys, resolveTheme, settingsOf, withGitDefaults } from './settings'
import { THEMES } from './theme'

test('ansi256Hex covers system, cube and gray codes', () => {
  expect(ansi256Hex(9)).toBe('#ff0000')
  expect(ansi256Hex(16)).toBe('#000000')
  expect(ansi256Hex(45)).toBe('#00d7ff')
  expect(ansi256Hex(208)).toBe('#ff8700')
  expect(ansi256Hex(231)).toBe('#ffffff')
  expect(ansi256Hex(232)).toBe('#080808')
  expect(ansi256Hex(255)).toBe('#eeeeee')
  expect(sessionHex('green')).toBe('#5fff00')
  expect(sessionHex('nope')).toBe(sessionHex(''))
})

test('resolveTheme: default is claude with its own accent', () => {
  expect(resolveTheme(undefined, '')).toEqual(THEMES.claude)
  expect(resolveTheme({}, '')).toEqual(THEMES.claude)
  expect(resolveTheme({ theme: 'nord' }, '')).toEqual(THEMES.nord)
})

test('resolveTheme: a session color overrides the accent unless turned off', () => {
  const t = resolveTheme({ theme: 'nord' }, 'orange')
  expect(t.accent).toBe('#ff8700')
  expect(t.focus).toBe('#ff8700')
  expect(t.accentText).toBe('#000000')
  expect(t.accentHover).not.toBe(THEMES.nord.accentHover)
  expect(t.bg).toBe(THEMES.nord.bg)
  expect(resolveTheme({ theme: 'nord', accentFromSession: false }, 'orange')).toEqual(THEMES.nord)
})

test('resolveTheme: an unknown theme name falls back to claude', () => {
  expect(resolveTheme({ theme: 'nope' as never }, '').name).toBe('claude')
})

test('mergeKeys: preset from settings over userConfig', () => {
  expect(mergeKeys(undefined, undefined).keymap.duplicateLines).toEqual(['ctrl+d'])
  expect(mergeKeys({ editorKeymap: 'vscode' }, undefined).keymap.deleteLines).toEqual(['ctrl+shift+k'])
  expect(mergeKeys({ editorKeymap: 'vscode' }, { keymap: 'jetbrains' }).keymap.deleteLines).toEqual(['ctrl+y'])
})

test('mergeKeys: settings keys win over userConfig editorKeys', () => {
  const user = { editorKeys: '{"duplicateLines":"ctrl+shift+d","save":"ctrl+alt+s"}' }
  const m = mergeKeys(user, { keys: '{"duplicateLines":"ctrl+e"}' })
  expect(m.errors).toEqual([])
  expect(m.keymap.duplicateLines).toEqual(['ctrl+e'])
  expect(m.keymap.save.length).toBe(1)
  expect(m.keymap.save[0]).not.toBe('ctrl+s')
})

test('mergeKeys: bad entries are named by source and skipped', () => {
  const m = mergeKeys({ editorKeys: '{"nope":"ctrl+x"}' }, { keys: 'not json' })
  expect(m.errors.length).toBe(2)
  expect(m.errors[0]).toContain('editorKeys:')
  expect(m.errors[1]).toContain('settings keys:')
  expect(m.keymap.duplicateLines).toEqual(['ctrl+d'])
})

test('settingsOf keeps valid fields only', () => {
  expect(settingsOf(null)).toBeUndefined()
  expect(settingsOf([])).toBeUndefined()
  expect(settingsOf({ theme: 'dracula', gitLimit: 50, gitTab: 'nope', accentFromSession: 'yes', extra: 1 })).toEqual({
    theme: 'dracula',
    gitLimit: 50,
  })
  expect(DEFAULTS.theme).toBe('claude')
})

test('settingsOf keeps a boolean autoOpen only', () => {
  expect(settingsOf({ autoOpen: false })).toEqual({ autoOpen: false })
  expect(settingsOf({ autoOpen: 'no' })).toEqual({})
  expect(DEFAULTS.autoOpen).toBe(true)
})

test('settingsOf keeps a known layout only', () => {
  expect(settingsOf({ layout: 'split' })).toEqual({ layout: 'split' })
  expect(settingsOf({ layout: 'tabs' })).toEqual({ layout: 'tabs' })
  expect(settingsOf({ layout: 'grid' })).toEqual({})
  expect(DEFAULTS.layout).toBe('split')
})

test('keysError: none for empty or good text, the first problem otherwise', () => {
  expect(keysError('')).toBeUndefined()
  expect(keysError('{"duplicateLines":"ctrl+shift+d"}')).toBeUndefined()
  expect(keysError('{')).toMatch(/^invalid JSON/)
  expect(keysError('{"nope":"ctrl+k"}')).toBe('unknown action "nope"')
})

test('withGitDefaults: the Settings fill only what the git state lacks', () => {
  const base = { ref: 'all', offset: 0, branchOffset: 0, detailOffset: 0 }
  expect(withGitDefaults(base, undefined).limit).toBe(DEFAULTS.gitLimit)
  const filled = withGitDefaults(base, { gitTab: 'graph', changeView: 'tree', gitLimit: 50 })
  expect(filled).toMatchObject({ tab: 'graph', changeView: 'tree', limit: 50 })
  const chosen = withGitDefaults({ ...base, tab: 'overview', changeView: 'list', limit: 400 }, { gitTab: 'graph', changeView: 'tree', gitLimit: 50 })
  expect(chosen).toMatchObject({ tab: 'overview', changeView: 'list', limit: 400 })
})
