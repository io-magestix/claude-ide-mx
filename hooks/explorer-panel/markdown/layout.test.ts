import { expect, test } from 'claude-code/testing'
import { FIXTURES } from './fixtures'
import { fitColumns, layout, plainRow, rowWidth } from './layout'
import { parse } from './parse'
import type { Layout, MdRow, Span } from './rows'
import { wrap } from './wrap'

const lay = (md: string, w: number): Layout => layout(parse(md), w)
const lines = (md: string, w: number): string[] => lay(md, w).rows.map((r) => plainRow(r).trimEnd())
const textRow = (r: MdRow | undefined): Span[] => (r && r.kind === 'text' ? r.spans : [])
const find = (L: Layout, text: string): Span | undefined => {
  for (const r of L.rows) for (const s of textRow(r)) if (s.text.includes(text)) return s
  return undefined
}

// ---- invariants over every fixture ----

for (const f of FIXTURES) {
  test(`invariant: ${f.name} rows fit at 30/40/60/80 and never wrap`, () => {
    const r = parse(f.text)
    for (const w of [30, 40, 60, 80]) {
      const L = layout(r, w)
      expect(L.width).toBe(w)
      let worst = 0
      for (const row of L.rows) worst = Math.max(worst, rowWidth(row))
      expect(worst).toBeLessThanOrEqual(w)
      for (const [, i] of L.anchors) expect(i).toBeLessThan(L.rows.length)
    }
  })
}

test('tiny and odd widths clamp to 8 and stay within it', () => {
  const r = parse(FIXTURES.map((f) => f.text).join('\n\n'))
  for (const w of [0, -5, 1, 3, 7, 8, 9, Number.NaN]) {
    const L = layout(r, w)
    expect(L.width).toBe(Math.max(8, Number.isFinite(w) ? w : 8))
    let worst = 0
    for (const row of L.rows) worst = Math.max(worst, rowWidth(row))
    expect(worst).toBeLessThanOrEqual(L.width)
  }
})

test('deep nesting past the width stops indenting instead of overflowing', () => {
  const md = '> '.repeat(12) + 'deep quote text\n\n' + Array.from({ length: 10 }, (_, i) => '  '.repeat(i) + '- level').join('\n')
  for (const w of [8, 10, 20]) for (const row of lay(md, w).rows) expect(rowWidth(row)).toBeLessThanOrEqual(w)
})

// ---- B1/B2 headings ----

test('B1 headings: styles, h1 ═ and h2 ─ rules, anchors', () => {
  const L = lay('# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six\n\nSetext\n======', 40)
  expect(L.rows.map((r) => plainRow(r))).toEqual([
    'One', '═'.repeat(40), '', 'Two', '─'.repeat(40), '', 'Three', '', 'Four', '', 'Five', '', 'Six', '',
    'Setext', '═'.repeat(40),
  ])
  expect(textRow(L.rows[0])[0]!.style).toEqual({ bold: true, color: 'accent' })
  expect(textRow(L.rows[1])[0]!.style).toEqual({ color: 'border' })
  expect(textRow(L.rows[6])[0]!.style).toEqual({ bold: true, color: 'accent' })
  expect(textRow(L.rows[8])[0]!.style).toEqual({ bold: true })
  expect(textRow(L.rows[10])[0]!.style).toEqual({ bold: true, color: 'muted' })
  expect(textRow(L.rows[12])[0]!.style).toEqual({ italic: true, color: 'muted' })
  expect(L.anchors.get('one')).toBe(0)
  expect(L.anchors.get('two')).toBe(3)
  expect(L.anchors.get('six')).toBe(12)
  expect(L.anchors.get('setext')).toBe(14)
})

test('I14 anchors: duplicates get -1, nested headings count container rows', () => {
  const L = lay('# Intro\n\npara\n\n> ## Inside quote\n\n# Intro', 40)
  expect(L.anchors.get('intro')).toBe(0)
  expect(L.anchors.get('inside-quote')).toBe(5)
  expect(plainRow(L.rows[5]!)).toBe('▎ Inside quote')
  expect(L.anchors.get('intro-1')).toBe(8)
})

// ---- B3/B4/B5 paragraphs ----

test('B3 paragraphs wrap at spaces; soft breaks join; long words break by column', () => {
  expect(lines('alpha beta gamma delta epsilon zeta eta theta', 20)).toEqual(['alpha beta gamma', 'delta epsilon zeta', 'eta theta'])
  expect(lines('one\ntwo', 40)).toEqual(['one two'])
  expect(lines('x abcdefghijklmnopqrstuvwxyz y', 10)).toEqual(['x', 'abcdefghij', 'klmnopqrst', 'uvwxyz y'])
})

