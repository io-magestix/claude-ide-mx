// Horizontal scrolling of text sections: `Code` and `Text` have no column
// offset, so each line is cut at column `left` before it is drawn.
//
// Columns are counted the way the engine paints them (probed live on 2.1.289):
// - Tabs. `Code` turns each tab of a line's leading run into 2 spaces and every
//   other tab into spaces up to the next multiple of 8 columns from the line's
//   start (under `format: 'diff'`, from just after the ` `/`+`/`-` marker).
//   `Text` instead expands a tab to the terminal's absolute tab stops, which
//   depends on where the pane sits. So every helper here first expands tabs by
//   `Code`'s rule (`expandTabs`) and returns tab-free text: `Code` draws it
//   exactly as it would the raw line, and `Text` no longer shifts with the pane.
// - Wide chars. The engine paints East Asian wide/fullwidth chars and emoji 2
//   columns wide, and combining marks / zero-width chars 0, so `widthOf` does
//   too (a range table, not full Unicode: ZWJ emoji sequences count per code
//   point). Strings are walked by code point, so a surrogate pair is never
//   split; a wide char cut in half by `left` leaves a space for its right half,
//   keeping the columns after it in place.

const LEAD_TAB = 2
const TAB_STOP = 8

const ZERO: readonly (readonly [number, number])[] = [
  [0x0300, 0x036f], // combining diacritics
  [0x0483, 0x0489],
  [0x0591, 0x05bd],
  [0x0610, 0x061a],
  [0x064b, 0x065f],
  [0x0e31, 0x0e31],
  [0x0e34, 0x0e3a],
  [0x0e47, 0x0e4e],
  [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff],
  [0x200b, 0x200f], // zero-width space, joiners, marks
  [0x2028, 0x202e],
  [0x2060, 0x2064],
  [0x20d0, 0x20ff],
  [0xfe00, 0xfe0f], // variation selectors
  [0xfe20, 0xfe2f],
  [0xfeff, 0xfeff],
  [0x1f3fb, 0x1f3ff], // skin tone modifiers
  [0xe0000, 0xe0fff], // tags, variation selectors supplement
]

const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e], // CJK radicals, punctuation
  [0x3041, 0x33ff], // kana, CJK compatibility
  [0x3400, 0x4dbf], // CJK extension A
  [0x4e00, 0x9fff], // CJK unified
  [0xa000, 0xa4cf], // Yi
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60], // fullwidth forms
  [0xffe0, 0xffe6],
  [0x16fe0, 0x18cff], // Tangut, Khitan
  [0x1b000, 0x1b2ff], // kana supplement
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f200, 0x1f2ff],
  [0x1f300, 0x1f64f], // pictographs, emoticons
  [0x1f680, 0x1f6ff], // transport
  [0x1f7e0, 0x1f7eb],
  [0x1f90c, 0x1f9ff], // supplemental symbols
  [0x1fa70, 0x1faff],
  [0x20000, 0x3fffd], // CJK extensions B and on
]

const inRanges = (cp: number, ranges: readonly (readonly [number, number])[]): boolean => {
  let lo = 0
  let hi = ranges.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const [from, to] = ranges[mid]!
    if (cp < from) hi = mid - 1
    else if (cp > to) lo = mid + 1
    else return true
  }

  return false
}

// Columns one code point takes on screen (0, 1 or 2).
export const widthOf = (cp: number): 0 | 1 | 2 => {
  if (cp < 0x300) return cp < 0x20 || (cp >= 0x7f && cp < 0xa0) ? 0 : 1
  if (inRanges(cp, ZERO)) return 0

  return inRanges(cp, WIDE) ? 2 : 1
}

// The line with its tabs turned into spaces as `Code` draws them: each tab of
// the leading run is 2 spaces, any other reaches the next multiple of 8 columns.
export const expandTabs = (line: string): string => {
  if (!line.includes('\t')) return line
  let out = ''
  let col = 0
  let isLead = true
  for (const ch of line) {
    if (ch === '\t') {
      const n = isLead ? LEAD_TAB : TAB_STOP - (col % TAB_STOP)
      out += ' '.repeat(n)
      col += n
      continue
    }
    isLead = false
    out += ch
    col += widthOf(ch.codePointAt(0)!)
  }

  return out
}

// Columns of `text`, no tab expansion (printable ASCII takes the fast path).
export const colsOf = (text: string): number => {
  let n = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c >= 0x20 && c < 0x7f) {
      n++
      continue
    }
    const cp = text.codePointAt(i)!
    if (cp > 0xffff) i++
    n += widthOf(cp)
  }

  return n
}

// Columns of the widest line, tabs expanded.
export const widest = (lines: readonly string[]): number => {
  let most = 0
  for (const line of lines) most = Math.max(most, colsOf(expandTabs(line)))

  return most
}

// The line, tabs expanded, with its first `left` columns dropped: '' past its
// end. A `left` of 0 or less drops nothing.
export const sliceCols = (line: string, left: number): string => {
  const text = expandTabs(line)
  const from = Number.isFinite(left) ? Math.floor(left) : 0
  if (from <= 0) return text
  let out = ''
  let col = 0
  let isDropped = false
  for (const ch of text) {
    const w = widthOf(ch.codePointAt(0)!)
    if (w === 0) {
      // a combining mark goes with the char before it
      if (!isDropped && col >= from) out += ch
      continue
    }
    if (col >= from) {
      out += ch
      isDropped = false
    } else {
      // a wide char cut in half leaves its right half as a space
      if (col + w > from) out += ' '.repeat(col + w - from)
      isDropped = true
    }
    col += w
  }

  return out
}

const HUNK = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/

// A unified diff with each hunk body line's content cut at column `left`; its
// ` `/`+`/`-` marker stays. Hunk headers, `\ No newline` and the file header
// lines (`diff`, `index`, `---`, `+++`, ...) are left as they are, so the hunks
// still parse. As `parseDiff` in `git-panel/git.ts` does, body lines are told
// by the header's counts, so a removed `--- x` inside a hunk is a body line.
export const sliceDiffCols = (patch: string, left: number): string => {
  let old = 0
  let next = 0

  return patch
    .split('\n')
    .map(line => {
      if (old > 0 || next > 0) {
        if (!HUNK.test(line)) {
          const marker = line[0]
          if (marker === '-') old--
          else if (marker === '+') next--
          else if (marker === ' ') {
            old--
            next--
          } else return line

          return marker + sliceCols(line.slice(1), left)
        }
      }
      const match = HUNK.exec(line)
      if (match !== null) {
        old = match[1] === undefined ? 1 : Number(match[1])
        next = match[2] === undefined ? 1 : Number(match[2])
      }

      return line
    })
    .join('\n')
}
