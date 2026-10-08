// Layout output (layout.ts): rows at one width, each exactly one terminal row,
// so a viewer scrolls by rows and knows the total without measuring.

/** Theme role a span is colored with (hooks/shared/theme.ts tokens); absent = `text`. */
export type Role = 'text' | 'accent' | 'muted' | 'border' | 'success' | 'warning' | 'danger'

export type SpanStyle = {
  color?: Role
  background?: 'surface' | 'warning' // code spans: surface; <mark>: warning
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  inverse?: boolean // <kbd>
  dim?: boolean
  href?: string // a link target as written (http(s), relative path, #slug, mailto:)
}

/** A run of text in one style; its width is `colsOf(text)` (shared/hscroll.ts), never wrapping. */
export type Span = { text: string; style?: SpanStyle }

/**
 * One terminal row.
 * - `text`: `spans` draw left to right; their widths sum to at most the layout width.
 * - `code`: one row of a code block, already hard-wrapped to fit; `lang` for highlighting
 *   (the same for every row of one block), `prefix` the spans drawn before it (quote bars,
 *   list indent), `block` the index of its code block (rows of one block share it), `line`
 *   the 0-based source line inside the block (a wrapped line repeats it).
 *   `table` marks a table's rows (borders and cells): a link there must not draw as a
 *   `Link` (a terminal without OSC 8 writes the URL after the label, breaking the borders).
 * - `image`: a paragraph that is only one image (I9); Preview draws it as a picture, else
 *   a `🖼 alt` row (view.ts). `prefix` as for code.
 */
export type MdRow =
  | { kind: 'text'; spans: Span[]; table?: true }
  | { kind: 'code'; prefix: Span[]; text: string; lang: string; block: number; line: number }
  | { kind: 'image'; prefix: Span[]; src: string; alt: string }

export type Layout = {
  rows: MdRow[]
  /** Heading slug (I14) → its row index. */
  anchors: Map<string, number>
  width: number
}
