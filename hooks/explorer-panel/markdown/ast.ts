// Markdown AST produced by `parse()` (parse.ts). Plain, JSON-safe objects
// (except `ParseResult.refs`, a Map), never mutated after parse returns.
//
// Blocks carry inlines already parsed, so the layout never parses: reference
// links are resolved, footnote refs numbered (reference order), heading slugs
// assigned (GitHub rules, `-1` suffixes for duplicates).
//
// Line ranges: `startLine` / `endLine` are 1-based and inclusive, counted in
// the normalized source (CRLF/CR folded, BOM stripped; tabs expand to spaces
// but keep their line). A container's range covers its children.

/** 1-based, inclusive source line range of a block. */
export type LineRange = { startLine: number; endLine: number }

export type Align = 'left' | 'center' | 'right' | null
export type AlertKind = 'note' | 'tip' | 'important' | 'warning' | 'caution'

/** B1 ATX / B2 setext heading. `slug` is the GitHub anchor id (I14). */
export type Heading = LineRange & {
  type: 'heading'
  level: 1 | 2 | 3 | 4 | 5 | 6
  setext: boolean
  inlines: Inline[]
  slug: string
}

/** B3 paragraph; soft/hard breaks (B4) are inline nodes. */
export type Paragraph = LineRange & { type: 'paragraph'; inlines: Inline[] }

/** B6 `---` / `***` / `___`, and an HTML `<hr>` block (B20). */
export type ThematicBreak = LineRange & { type: 'thematicBreak' }

/** B7 block quote; `alert` set for a GitHub alert (B8, top-level quotes only; the `[!X]` line removed). */
export type Quote = LineRange & { type: 'quote'; alert?: AlertKind; children: Block[] }

/** B9 bullet / B10 ordered list. `marker`: the bullet char (`-*+`) or the ordered delimiter (`.` or `)`). */
export type List = LineRange & {
  type: 'list'
  ordered: boolean
  start: number // ordered: the first number; bullets: 1
  marker: string
  tight: boolean // loose lists put a blank row between items
  items: ListItem[]
}

/** One list item (B12: any blocks inside). `task` set for a task item (B11, the `[ ]` removed from the text). */
export type ListItem = LineRange & { task?: 'checked' | 'unchecked'; children: Block[] }

/**
 * B13 fenced / B14 indented code. `text` has no trailing newline; `lang` is the
 * first word of the fence's info string ('' when none). `closed` false for an unclosed fence.
 * Also B20 `<pre>` blocks (fenced false, tags stripped).
 */
export type Code = LineRange & {
  type: 'code'
  fenced: boolean
  lang: string
  text: string
  closed: boolean
}

/** B15 GFM table. Every row has exactly `align.length` cells (short rows padded, extras dropped). */
export type Table = LineRange & {
  type: 'table'
  align: Align[]
  header: Inline[][]
  rows: Inline[][][]
}

/**
 * B18/B20 HTML block. `comment` (B18 comments, `<script>`/`<style>`): draw nothing.
 * Otherwise `inlines` is the content with tags handled the I12 way (known tags
 * mapped, `<br>` a hardBreak, `<img>` an image, unknown tags dropped as `html` inlines).
 */
export type Html = LineRange & { type: 'html'; comment: boolean; raw: string; inlines: Inline[] }

/** B17 front matter at line 1 (`---` yaml or `+++` toml). `text` excludes the fences. */
export type FrontMatter = LineRange & { type: 'frontMatter'; format: 'yaml' | 'toml'; text: string }

/** B19 `<details>`: summary row + the blocks up to the matching `</details>`. */
export type Details = LineRange & { type: 'details'; summary: Inline[]; children: Block[] }

/** B21 footnote definition; in `ParseResult.footnotes` only (never in `blocks`), ordered by `n`. */
export type FootnoteDef = LineRange & { type: 'footnoteDef'; label: string; n: number; children: Block[] }

export type Block =
  | Heading
  | Paragraph
  | ThematicBreak
  | Quote
  | List
  | Code
  | Table
  | Html
  | FrontMatter
  | Details

// ---- inlines ----

export type Text = { type: 'text'; text: string }
/** I1 emph, I2 strong, I4 strike, I12 `<mark>` / `<kbd>` / `<u>`. */
export type Styled = {
  type: 'emph' | 'strong' | 'strike' | 'mark' | 'kbd' | 'underline'
  children: Inline[]
}
/** I5 code span (and `<code>`): `text` with newlines folded to spaces, one edge space stripped. */
export type CodeSpan = { type: 'code'; text: string }
/**
 * I6 inline, I7 reference, I8 autolink (`<...>` or a GFM bare URL/email,
 * children = the URL text), I12 `<a href>`. `href` as written (www. gets `http://`,
 * emails `mailto:`); `#slug` targets a heading (I14).
 */
export type Link = { type: 'link'; href: string; title: string; children: Inline[] }
/** I9 image; `alt` is plain text. */
export type Image = { type: 'image'; src: string; title: string; alt: string }
export type HardBreak = { type: 'hardBreak' }
export type SoftBreak = { type: 'softBreak' }
/** An inline HTML tag or comment with no rendering of its own: draw nothing. */
export type HtmlInline = { type: 'html'; raw: string }
/** I13 `[^label]`, numbered `n` in reference order; unresolved refs stay text. */
export type FootnoteRef = { type: 'footnoteRef'; label: string; n: number }

export type Inline =
  | Text
  | Styled
  | CodeSpan
  | Link
  | Image
  | HardBreak
  | SoftBreak
  | HtmlInline
  | FootnoteRef

/** B16 link reference definition target. */
export type LinkRef = { href: string; title: string }

export type ParseResult = {
  blocks: Block[]
  /** B16 definitions by normalized label (see `normalizeLabel`). */
  refs: Map<string, LinkRef>
  /** B21 referenced footnotes, ordered by number; unreferenced definitions are dropped. */
  footnotes: FootnoteDef[]
  /** M5: input was cut to the first 1 MiB / 20 000 lines. */
  truncated: boolean
  /** Source lines parsed (after truncation). */
  lineCount: number
}

/** CommonMark label matching: trim, collapse whitespace, case-fold. */
export function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase()
}
