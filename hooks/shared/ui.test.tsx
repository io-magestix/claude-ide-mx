import { expect, test } from 'claude-code/testing'

import { themeFromClaudeCode } from './term-theme'
import { Alert as A_, Avatar as Av_, Badge as Ba_, Btn as B, Card as C_, Progress as P_, Tabs as T_, barString, contrast, contrastRatio, initials, onDefaultFg } from './ui'

// The panels' theme in the tests: Claude Code's dark theme, no terminal scheme.
const DARK = themeFromClaudeCode('dark', undefined)

// The elements are plain constructors: calling one returns its frozen element.
const mk = (type: string) => (props: Record<string, unknown>) => ({ type, props })
const el: any = { Box: mk('Box'), Text: mk('Text'), Button: mk('Button') }
const t = DARK
const Alert: any = A_, Avatar: any = Av_, Badge: any = Ba_, Card: any = C_, Progress: any = P_, Tabs: any = T_
const txt = (x: any): string => [x.props.children].flat(9).join('')
// The library returns RenderElement; the mock elements are plain {type, props}.
const Btn: (...a: Parameters<typeof B>) => any = B as any

const walk = (n: any, out: any[] = []): any[] => {
  if (n === null || typeof n !== 'object') return out
  out.push(n)
  const c = n.props?.children
  for (const x of Array.isArray(c) ? c.flat(9) : [c]) walk(x, out)

  return out
}
const find = (n: any, pred: (x: any) => boolean) => walk(n).find(pred)

test('onDefaultFg darkens until the default foreground reads (>= 4.5)', () => {
  for (const hex of ['#ffffff', '#88c0d0', '#d97757', '#fafafa', '#f5a524']) {
    const out = onDefaultFg(hex)
    expect(contrastRatio(out, '#e6e6e6') >= 4.5).toBe(true)
  }
  expect(onDefaultFg('#000000')).toBe('#000000')
})

test('pure helpers', () => {
  expect(barString(0.5, 8)).toBe('████    ')
  expect(barString(0.5625, 8)).toBe('████▌   ')
  expect(barString(0, 4)).toBe('    ')
  expect(barString(2, 4)).toBe('████')
  expect(initials('ada lovelace')).toBe('AL')
  expect(initials('Linus')).toBe('LI')
  expect(contrast('#ffffff')).toBe('#000000')
  expect(contrast('#000000')).toBe('#ffffff')
})

test('Btn terminal: keyed chrome around a plain Button, hover set', () => {
  const press = () => {}
  const tree = Btn(el, t, { key: 'go', label: 'Go', variant: 'primary', onPress: press })
  expect(tree.props.key).toBe('go:chrome')
  expect(tree.props.backgroundColor).toBe(onDefaultFg(t.accent))
  expect(tree.props.borderStyle).toBe('round')
  expect(tree.props.hover.backgroundColor).toBe(onDefaultFg(t.accentHover))
  const button = find(tree, x => x.type === 'Button')
  expect(button.props.key).toBe('go')
  expect(button.props.plain).toBe(true)
  expect(button.props.label).toBe('Go')
  expect(button.props.onPress).toBe(press)
})

test('Btn variants: outline has a border and no fill, ghost neither, sm drops the border', () => {
  const o = Btn(el, t, { key: 'o', label: 'O', variant: 'outline', onPress: () => {} })
  expect(o.props.backgroundColor).toBeUndefined()
  expect(o.props.borderColor).toBe(t.borderStrong)
  const g = Btn(el, t, { key: 'g', label: 'G', variant: 'ghost', onPress: () => {} })
  expect(g.props.borderStyle).toBeUndefined()
  const s = Btn(el, t, { key: 's', label: 'S', variant: 'secondary', size: 'sm', onPress: () => {} })
  expect(s.props.borderStyle).toBeUndefined()
  const d = Btn(el, t, { key: 'd', label: 'D', variant: 'danger', onPress: () => {} })
  expect(d.props.backgroundColor).toBe(onDefaultFg(t.danger))
})

test('Btn pill draws half-block caps', () => {
  const tree = Btn(el, t, { key: 'p', label: 'P', variant: 'primary', pill: true, onPress: () => {} })
  const caps = walk(tree).filter(x => x.type === 'Text' && (txt(x) === '▐' || txt(x) === '▌'))
  expect(caps.length).toBe(2)
})