test('M1/M3 CJK wraps by columns at width 10 (clamped minimum 8 untouched)', () => {
  const rows = lines('日本語の文章は二列ずつ数えます', 10)
  expect(rows).toEqual(['日本語の文', '章は二列ず', 'つ数えます'])
  // a wide char that does not fit the row's last column moves down
  expect(lines('a日本語の文章', 10)).toEqual(['a日本語の', '文章'])
})

test('M3 spans keep their style across a wrap', () => {
  const L = lay('**bold words that wrap around**', 12)
  expect(L.rows.map((r) => plainRow(r))).toEqual(['bold words', 'that wrap', 'around'])
  for (const r of L.rows) for (const s of textRow(r)) expect(s.style?.bold).toBe(true)
})

test('B4 hard breaks make rows; B5 one blank row between blocks', () => {
  expect(lines('a  \nb\\\nc', 40)).toEqual(['a', 'b', 'c'])
  expect(lines('one\n\n\n\n\ntwo', 40)).toEqual(['one', '', 'two'])
})

test('space runs collapse (a removed inline comment leaves one space)', () => {
  expect(lines('a <!-- c --> b', 40)).toEqual(['a b'])
})

// ---- B6 / B7 / B8 ----

test('B6 thematic break is a full-width ─ in border', () => {
  const L = lay('---', 30)
  expect(plainRow(L.rows[0]!)).toBe('─'.repeat(30))
  expect(textRow(L.rows[0])[0]!.style).toEqual({ color: 'border' })
})

test('B7 quotes: ▎ per depth, muted, content at width − 2·depth', () => {
  const L = lay('> outer\n>> inner words wrap here', 20)
  expect(L.rows.map((r) => plainRow(r))).toEqual(['▎ outer', '▎', '▎ ▎ inner words wrap', '▎ ▎ here'])
  expect(textRow(L.rows[0])[0]).toEqual({ text: '▎ ', style: { color: 'muted' } })
})

test('B8 alerts: title row with icon in its color, bar in that color', () => {
  const cases: [string, string, string][] = [
    ['NOTE', 'ℹ Note', 'accent'],
    ['TIP', '💡 Tip', 'success'],
    ['IMPORTANT', '❗ Important', 'accent'],
    ['WARNING', '⚠ Warning', 'warning'],
    ['CAUTION', '⛔ Caution', 'danger'],
  ]
  for (const [kind, title, color] of cases) {
    const L = lay(`> [!${kind}]\n> body`, 40)
    expect(L.rows.map((r) => plainRow(r))).toEqual([`▎ ${title}`, '▎ body'])
    const [bar, t] = textRow(L.rows[0])
    expect(bar!.style).toEqual({ color })
    expect(t!.style).toEqual({ bold: true, color })
  }
})

// ---- B9–B12 lists ----

test('B9 bullets cycle • ◦ ▪ and hang under the first column; tight vs loose', () => {
  expect(lines('- a\n  - b\n    - c\n      - d', 40)).toEqual(['• a', '  ◦ b', '    ▪ c', '      • d'])
  expect(lines('- a\n\n- b', 40)).toEqual(['• a', '', '• b'])
  expect(lines('- one two three four five six', 14)).toEqual(['• one two', '  three four', '  five six'])
})

test('B10 ordered numbers right-aligned to the widest marker', () => {
  expect(lines('9. nine\n10. ten\n11. eleven words here', 16)).toEqual([' 9. nine', '10. ten', '11. eleven words', '    here'])
  expect(lines('3) x\n4) y', 40)).toEqual(['3) x', '4) y'])
})

test('B11 tasks: ☐ muted / ☑ success, checked text muted', () => {
  const L = lay('- [ ] open\n- [x] done', 40)
  expect(L.rows.map((r) => plainRow(r))).toEqual(['☐ open', '☑ done'])
  expect(textRow(L.rows[0])[0]).toEqual({ text: '☐ ', style: { color: 'muted' } })
  expect(textRow(L.rows[1])[0]).toEqual({ text: '☑ ', style: { color: 'success' } })
  expect(textRow(L.rows[1])[1]!.style).toEqual({ color: 'muted' })
  expect(textRow(L.rows[0])[1]!.style).toBe(undefined)
})

test('B12 a 3-level nested list with a quote inside', () => {
  const md = '1. one\n   - two\n     1. three\n        > a quote inside\n        > that wraps at width\n   - back'
  expect(lines(md, 30)).toEqual([
    '1. one',
    '   ◦ two',
    '     1. three',
    '        ▎ a quote inside that',
    '        ▎ wraps at width',
    '   ◦ back',
  ])
})

