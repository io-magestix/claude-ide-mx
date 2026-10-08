import { expect, test } from 'claude-code/testing'

import { iconChoice, iconOf, iconsFor, isNerdFont } from './icons'

test('iconOf: off draws none', () => {
  expect(iconOf('main.ts', 'file', false, 'off')).toBeUndefined()
  expect(iconOf('src', 'dir', true, 'off')).toBeUndefined()
})

test('iconOf nerd: a dir open or closed, a file by name, then by extension, else the default', () => {
  expect(iconOf('src', 'dir', false, 'nerd')).toEqual({ glyph: '', role: 'accent' })
  expect(iconOf('src', 'dir', true, 'nerd')).toEqual({ glyph: '', role: 'accent' })
  expect(iconOf('main.ts', 'file', false, 'nerd')).toEqual({ glyph: '', role: 'info' })
  // the extension is matched case-blind; a whole name wins over it
  expect(iconOf('README.MD', 'file', false, 'nerd')?.glyph).toBe('')
  expect(iconOf('package.json', 'file', false, 'nerd')).toEqual({ glyph: '', role: 'danger' })
  expect(iconOf('Dockerfile', 'file', false, 'nerd')?.glyph).toBe('')
  expect(iconOf('.gitignore', 'file', false, 'nerd')?.glyph).toBe('')
  // a Material Design glyph past the BMP is one code point
  expect([...(iconOf('Main.unity', 'file', false, 'nerd')?.glyph ?? '')]).toEqual(['\u{f06af}'])
  expect(iconOf('app.bin', 'file', false, 'nerd')).toEqual({ glyph: '', role: 'muted' })
  expect(iconOf('Makefile', 'file', false, 'nerd')?.glyph).toBe('')
})

test('iconOf basic: one-cell shapes, the role telling kinds apart', () => {
  expect(iconOf('src', 'dir', false, 'basic')).toEqual({ glyph: '■', role: 'accent' })
  expect(iconOf('src', 'dir', true, 'basic')).toEqual({ glyph: '□', role: 'accent' })
  expect(iconOf('main.ts', 'file', false, 'basic')).toEqual({ glyph: '•', role: 'info' })
  expect(iconOf('app.bin', 'file', false, 'basic')).toEqual({ glyph: '•', role: 'muted' })
})

test('iconsFor: Nerd Fonts glyphs only on the terminal', () => {
  expect(iconsFor('nerd', 'terminal')).toBe('nerd')
  for (const surface of ['desktop', 'vscode', 'mobile']) expect(iconsFor('nerd', surface)).toBe('basic')
  expect(iconsFor('basic', 'terminal')).toBe('basic')
  expect(iconsFor('off', 'desktop')).toBe('off')
})

test('isNerdFont and iconChoice: the saved choice, else on for a Nerd Font', () => {
  for (const name of ['JetBrainsMono Nerd Font', 'JetBrainsMono Nerd Font Mono', 'Hack NFM', 'FiraCode NF', 'Symbols NerdFont']) {
    expect(isNerdFont(name)).toBe(true)
  }
  for (const name of ['JetBrains Mono', 'Menlo', 'Inconsolata', undefined]) expect(isNerdFont(name)).toBe(false)
  expect(iconChoice(undefined, [])).toBe('off')
  expect(iconChoice(undefined, ['Menlo', 'Symbols Nerd Font Mono'])).toBe('nerd')
  expect(iconChoice('basic', ['Hack NFM'])).toBe('basic')
  expect(iconChoice('off', ['Hack NFM'])).toBe('off')
})