test('Btn desktop falls back to the native Button', () => {
  const tree = Btn(el, t, { key: 'n', label: 'N', variant: 'primary', surface: 'desktop', onPress: () => {} })
  expect(tree.type).toBe('Button')
  expect(tree.props.variant).toBe('primary')
  expect(tree.props.label).toBe('N')
})

test('Card puts the title in an absolute Box after the bordered one', () => {
  const tree = Card(el, t, { title: 'Hello', children: null })
  const [bordered, title] = tree.props.children
  expect(bordered.props.borderStyle).toBe('round')
  expect(title.props.position).toBe('absolute')
  expect(title.props.top).toBe(0)
})

test('Badge, Alert, Progress, Avatar', () => {
  expect(walk(Badge(el, t, { label: 'x', variant: 'destructive' })).some(x => x.props.backgroundColor === t.danger)).toBe(true)
  const a = Alert(el, t, { tone: 'warning', title: 'W' })
  expect(a.props.children[0].props.backgroundColor).toBe(t.warning)
  const p = Progress(el, t, { value: 0.5, width: 10 })
  expect(walk(p).some(x => txt(x) === '█████     ')).toBe(true)
  expect(walk(Avatar(el, t, { name: 'Ada Lovelace' })).some(x => txt(x) === 'AL')).toBe(true)
})

test('Tabs: one Button per tab keyed tab:<id>, press selects', () => {
  const seen: string[] = []
  const tabs = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]
  for (const style of ['underline', 'pill'] as const) {
    const tree = Tabs(el, t, { tabs, selected: 'a', style, onSelect: (id: string) => seen.push(id) })
    const b = find(tree, x => x.type === 'Button' && x.props.key === 'tab:b')
    b.props.onPress()
  }
  expect(seen).toEqual(['b', 'b'])
})

import { Checkbox as Cb_, Field as Fi_, RadioGroup as Rg_, Switch as Sw_ } from './ui'

test('Field frame: danger on error, accent when valid, error replaces helper', () => {
  const Field: any = Fi_
  const bad = Field(el, t, { label: 'Email', helper: 'help', error: 'bad' })
  expect(find(bad, x => x.props.borderStyle === 'round').props.borderColor).toBe(t.danger)
  expect(find(bad, x => x.type === 'Text' && txt(x) === '✕ bad')).toBeDefined()
  expect(find(bad, x => x.type === 'Text' && txt(x) === 'help')).toBeUndefined()
  const good = Field(el, t, { label: 'Email', valid: true })
  expect(find(good, x => x.props.borderStyle === 'round').props.borderColor).toBe(t.accent)
})

test('Checkbox, RadioGroup, Switch glyphs and keys', () => {
  const Checkbox: any = Cb_, RadioGroup: any = Rg_, Switch: any = Sw_
  const cb = Checkbox(el, t, { key: 'c', label: 'x', checked: true, onChange: () => {} })
  expect(find(cb, x => x.type === 'Text' && txt(x) === '☑').props.color).toBe(t.accent)
  expect(find(cb, x => x.type === 'Button').props.key).toBe('c')
  expect(find(cb, x => x.type === 'Button').props.label).toBe(' x')
  const rg = RadioGroup(el, t, { key: 'r', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], value: 'b', onChange: () => {} })
  expect(find(rg, x => x.type === 'Text' && txt(x) === '◉')).toBeDefined()
  expect(find(rg, x => x.type === 'Button' && x.props.label === ' B')).toBeDefined()
  expect(find(rg, x => x.type === 'Button' && x.props.key === 'r:a')).toBeDefined()
  // a disabled option: muted text, no Button
  const off = RadioGroup(el, t, { key: 'r', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B', disabled: true }], value: 'a', onChange: () => {} })
  expect(find(off, x => x.type === 'Button' && x.props.key === 'r:b')).toBeUndefined()
  expect(find(off, x => x.type === 'Text' && txt(x) === '○ B').props.color).toBe(t.muted)
  expect(find(off, x => x.type === 'Button' && x.props.key === 'r:a')).toBeDefined()
  const sw = Switch(el, t, { key: 's', label: 'n', on: true, onChange: () => {} })
  expect(find(sw, x => x.type === 'Text' && txt(x) === '━━●').props.color).toBe(t.accent)
  expect(find(sw, x => x.type === 'Button').props.label).toBe(' n')
})