test('B12 multi-block loose item: paragraphs and code at the content column', () => {
  expect(lines('- para\n\n  second\n\n  ```js\n  x\n  ```', 20)).toEqual(['• para', '', '  second', '', '                  js', '  x'])
})

// ---- B13 / B14 / B17 code ----

test('B13 fenced code: dim label row right-aligned, hard-wrapped rows by column', () => {
  const L = lay('```ts\nconst abcdefghijklmnop = 1\n\nz\n```', 12)
  expect(L.rows.map((r) => plainRow(r))).toEqual(['          ts', 'const abcdef', 'ghijklmnop =', ' 1', '', 'z'])
  expect(textRow(L.rows[0])[1]).toEqual({ text: 'ts', style: { color: 'muted', dim: true } })
  const code = L.rows.slice(1).filter((r) => r.kind === 'code')
  expect(code.map((r) => (r.kind === 'code' ? [r.lang, r.block, r.line] : []))).toEqual([
    ['ts', 0, 0], ['ts', 0, 0], ['ts', 0, 0], ['ts', 0, 1], ['ts', 0, 2],
  ])
})

test('B14 indented code has no label row; code blocks number in order', () => {
  const L = lay('para\n\n    one\n    two\n\n```\nthree\n```', 40)
  expect(L.rows.map((r) => plainRow(r))).toEqual(['para', '', 'one', 'two', '', 'three'])
  expect(L.rows.map((r) => (r.kind === 'code' ? r.block : -1))).toEqual([-1, -1, 0, 0, -1, 1])
})

test('B17 front matter: yaml code with a dim front matter label', () => {
  const L = lay('---\na: 1\n---\n\n# T', 30)
  expect(L.rows.map((r) => plainRow(r))).toEqual([' '.repeat(18) + 'front matter', 'a: 1', '', 'T', '═'.repeat(30)])
  expect(L.rows[1]!.kind === 'code' && L.rows[1]!.lang).toBe('yaml')
})

test('code inside a quote carries the bar as prefix', () => {
  const L = lay('> ```\n> x\n> ```', 20)
  const r = L.rows[0]!
  expect(r.kind).toBe('code')
  expect(r.kind === 'code' ? r.prefix.map((s) => s.text).join('') : '').toBe('▎ ')
})

// ---- B15 tables ----

test('B15 table: box-drawn, header bold, alignment', () => {
  const L = lay('| L | C | R |\n|:--|:-:|--:|\n| a | bb | c |', 40)
  expect(L.rows.map((r) => plainRow(r))).toEqual([
    '┌───┬────┬───┐',
    '│ L │ C  │ R │',
    '├───┼────┼───┤',
    '│ a │ bb │ c │',
    '└───┴────┴───┘',
  ])
  expect(find(L, 'L')!.style).toEqual({ bold: true })
  expect(find(L, '┌')!.style).toEqual({ color: 'border' })
})

test('B15 table shrinks at width 30, cells wrap, row height = tallest cell', () => {
  const md = '| Column one header | Column two header | Three |\n|---|---|---|\n| a long cell that wraps | short | z |\n| x | y | w |'
  const rows = lines(md, 30)
  for (const r of rows) expect(r.length <= 30).toBe(true)
  expect(rows[0]!.startsWith('┌')).toBe(true)
  expect(rows[rows.length - 1]!.startsWith('└')).toBe(true)
  // every row draws the same column seams
  const seams = (s: string): number[] => [...s].flatMap((c, i) => ('│┌┐┬┼├┤└┴┘'.includes(c) ? [i] : []))
  for (const r of rows) expect(seams(r)).toEqual(seams(rows[0]!))
  // tall rows get a rule between them; the first body row is taller than 1
  expect(rows.filter((r) => r.startsWith('├')).length).toBe(2)
  expect(rows.length).toBeGreaterThan(7)
})

test('fitColumns: natural when it fits, proportional with minimums otherwise', () => {
  expect(fitColumns([3, 4], 10, 3)).toEqual([3, 4])
  const ws = fitColumns([40, 10, 2], 20, 3)
  expect(ws.reduce((a, b) => a + b, 0)).toBe(20)
  expect(ws[2]).toBe(2)
  expect(ws[0]! > ws[1]!).toBe(true)
  expect(fitColumns([10, 10], 12, 3, [5, 6])).toEqual([6, 6])
})

test('B15 too many columns for the width: cells joined by │, still in width', () => {
  const md = '| a | b | c | d | e |\n|---|---|---|---|---|\n| 1 | 2 | 3 | 4 | 5 |'
  for (const r of lay(md, 8).rows) expect(rowWidth(r)).toBeLessThanOrEqual(8)
})

// ---- inlines ----

test('I5 code span accent on surface, unbreakable; I6 links underline accent href', () => {
  const L = lay('see `a b c` and [link](https://x.y)', 40)
  expect(find(L, 'a b c')!.style).toEqual({ color: 'accent', background: 'surface' })
  expect(find(L, 'link')!.style).toEqual({ underline: true, color: 'accent', href: 'https://x.y' })
  expect(lines('aaaa `x y z` b', 8)).toEqual(['aaaa', 'x y z b'])
})

test('I4 strike muted, I12 kbd inverse with spaces, mark warning background', () => {
  const L = lay('~~gone~~ <kbd>Ctrl</kbd> <mark>hi</mark>', 40)
  expect(find(L, 'gone')!.style).toEqual({ strike: true, color: 'muted' })
  expect(find(L, ' Ctrl ')!.style).toEqual({ inverse: true })
  expect(find(L, 'hi')!.style).toEqual({ background: 'warning' })
})

test('I9 images: inline placeholder muted with dim title; a lone image is an image row', () => {
  const L = lay('text ![alt](a.png "T") more\n\n![solo](b.png "t2")', 40)
  expect(plainRow(L.rows[0]!)).toBe('text 🖼 alt T more')
  expect(find(L, 'T')!.style).toEqual({ color: 'muted', dim: true })
  expect(L.rows[2]).toEqual({ kind: 'image', prefix: [], src: 'b.png', alt: 'solo' })
})

// ---- B19 / B20 / B21 ----

test('B19 details: ▸ summary bold, content indented 2', () => {
  expect(lines('<details>\n<summary>Sum</summary>\n\nBody text\n\n</details>', 40)).toEqual(['▸ Sum', '  Body text'])
})

test('B18 comments draw nothing and add no blank rows', () => {
  expect(lines('a\n\n<!-- hidden -->\n\nb', 40)).toEqual(['a', '', 'b'])
})

test('B21 footnotes at the end under a rule; I13 refs [n] accent', () => {
  const L = lay('Text[^a] and[^b].\n\n[^b]: Second note.\n[^a]: First note.', 30)
  expect(L.rows.map((r) => plainRow(r).trimEnd())).toEqual(['Text[1] and[2].', '', '─'.repeat(30), '[1] First note.', '[2] Second note.'])
  expect(find(L, '[1]')!.style).toEqual({ color: 'accent' })
})

test('M5 truncated parse ends with a muted row', () => {
  const r = { ...parse('x'), truncated: true, lineCount: 20000 }
  const L = layout(r, 40)
  expect(plainRow(L.rows[L.rows.length - 1]!)).toBe('… truncated (first 20000 lines)')
  expect(textRow(L.rows[L.rows.length - 1])[0]!.style).toEqual({ color: 'muted' })
})

test('empty input lays out to no rows', () => {
  expect(lay('', 40).rows).toEqual([])
})

test('wrap: an empty piece list gives no rows; hard breaks keep empty rows', () => {
  expect(wrap([], 10)).toEqual([])
  expect(wrap([{ text: 'a' }, null, null, { text: 'b' }], 10).map((r) => r.map((s) => s.text).join(''))).toEqual(['a', '', 'b'])
})

// ---- performance ----

test('performance: stress.md under 50 ms, 1 MiB under ~1 s', () => {
  const stress = FIXTURES.find((f) => f.name === 'stress')!.text
  const r = parse(stress)
  layout(r, 80)
  let t0 = Date.now()
  layout(r, 80)
  expect(Date.now() - t0).toBeLessThan(50)
  const big = parse(stress.repeat(Math.ceil((1024 * 1024) / stress.length)))
  t0 = Date.now()
  const L = layout(big, 80)
  expect(Date.now() - t0).toBeLessThan(1000)
  expect(L.rows.length).toBeGreaterThan(1000)
})

test('tabs: an entity tab is white space in text, never a 0-column cell', () => {
  // the parser expands source tabs (M4); `&#9;` decodes to one after it
  const L = lay('a&#9;b  `c\td` x ![i&#9;j](p.png)', 40)
  for (const row of L.rows) for (const s of textRow(row)) expect(s.text.includes('\t')).toBe(false)
  expect(lines('a&#9;b  `c\td`', 40)[0]).toMatch(/^a b c +d$/)
  const wide = lay('x&#9;&#9;y ' + 'w '.repeat(30), 20)
  for (const row of wide.rows) expect(rowWidth(row)).toBeLessThanOrEqual(20)
})
